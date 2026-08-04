-- ============================================================
-- 团队自治 Schema — 基于 WorkBuddy Bluebook 调研修正
-- 团队为第一等公民，兼容个人管理（Personal Team 自动创建）
-- 包含：角色契约 / Agent 池 / 任务依赖图 / 共享产物层状态机 /
--      自动化状态机 + 降级交付 + 可行动告警 /
--      Skill 三重验证 + 诱饵测试 / 双轨权限 + Standing Rule / 团队 Inbox
-- ============================================================

-- ---------- Step 1: 升级 team 表（团队第一等公民） ----------
ALTER TABLE `team` ADD `slug` varchar(128);--> statement-breakpoint
ALTER TABLE `team` ADD `kind` enum('personal','shared','enterprise') NOT NULL DEFAULT 'shared';--> statement-breakpoint
ALTER TABLE `team` ADD `settings` json;--> statement-breakpoint
ALTER TABLE `team` ADD `owner_user_id` varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX `team_organization_slug` ON `team` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `team_kind` ON `team` (`kind`);--> statement-breakpoint
CREATE INDEX `team_owner_user_id` ON `team` (`owner_user_id`);--> statement-breakpoint

-- ---------- Step 2: 角色契约（WorkBuddy Ch24） ----------
CREATE TABLE `team_role` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `name` enum('owner','admin','editor','viewer') NOT NULL,
  `permissions` json NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_role_id` PRIMARY KEY(`id`),
  KEY `team_role_team_id` (`team_id`),
  CONSTRAINT `team_role_team_name` UNIQUE(`team_id`,`name`)
);--> statement-breakpoint

-- ---------- Step 3: 团队 Agent 池（OpenWorker sidecar 实例 + 角色契约） ----------
CREATE TABLE `team_agent` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `engine` enum('openworker','opencode','mcp','generic') NOT NULL DEFAULT 'openworker',
  `role_id` varchar(64),
  `persona` text,
  `skills` json,
  `connectors` json,
  `model_default` varchar(64),
  `status` enum('idle','busy','paused','offline','error') NOT NULL DEFAULT 'idle',
  `sidecar_session_id` varchar(128),
  `forbidden_actions` json,
  `current_task_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_agent_id` PRIMARY KEY(`id`),
  KEY `team_agent_team_id` (`team_id`),
  KEY `team_agent_status` (`team_id`,`status`),
  KEY `team_agent_role_id` (`role_id`)
);--> statement-breakpoint

-- ---------- Step 4: 项目看板 + 任务依赖图 ----------
CREATE TABLE `team_board` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `columns` json NOT NULL,
  `created_by` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_board_id` PRIMARY KEY(`id`),
  KEY `team_board_team_id` (`team_id`)
);--> statement-breakpoint

CREATE TABLE `team_task` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `board_id` varchar(64),
  `title` varchar(256) NOT NULL,
  `description` text,
  `status` varchar(32) NOT NULL DEFAULT 'todo',
  `column_id` varchar(32) NOT NULL,
  `assignee_type` enum('member','agent') NOT NULL,
  `assignee_id` varchar(64) NOT NULL,
  `created_by` varchar(64) NOT NULL,
  `priority` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  `depends_on` json,
  `blocks` json,
  `plan` text,
  `plan_status` enum('none','pending','approved','rejected','revision_requested') NOT NULL DEFAULT 'none',
  `plan_approved_by` varchar(64),
  `plan_approved_at` timestamp(3),
  `artifacts` json,
  `started_at` timestamp(3),
  `completed_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_task_id` PRIMARY KEY(`id`),
  KEY `team_task_team_status` (`team_id`,`status`),
  KEY `team_task_assignee` (`assignee_type`,`assignee_id`),
  KEY `team_task_board` (`board_id`,`column_id`),
  KEY `team_task_plan_status` (`team_id`,`plan_status`)
);--> statement-breakpoint

