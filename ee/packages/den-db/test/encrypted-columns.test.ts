import assert from "node:assert/strict"
import test from "node:test"
import { mysqlTable } from "drizzle-orm/mysql-core"
import { encryptedTextColumn } from "../src/columns.js"

test("encrypted columns round-trip an empty string", () => {
  const previous = process.env.DEN_DB_ENCRYPTION_KEY
  process.env.DEN_DB_ENCRYPTION_KEY = "12345678901234567890123456789012"
  try {
    const table = mysqlTable("encrypted_empty_fixture", {
      value: encryptedTextColumn("value").notNull(),
    })
    const encrypted = table.value.mapToDriverValue("")
    assert.equal(table.value.mapFromDriverValue(encrypted), "")
  } finally {
    if (previous === undefined) delete process.env.DEN_DB_ENCRYPTION_KEY
    else process.env.DEN_DB_ENCRYPTION_KEY = previous
  }
})
