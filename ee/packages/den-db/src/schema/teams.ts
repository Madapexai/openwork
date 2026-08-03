import { relations, sql } from "drizzle-orm"
import { index, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"

// 团队类型（团队第一等公民）：
// - personal：用户个人团队（注册时自动创建，1 user ↔ 1 personal team）
// - shared：普通共享团队
// - enterprise：企业级团队（带 SSO/SCIM/审计）
export const TeamKind = ["personal", "shared", "enterprise"] as const

export const TeamTable = mysqlTable(
  "team",
  {
    id: denTypeIdColumn("team", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    // 团队第一等公民升级字段（0050_team_autonomy.sql 加入）
    slug: varchar("slug", { length: 128 }),
    kind: mysqlEnum("kind", TeamKind).notNull().default("shared"),
    settings: json("settings"),
    ownerUserId: denTypeIdColumn("user", "owner_user_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("team_organization_name").on(table.organizationId, table.name),
    uniqueIndex("team_organization_slug").on(table.organizationId, table.slug),
    index("team_kind").on(table.kind),
    index("team_owner_user_id").on(table.ownerUserId),
  ],
)

export const TeamMemberTable = mysqlTable(
  "team_member",
  {
    id: denTypeIdColumn("teamMember", "id").notNull().primaryKey(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_member_org_membership_id").on(table.orgMembershipId),
    uniqueIndex("team_member_team_org_membership").on(table.teamId, table.orgMembershipId),
  ],
)

export const teamRelations = relations(TeamTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [TeamTable.organizationId],
    references: [OrganizationTable.id],
  }),
  memberships: many(TeamMemberTable),
}))

export const teamMemberRelations = relations(TeamMemberTable, ({ one }) => ({
  team: one(TeamTable, {
    fields: [TeamMemberTable.teamId],
    references: [TeamTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [TeamMemberTable.orgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const team = TeamTable
export const teamMember = TeamMemberTable