CREATE TABLE `team_task_handoff` (
  `id` varchar(64) NOT NULL,
  `task_id` varchar(64) NOT NULL,
  `from_assignee_type` enum('member','agent') NOT NULL,
  `from_assignee_id` varchar(64) NOT NULL,
  `to_assignee_type` enum('member','agent') NOT NULL,
  `to_assignee_id` varchar(64) NOT NULL,
  `reason` text,
  `context_snapshot` json,
  `handed_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_task_handoff_id` PRIMARY KEY(`id`),
  KEY `team_task_handoff_task_id` (`task_id`)
);--> statement-breakpoint

-- ---------- Step 5: 共享产物层（修正 1：artifact 状态机） ----------
-- 状态机：draft → in_review → confirmed → superseded → archived
-- 下游角色只能读取 confirmed 状态的 artifact
CREATE TABLE `team_artifact` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `task_id` varchar(64),
  `name` varchar(256) NOT NULL,
  `kind` enum('document','spreadsheet','presentation','image','data','config','code','video','audio','other') NOT NULL,
  `mime_type` varchar(128),
  `storage_uri` varchar(1024) NOT NULL,
  `size_bytes` int NOT NULL,
  `status` enum('draft','in_review','confirmed','superseded','archived') NOT NULL DEFAULT 'draft',
  `current_version` int NOT NULL DEFAULT 1,
  `produced_by_type` enum('member','agent') NOT NULL,
  `produced_by_id` varchar(64) NOT NULL,
  `confirmed_by` varchar(64),
  `confirmed_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_artifact_id` PRIMARY KEY(`id`),
  KEY `team_artifact_team_kind` (`team_id`,`kind`),
  KEY `team_artifact_team_status` (`team_id`,`status`),
  KEY `team_artifact_task_id` (`task_id`),
  KEY `team_artifact_produced_by` (`produced_by_type`,`produced_by_id`)
);--> statement-breakpoint

CREATE TABLE `team_artifact_version` (
  `id` varchar(64) NOT NULL,
  `artifact_id` varchar(64) NOT NULL,
  `version_number` int NOT NULL,
  `storage_uri` varchar(1024) NOT NULL,
  `size_bytes` int NOT NULL,
  `change_summary` text,
  `produced_by_type` enum('member','agent') NOT NULL,
  `produced_by_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_artifact_version_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_artifact_version_artifact_version` UNIQUE(`artifact_id`,`version_number`),
  KEY `team_artifact_version_artifact` (`artifact_id`,`version_number`)
);--> statement-breakpoint

-- ---------- Step 6: 团队信箱 ----------
CREATE TABLE `team_mailbox` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `recipient_type` enum('member','agent','channel') NOT NULL,
  `recipient_id` varchar(64) NOT NULL,
  `sender_type` enum('member','agent','system') NOT NULL,
  `sender_id` varchar(64) NOT NULL,
  `kind` enum('message','task_update','approval_request','notification') NOT NULL,
  `subject` varchar(256),
  `body` text,
  `attachment_refs` json,
  `related_task_id` varchar(64),
  `read_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_mailbox_id` PRIMARY KEY(`id`),
  KEY `team_mailbox_recipient` (`recipient_type`,`recipient_id`,`read_at`),
  KEY `team_mailbox_team_time` (`team_id`,`created_at`),
  KEY `team_mailbox_related_task` (`related_task_id`)
);--> statement-breakpoint

-- ---------- Step 7: 团队预算（角色级配额） ----------
CREATE TABLE `team_budget` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `period` enum('daily','weekly','monthly') NOT NULL DEFAULT 'monthly',
  `total_tokens` int NOT NULL,
  `used_tokens` int NOT NULL DEFAULT 0,
  `total_cost_cents` int NOT NULL,
  `used_cost_cents` int NOT NULL DEFAULT 0,
  `reset_at` timestamp(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_budget_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_budget_team_period` UNIQUE(`team_id`,`period`)
);--> statement-breakpoint

CREATE TABLE `team_budget_allocation` (
  `id` varchar(64) NOT NULL,
  `budget_id` varchar(64) NOT NULL,
  `entity_type` enum('member','agent','role') NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `allocated_tokens` int NOT NULL,
  `used_tokens` int NOT NULL DEFAULT 0,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_budget_allocation_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_budget_allocation_budget_entity` UNIQUE(`budget_id`,`entity_type`,`entity_id`)
);--> statement-breakpoint

