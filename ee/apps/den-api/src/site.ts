import { eq } from "@openwork-ee/den-db/drizzle"
import { SiteTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { Database } from "@openwork-ee/den-db"

export async function createSite(
  db: Database,
  input: { organizationId: string; name: string; domain?: string },
) {
  const id = `site_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const [site] = await db.insert(SiteTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    domain: input.domain ?? null,
  }).returning()
  return site
}

export async function listSites(db: Database, organizationId: string) {
  return db.select().from(SiteTable).where(eq(SiteTable.organizationId, organizationId)).all()
}

export async function getSite(db: Database, siteId: string) {
  const [site] = await db.select().from(SiteTable).where(eq(SiteTable.id, siteId)).limit(1)
  return site ?? null
}

export async function deleteSite(db: Database, siteId: string) {
  const [site] = await db.delete(SiteTable).where(eq(SiteTable.id, siteId)).returning()
  return site ?? null
}