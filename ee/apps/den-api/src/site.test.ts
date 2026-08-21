import { describe, expect, mock, test } from "bun:test"
import { createSite, listSites, getSite, deleteSite } from "./site.js"

const newSite = { id: "site_1", organizationId: "org_1", name: "My Site", domain: "example.com" }
const existingSite = { id: "site_1", organizationId: "org_1", name: "Test Site" }

const makeMockDb = () => ({
  insert: mock(() => ({
    values: mock((values) => ({
      returning: mock(() => Promise.resolve([{ id: "site_1", organizationId: values.organizationId, name: values.name, domain: values.domain ?? null }])),
    })),
  })),
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(() => Promise.resolve([existingSite])),
        all: mock(() => Promise.resolve([existingSite])),
      })),
    })),
  })),
  delete: mock(() => ({
    where: mock(() => ({
      returning: mock(() => Promise.resolve([{ id: "site_1", organizationId: "org_1", name: "Deleted Site" }])),
    })),
  })),
})

describe("site service", () => {
  test("createSite returns a site with id, organizationId, name, and domain", async () => {
    const mockDb = makeMockDb()
    const site = await createSite(mockDb, { organizationId: "org_1", name: "My Site", domain: "example.com" })
    expect(site.id).toBe("site_1")
    expect(site.organizationId).toBe("org_1")
    expect(site.name).toBe("My Site")
    expect(site.domain).toBe("example.com")
  })

  test("createSite sets domain to null when omitted", async () => {
    const mockDb = makeMockDb()
    const site = await createSite(mockDb, { organizationId: "org_1", name: "Site No Domain" })
    expect(site.domain).toBeNull()
  })

  test("listSites returns sites for the given organization", async () => {
    const mockDb = makeMockDb()
    const sites = await listSites(mockDb, "org_1")
    expect(sites.length).toBe(1)
    expect(sites[0].name).toBe("Test Site")
  })

  test("getSite returns a site by id", async () => {
    const mockDb = makeMockDb()
    const site = await getSite(mockDb, "site_1")
    expect(site).not.toBeNull()
    expect(site?.name).toBe("Test Site")
  })

  test("getSite returns null for unknown id", async () => {
    const mockDb = makeMockDb()
    mockDb.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    }))
    const site = await getSite(mockDb, "site_nonexistent")
    expect(site).toBeNull()
  })

  test("deleteSite removes a site and returns it", async () => {
    const mockDb = makeMockDb()
    const deleted = await deleteSite(mockDb, "site_1")
    expect(deleted).not.toBeNull()
    expect(deleted?.name).toBe("Deleted Site")
  })

  test("deleteSite returns null for unknown id", async () => {
    const mockDb = makeMockDb()
    mockDb.delete = mock(() => ({
      where: mock(() => ({
        returning: mock(() => Promise.resolve([])),
      })),
    }))
    const deleted = await deleteSite(mockDb, "site_nonexistent")
    expect(deleted).toBeNull()
  })
})