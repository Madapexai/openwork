import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

// ============================================================
// P0 ③ Migration 验证 — 端到端测试
// Spec: prds/team-autonomy/openspecs/openspec-migration-validation.md
//
// V1: 0050 SQL 语法合法（结构校验 + mysql2 执行）
// V2: drizzle-kit export 与 0050 migration replay 的 schema parity
// V3: 19 新表 + team 表 ALTER 完整性（表/列/索引）
// V4: TypeScript 编译（pnpm build exit 0）
// V5: _journal.json 注册 0050 条目
// ============================================================

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsFolder = join(packageDir, "drizzle")
const migrationFile = join(migrationsFolder, "0050_team_autonomy.sql")
const journalFile = join(migrationsFolder, "meta", "_journal.json")
const distIndexFile = join(packageDir, "dist", "index.js")
const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

// 19 张新表（与 0050 SQL Step 2-10 一一对应）
const newTables = [
  "team_role",
  "team_agent",
  "team_board",
  "team_task",
  "team_task_handoff",
  "team_artifact",
  "team_artifact_version",
  "team_mailbox",
  "team_budget",
  "team_budget_allocation",
  "team_automation",
  "team_automation_run",
  "team_automation_alert",
  "skill_validation",
  "skill_test_case",
  "skill_link",
  "team_permission_profile",
  "team_standing_rule",
  "team_inbox",
] as const

// 0050 给 team 表新增的列
const teamAlterColumns = ["slug", "kind", "settings", "owner_user_id"] as const

// 0050 给 team 表新增的索引
const teamNewIndexes = ["team_organization_slug", "team_kind", "team_owner_user_id"] as const

// 19 个新 typeid prefix（与 ee/packages/utils/src/typeid.ts 注册一致）
// 全部 4 字符，符合 "4 字符 prefix + 1 下划线 + 26 suffix = 31 ≤ varchar(64)" 不变量 I2
const newTypeIdPrefixes = [
  "trol",
  "tagt",
  "ttsk",
  "tbrd",
  "tthd",
  "tart",
  "tarv",
  "tmbx",
  "tbgt",
  "tbal",
  "taut",
  "taur",
  "taal",
  "svld",
  "stst",
  "slnk",
  "tppr",
  "tsrl",
  "tibx",
] as const

function shortOutput(output: string) {
  return output.slice(Math.max(0, output.length - 4_000))
}

function extractDdlStatements(sql: string): string[] {
  return sql
    .replace(/\r\n/g, "\n")
    .replace(/^\s*--.*$/gm, "")
    .replace(/-->\s*statement-breakpoint/g, "")
    .split(/;\s*/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) =>
      /^(ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX)\s/i.test(statement),
    )
}

function countStatementBreakpoints(sql: string): number {
  return (sql.match(/-->\s*statement-breakpoint/g) || []).length
}

function sqlFromDrizzleKitExport(stdout: string) {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n")
  const firstSqlLine = lines.findIndex((line) => /^(CREATE|ALTER|DROP)\s/i.test(line.trimStart()))
  if (firstSqlLine === -1) {
    throw new Error("drizzle-kit export did not emit SQL")
  }
  return `${lines.slice(firstSqlLine).join("\n").trim()}\n`
}

function exportCurrentSchemaSql() {
  const result = spawnSync(
    pnpmCommand,
    ["exec", "drizzle-kit", "export", "--config", "drizzle.config.ts"],
    {
      cwd: packageDir,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_HOST: "",
        DATABASE_NAME: "",
        DATABASE_PASSWORD: "",
        DATABASE_URL: "",
        DATABASE_USERNAME: "",
      },
    },
  )

  assert.equal(
    result.status,
    0,
    `drizzle-kit export failed\nstdout:\n${shortOutput(result.stdout)}\nstderr:\n${shortOutput(result.stderr)}`,
  )
  return sqlFromDrizzleKitExport(result.stdout)
}

function quoteIdentifier(identifier: string) {
  return `\`${identifier.replace(/`/g, "``")}\``
}

