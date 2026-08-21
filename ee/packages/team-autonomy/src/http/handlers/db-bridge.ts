// @ts-nocheck
/**
 * DB connection bridge — temporarily re-exports den-api's `db` instance
 * until the plugin owns its own connection pool.
 */
export { db } from "../../../../../apps/den-api/src/db.js"