-- ---------- Step 8: 自动化状态机（修正 2） ----------
-- 借鉴 LangGraph Checkpoint（state JSON 断点续跑）+ Temporal RetryOptions
CREATE TABLE `team_automation` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `cron_expr` varchar(64) NOT NULL,
  `message` text NOT NULL,
  `agent_id` varchar(64),
  `scoped_approvals` json,
  `timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  `enabled` boolean NOT NULL DEFAULT true,
  `last_run_at` timestamp(3),
  `next_run_at` timestamp(3),
  `skip_on_overlap` boolean NOT NULL DEFAULT true,
  `run_once_catch_up` boolean NOT NULL DEFAULT true,
  `manual_run_count` int NOT NULL DEFAULT 0,
  `ready_for_schedule` boolean NOT NULL DEFAULT false,
  `quality_gate` json,
  `retry_policy` json,
  `delivery_targets` json,
  `max_cost_cents_per_run` int,
  `owner_member_id` varchar(64) NOT NULL,
  `created_by` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_automation_id` PRIMARY KEY(`id`),
  KEY `team_automation_team_enabled` (`team_id`,`enabled`,`next_run_at`),
  KEY `team_automation_agent_id` (`agent_id`)
);--> statement-breakpoint

CREATE TABLE `team_automation_run` (
  `id` varchar(64) NOT NULL,
  `automation_id` varchar(64) NOT NULL,
  `task_id` varchar(64),
  `batch_id` varchar(128) NOT NULL,
  `status` enum('waiting_trigger','fetching','partial_aggregating','aggregating','filtering','delivering','completed','blocked','failed') NOT NULL DEFAULT 'waiting_trigger',
  `state` json,
  `degradation_level` enum('full','partial','minimal','blocked'),
  `started_at` timestamp(3) NOT NULL,
  `finished_at` timestamp(3),
  `error` text,
  `artifacts` json,
  `tokens_used` int,
  `cost_cents` int,
  `dry_run` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_automation_run_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_automation_run_batch` UNIQUE(`automation_id`,`batch_id`),
  KEY `team_automation_run_automation_started` (`automation_id`,`started_at`),
  KEY `team_automation_run_status` (`status`)
);--> statement-breakpoint

-- 可行动告警（WorkBuddy Ch25：必须含 7 字段：批次/状态/触发时间/失败原因/已完成步骤/影响/建议处理/恢复入口）
CREATE TABLE `team_automation_alert` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `automation_id` varchar(64) NOT NULL,
  `run_id` varchar(64),
  `trigger_time` varchar(16),
  `severity` varchar(16) NOT NULL DEFAULT 'warning',
  `failure_reason` text NOT NULL,
  `completed_steps` json,
  `impact` text NOT NULL,
  `suggested_actions` json NOT NULL,
  `recovery_entry` varchar(256) NOT NULL,
  `delivered` boolean NOT NULL DEFAULT false,
  `delivered_at` timestamp(3),
  `acknowledged_by` varchar(64),
  `acknowledged_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_automation_alert_id` PRIMARY KEY(`id`),
  KEY `team_automation_alert_team` (`team_id`,`delivered`,`created_at`),
  KEY `team_automation_alert_automation` (`automation_id`),
  KEY `team_automation_alert_run` (`run_id`)
);--> statement-breakpoint

-- ---------- Step 9: Skill 三重验证 + 诱饵测试（修正 3） ----------
-- 复用现有 config_object（objectType='skill'），新增验证元数据
CREATE TABLE `skill_validation` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `config_object_id` varchar(64) NOT NULL,
  `validation_type` enum('cross_domain','predictive_power','uniqueness') NOT NULL,
  `status` enum('pending','in_progress','passed','failed','skipped') NOT NULL DEFAULT 'pending',
  `evidence` json,
  `reason` text,
  `reviewed_by` varchar(64),
  `reviewed_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_validation_id` PRIMARY KEY(`id`),
  KEY `skill_validation_team` (`team_id`),
  KEY `skill_validation_config_object` (`config_object_id`,`validation_type`),
  KEY `skill_validation_status` (`status`)
);--> statement-breakpoint

CREATE TABLE `skill_test_case` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `config_object_id` varchar(64) NOT NULL,
  `kind` enum('bait','execution') NOT NULL,
  `input` text NOT NULL,
  `expected_behavior` text NOT NULL,
  `actual_behavior` text,
  `status` enum('pending','passed','failed') NOT NULL DEFAULT 'pending',
  `last_run_at` timestamp(3),
  `darwin_score` int,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_test_case_id` PRIMARY KEY(`id`),
  KEY `skill_test_case_team` (`team_id`),
  KEY `skill_test_case_config_object` (`config_object_id`,`kind`),
  KEY `skill_test_case_status` (`status`)
);--> statement-breakpoint