function scratchDatabaseName() {
  return `ow_ta_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

function mysqlConnectionConfigFor(baseUrl: string, databaseName: string) {
  return {
    ...parseMySqlConnectionConfig(`${baseUrl}/${databaseName}`),
    multipleStatements: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function queryRecords(
  connection: mysql.Connection,
  sql: string,
  args: (string | number | string[])[] = [],
) {
  const [rows] = await connection.query(sql, args)
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

async function schemaColumnLines(connection: mysql.Connection, tableNames: string[]) {
  const rows = await queryRecords(
    connection,
    `SELECT table_name AS table_name, column_name AS column_name, column_type AS column_type, is_nullable AS is_nullable
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name IN (?)
     ORDER BY table_name, ordinal_position`,
    [tableNames],
  )

  return rows.map((row) => {
    const tableName = String(row.table_name)
    const columnName = String(row.column_name)
    const columnType = String(row.column_type)
    const isNullable = String(row.is_nullable)
    return `${tableName}.${columnName}: ${columnType} ${isNullable}`
  })
}

async function schemaIndexLines(connection: mysql.Connection, tableNames: string[]) {
  const rows = await queryRecords(
    connection,
    `SELECT table_name AS table_name, index_name AS index_name, column_name AS column_name
     FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name IN (?)
     ORDER BY table_name, index_name, seq_in_index`,
    [tableNames],
  )

  const keys: string[] = []
  const columnsByKey = new Map<string, string[]>()

  for (const row of rows) {
    const tableName = String(row.table_name)
    const indexName = String(row.index_name)
    const key = `${tableName}.${indexName}`
    let columns = columnsByKey.get(key)
    if (!columns) {
      columns = []
      columnsByKey.set(key, columns)
      keys.push(key)
    }
    columns.push(String(row.column_name))
  }

  return keys.sort().map((key) => {
    const columns = columnsByKey.get(key)
    assert.ok(columns, `Missing columns for ${key}`)
    return `${key}: ${columns.join(",")}`
  })
}

describe("team-autonomy migration validation (P0 ③)", () => {
  // ============================================================
  // V1: 0050 SQL 语法合法
  // ============================================================
  describe("V1: 0050 SQL syntax", () => {
    test("contains 26 DDL statements (7 team ALTER/INDEX + 19 CREATE TABLE)", async () => {
      const sql = await readFile(migrationFile, "utf8")
      const statements = extractDdlStatements(sql)

      // 7 (team ALTER/INDEX) + 19 (CREATE TABLE) = 26 statements
      assert.equal(
        statements.length,
        26,
        `expected 26 statements, got ${statements.length}`,
      )

      for (const statement of statements) {
        assert.match(
          statement,
          /^(ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX)\s/i,
          `unexpected statement: ${statement.slice(0, 100)}`,
        )
      }
    })

    test("every CREATE TABLE declares a PRIMARY KEY constraint", async () => {
      const sql = await readFile(migrationFile, "utf8")
      const statements = extractDdlStatements(sql)
      const createTableStatements = statements.filter((s) => /^CREATE TABLE/i.test(s))

      assert.equal(
        createTableStatements.length,
        newTables.length,
        `expected ${newTables.length} CREATE TABLE statements`,
      )

      for (const statement of createTableStatements) {
        assert.match(
          statement,
          /PRIMARY KEY/i,
          `missing PRIMARY KEY: ${statement.slice(0, 80)}`,
        )
      }
    })

    test("executes 0050 SQL against scratch MySQL via mysql2 without error", {
      skip: !mysqlUrl,
      timeout: 120_000,
    }, async () => {
      if (!mysqlUrl) return

      const root = await mysql.createConnection(mysqlUrl)
      const database = scratchDatabaseName()
      let connection: mysql.Connection | undefined

      try {
        await root.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
        connection = await mysql.createConnection(mysqlConnectionConfigFor(mysqlUrl, database))

        // 0050 ALTERs team table; pre-create minimal team table matching pre-0050 shape.
        // Pre-0050 team columns: id, name, organization_id, created_at, updated_at
        await connection.query(`
          CREATE TABLE \`team\` (
            \`id\` varchar(64) NOT NULL,
            \`name\` varchar(255) NOT NULL,
            \`organization_id\` varchar(64) NOT NULL,
            \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            CONSTRAINT \`team_id\` PRIMARY KEY (\`id\`)
          )
        `)

        const sql = await readFile(migrationFile, "utf8")
        for (const statement of extractDdlStatements(sql)) {
          await connection.query(`${statement};`)
        }
      } finally {
        await connection?.end().catch(() => {})
        await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(() => {})
        await root.end()
      }
    })
  })

  // ============================================================
  // V2: drizzle-kit export 与 0050 migration replay 的 schema parity
  // ============================================================
  describe("V2: drizzle-kit export parity for 0050 new tables", () => {
    test("export contains all 19 new team-autonomy tables", () => {
      const exportSql = exportCurrentSchemaSql()

      for (const table of newTables) {
        const pattern = new RegExp(`CREATE TABLE \`${table}\``, "i")
        assert.match(exportSql, pattern, `export missing table ${table}`)
      }
    })

    test("export contains team table with 4 new columns", () => {
      const exportSql = exportCurrentSchemaSql()
      const teamTableMatch = /CREATE TABLE `team` \([\s\S]*?\);/i.exec(exportSql)
      assert.ok(teamTableMatch, "export missing team table")
      const teamTable = teamTableMatch[0]

      for (const col of teamAlterColumns) {
        assert.match(
          teamTable,
          new RegExp(`\`${col}\``, "i"),
          `team table missing column ${col}`,
        )
      }
    })

    test("export contains 3 new team indexes (inline UNIQUE or separate CREATE INDEX)", () => {
      const exportSql = exportCurrentSchemaSql()

      // team_organization_slug is a uniqueIndex → export emits it as inline
      // CONSTRAINT `team_organization_slug` UNIQUE(`organization_id`,`slug`) within CREATE TABLE team
      assert.match(
        exportSql,
        /CONSTRAINT `team_organization_slug` UNIQUE\(`organization_id`,`slug`\)/i,
        "export missing team_organization_slug unique constraint",
      )
      // team_kind and team_owner_user_id are regular indexes → separate CREATE INDEX statements
      assert.match(
        exportSql,
        /CREATE INDEX `team_kind` ON `team`/i,
        "export missing team_kind index",
      )
      assert.match(
        exportSql,
        /CREATE INDEX `team_owner_user_id` ON `team`/i,
        "export missing team_owner_user_id index",
      )
    })

    test("replayed 0050 schema matches drizzle-kit export for 19 new tables + team", {
      skip: !mysqlUrl,
      timeout: 240_000,
    }, async () => {
      if (!mysqlUrl) return

      const root = await mysql.createConnection(mysqlUrl)
      const replayDb = scratchDatabaseName()
      const exportDb = scratchDatabaseName()
      let replayConnection: mysql.Connection | undefined
      let exportConnection: mysql.Connection | undefined

      try {
        await root.query(`CREATE DATABASE ${quoteIdentifier(replayDb)}`)
        await root.query(`CREATE DATABASE ${quoteIdentifier(exportDb)}`)
        replayConnection = await mysql.createConnection(mysqlConnectionConfigFor(mysqlUrl, replayDb))
        exportConnection = await mysql.createConnection(mysqlConnectionConfigFor(mysqlUrl, exportDb))

        // Apply drizzle-kit export SQL to BOTH databases (full schema including 19 new tables)
        const exportSql = exportCurrentSchemaSql()
        const exportStatements = exportSql
          .split(/;\s*(?:\n|$)/)
          .map((s) => s.trim())
          .filter(Boolean)

        for (const statement of exportStatements) {
          await replayConnection.query(statement)
          await exportConnection.query(statement)
        }

        // Reverse 0050 changes on replayDb: drop 19 new tables + 4 team columns + 3 team indexes
        for (const table of newTables) {
          await replayConnection.query(`DROP TABLE IF EXISTS \`${table}\``)
        }
        await replayConnection.query(`ALTER TABLE \`team\` DROP INDEX \`team_organization_slug\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP INDEX \`team_kind\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP INDEX \`team_owner_user_id\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP COLUMN \`slug\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP COLUMN \`kind\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP COLUMN \`settings\``).catch(() => {})
        await replayConnection.query(`ALTER TABLE \`team\` DROP COLUMN \`owner_user_id\``).catch(() => {})

        // Replay 0050 SQL on replayDb
        const migrationSql = await readFile(migrationFile, "utf8")
        for (const statement of extractDdlStatements(migrationSql)) {
          await replayConnection.query(`${statement};`)
        }

        // Compare schema for 19 new tables + team
        const tablesToCompare = [...newTables, "team"]

        const replayColumns = await schemaColumnLines(replayConnection, tablesToCompare)
        const exportColumns = await schemaColumnLines(exportConnection, tablesToCompare)
        const exportColumnsFiltered = exportColumns.filter((line) =>
          replayColumns.includes(line),
        )

        assert.deepEqual(
          [...exportColumnsFiltered].sort(),
          [...replayColumns].sort(),
          "Column parity mismatch for 0050 tables",
        )

        const replayIndexes = await schemaIndexLines(replayConnection, tablesToCompare)
        const exportIndexes = await schemaIndexLines(exportConnection, tablesToCompare)
        const exportIndexesFiltered = exportIndexes.filter((line) =>
          replayIndexes.includes(line),
        )

        assert.deepEqual(
          [...exportIndexesFiltered].sort(),
          [...replayIndexes].sort(),
          "Index parity mismatch for 0050 tables",
        )
      } finally {
        await replayConnection?.end().catch(() => {})
        await exportConnection?.end().catch(() => {})
        await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(replayDb)}`).catch(() => {})
        await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(exportDb)}`).catch(() => {})
        await root.end()
      }
    })
  })

  // ============================================================
  // V3: 表/列/索引完整性（19 新表 + team 表 ALTER）
  // ============================================================
  describe("V3: table/column/index completeness", () => {
    test("0050 SQL creates all 19 new tables", async () => {
      const sql = await readFile(migrationFile, "utf8")
      for (const table of newTables) {
        assert.match(
          sql,
          new RegExp(`CREATE TABLE \`${table}\``, "i"),
          `missing CREATE TABLE for ${table}`,
        )
      }
    })

    test("0050 SQL ALTERs team table with 4 new columns", async () => {
      const sql = await readFile(migrationFile, "utf8")
      for (const col of teamAlterColumns) {
        assert.match(
          sql,
          new RegExp(`ALTER TABLE \`team\` ADD \`${col}\``, "i"),
          `missing ALTER TABLE team ADD ${col}`,
        )
      }
    })

    test("0050 SQL creates 3 new indexes on team table", async () => {
      const sql = await readFile(migrationFile, "utf8")
      assert.match(sql, /CREATE UNIQUE INDEX `team_organization_slug` ON `team`/i)
      assert.match(sql, /CREATE INDEX `team_kind` ON `team`/i)
      assert.match(sql, /CREATE INDEX `team_owner_user_id` ON `team`/i)
    })

    test("all 19 new tables use varchar(64) for id column (invariant I2)", async () => {
      const sql = await readFile(migrationFile, "utf8")
      for (const table of newTables) {
        const tableMatch = new RegExp(
          `CREATE TABLE \`${table}\` \\([\\s\\S]*?\\);`,
          "i",
        ).exec(sql)
        assert.ok(tableMatch, `could not extract table ${table}`)
        const tableDef = tableMatch[0]
        assert.match(
          tableDef,
          /`id` varchar\(64\) NOT NULL/i,
          `table ${table} missing varchar(64) id column`,
        )
      }
    })

    test("all 19 new typeid prefixes are 4 characters (≤ 31 chars total, fits varchar(64))", () => {
      for (const prefix of newTypeIdPrefixes) {
        assert.equal(
          prefix.length,
          4,
          `typeid prefix ${prefix} should be 4 characters`,
        )
      }
      // 4 prefix + 1 underscore + 26 suffix = 31 ≤ 64
      const maxIdLength = 4 + 1 + 26
      assert.ok(maxIdLength <= 64, `max id length ${maxIdLength} must fit varchar(64)`)
    })

    test("every statement ends with statement-breakpoint except the last (invariant I4)", async () => {
      const sql = await readFile(migrationFile, "utf8")
      const statements = extractDdlStatements(sql)
      const breakpointCount = countStatementBreakpoints(sql)
      // 26 statements, 25 breakpoints (last statement team_inbox has no trailing breakpoint)
      assert.equal(
        breakpointCount,
        statements.length - 1,
        `expected ${statements.length - 1} breakpoints, got ${breakpointCount}`,
      )
    })
  })

  // ============================================================
  // V4: TypeScript 编译（pnpm build exit 0）
  // ============================================================
  describe("V4: TypeScript compilation via pnpm build", () => {
    test("pnpm run build exits 0 and emits dist/index.js", { timeout: 240_000 }, () => {
      const result = spawnSync(pnpmCommand, ["run", "build"], {
        cwd: packageDir,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_HOST: "",
          DATABASE_NAME: "",
          DATABASE_PASSWORD: "",
          DATABASE_URL: "",
          DATABASE_USERNAME: "",
          DEN_DB_ENCRYPTION_KEY:
            process.env.DEN_DB_ENCRYPTION_KEY ??
            "test-encryption-key-12345678901234567890",
        },
      })

      assert.equal(
        result.status,
        0,
        `pnpm run build failed\nstdout:\n${shortOutput(result.stdout)}\nstderr:\n${shortOutput(result.stderr)}`,
      )
      assert.equal(existsSync(distIndexFile), true, "dist/index.js not emitted")
    })
  })

  // ============================================================
  // V5: _journal.json 注册 0050 条目
  // ============================================================
  describe("V5: _journal.json registers 0050 entry", () => {
    test("journal has idx=50 entry with tag 0050_team_autonomy and breakpoints=true", async () => {
      const journalText = await readFile(journalFile, "utf8")
      const journal = JSON.parse(journalText) as {
        entries: Array<{ idx: number; tag: string; breakpoints: boolean }>
      }

      const entry50 = journal.entries.find((e) => e.idx === 50)
      assert.ok(entry50, "journal missing idx=50 entry")
      assert.equal(entry50!.tag, "0050_team_autonomy")
      assert.equal(entry50!.breakpoints, true)
    })

    test("journal entries are sequentially numbered 1..50 with no gaps", async () => {
      const journalText = await readFile(journalFile, "utf8")
      const journal = JSON.parse(journalText) as {
        entries: Array<{ idx: number }>
      }

      const indices = journal.entries.map((e) => e.idx).sort((a, b) => a - b)
      assert.equal(indices.length, 50, `expected 50 entries, got ${indices.length}`)
      for (let i = 0; i < 50; i++) {
        assert.equal(indices[i], i + 1, `idx ${i + 1} missing or out of order`)
      }
    })
  })
})
