/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/acl/postgres-grant-store.ts
 * 移植说明：保留 CREATE TABLE acl_grants schema；保留 advisory lock 模式 pg_advisory_xact_lock(hashtext($1)) with key acl-grants:${ownerScopeId}\n${ref}；保留 replaceForResourceIfCurrent 的 FOR UPDATE + advisory lock 双重保护；保留 put 的 ON CONFLICT DO UPDATE、remove 的事务化删除；createPgPool 改从 ../../persistence/pg-pool.ts 导入；Grant/Permission 改从 ./types.ts 导入；ScopeId 改从 ../memory/types.ts 导入。
 */

import { createPgPool } from "../../persistence/pg-pool.js";
import type { Grant, Permission } from "./types.js";
import type { ScopeId } from "../memory/types.js";
import type { GrantPersistence } from "./acl-store.js";

function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    ownerScopeId: r.owner_scope_id as ScopeId,
    ref: r.path as string,
    granteeScopeId: r.grantee_scope_id as ScopeId,
    permission: r.permission as Permission,
    grantedBy: r.granted_by as string,
  };
}

export function createPostgresGrantStore(connectionString: string): GrantPersistence {
  const db = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS acl_grants(
        owner_scope_id   TEXT NOT NULL,
        path             TEXT NOT NULL,
        grantee_scope_id TEXT NOT NULL,
        permission       TEXT NOT NULL,
        granted_by       TEXT NOT NULL,
        PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission)
      )`,
  ]);
  const { q } = db;

  return {
    async all() {
      const rows = await q(
        "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants ORDER BY owner_scope_id, path, grantee_scope_id, permission",
      );
      return rows.map(rowToGrant);
    },
    async put(g) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          `INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (owner_scope_id, path, grantee_scope_id, permission)
           DO UPDATE SET granted_by = EXCLUDED.granted_by`,
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission, g.grantedBy],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async remove(g) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          "DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 AND grantee_scope_id = $3 AND permission = $4",
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async replaceForResourceIfCurrent(ownerScopeId, ref, expected, replacement) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${ownerScopeId}\n${ref}`]);
        const selected = await client.query(
          "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 FOR UPDATE",
          [ownerScopeId, ref],
        );
        const current = selected.rows.map(rowToGrant);
        const sameTuple = (a: Grant, b: Grant) =>
          a.ownerScopeId === b.ownerScopeId &&
          a.ref === b.ref &&
          a.granteeScopeId === b.granteeScopeId &&
          a.permission === b.permission &&
          a.grantedBy === b.grantedBy;
        if (
          current.length !== expected.length ||
          current.some((grant: Grant) => !expected.some((candidate) => sameTuple(grant, candidate)))
        ) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query("DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2", [ownerScopeId, ref]);
        for (const grant of replacement) {
          await client.query(
            "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5)",
            [grant.ownerScopeId, grant.ref, grant.granteeScopeId, grant.permission, grant.grantedBy],
          );
        }
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