CREATE TABLE `skill_link` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `source_config_object_id` varchar(64) NOT NULL,
  `target_config_object_id` varchar(64) NOT NULL,
  `kind` enum('dependency','contrast','composition') NOT NULL,
  `note` text,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_link_id` PRIMARY KEY(`id`),
  KEY `skill_link_team` (`team_id`),
  KEY `skill_link_source` (`source_config_object_id`),
  KEY `skill_link_target` (`target_config_object_id`),
  CONSTRAINT `skill_link_unique` UNIQUE(`source_config_object_id`,`target_config_object_id`,`kind`)
);--> statement-breakpoint

-- ---------- Step 10: 双轨权限 + Standing Rule + Inbox（修正 4） ----------
CREATE TABLE `team_permission_profile` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `profile` enum('simple','advanced') NOT NULL DEFAULT 'simple',
  `default_mode` enum('ask','craft','plan','interactive','auto','custom') NOT NULL DEFAULT 'craft',
  `custom_rules` json,
  `updated_by` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_permission_profile_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_permission_profile_team` UNIQUE(`team_id`)
);--> statement-breakpoint

CREATE TABLE `team_standing_rule` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `scope` enum('team','agent','task') NOT NULL,
  `scope_id` varchar(64),
  `tool_name` varchar(64) NOT NULL,
  `target_pattern` varchar(512) NOT NULL,
  `granted_by` varchar(64) NOT NULL,
  `granted_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` timestamp(3),
  `revoked_at` timestamp(3),
  `revoked_by` varchar(64),
  CONSTRAINT `team_standing_rule_id` PRIMARY KEY(`id`),
  KEY `team_standing_rule_team_scope` (`team_id`,`scope`,`scope_id`),
  KEY `team_standing_rule_tool` (`tool_name`)
);--> statement-breakpoint

CREATE TABLE `team_inbox` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `session_id` varchar(128),
  `task_id` varchar(64),
  `assignee_type` enum('member','agent') NOT NULL,
  `assignee_id` varchar(64) NOT NULL,
  `kind` enum('approval','question','notification','directory','plan') NOT NULL,
  `tool_name` varchar(64),
  `arguments` json,
  `reason` text,
  `status` enum('pending','resolved','denied','superseded') NOT NULL DEFAULT 'pending',
  `resolved_by` varchar(64),
  `resolved_at` timestamp(3),
  `resolution` json,
  `external_tool_call_id` varchar(128),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_inbox_id` PRIMARY KEY(`id`),
  KEY `team_inbox_team_pending` (`team_id`,`assignee_type`,`assignee_id`,`status`,`created_at`),
  CONSTRAINT `team_inbox_external_tool_call` UNIQUE(`external_tool_call_id`),
  KEY `team_inbox_session` (`session_id`),
  KEY `team_inbox_task` (`task_id`)
);
