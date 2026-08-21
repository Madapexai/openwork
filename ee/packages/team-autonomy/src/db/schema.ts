/**
 * DB schema exposure for the plugin.
 *
 * Layering decision:
 *   Drizzle table defs live in @openwork-ee/den-db because migrations,
 *   schema parity tests, and the existing relation graph need team-autonomy
 *   tables. Moving them out would create a circular dependency.
 *
 *   So the plugin RE-EXPORTS the schema shapes it needs from the canonical
 *   den-db schema barrel. The barrel (`@openwork-ee/den-db/schema`) re-exports
 *   all sub-schemas; any name mismatch surfaces immediately at tsc so we
 *   don't maintain a second list of names here.
 *
 *   If you want ONLY team-autonomy imports, use `@openwork-ee/den-db/schema/team-autonomy`
 *   directly (still allowed, just not re-exported via this shim).
 */
export * from "@openwork-ee/den-db/schema";

export type {
  InferSelectModel,
  InferInsertModel,
} from "drizzle-orm";
