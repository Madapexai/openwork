-- ============================================================
-- 0051: TeamAgentEngine 扩展 'cli' + engine_config 列
-- 通用 CLI agent 引擎（Kimi AtomCode / Freebuff / Claude Code 等）接入铺路
-- OpenSpecs: prds/team-autonomy/openspecs/openspec-team-agent-engine-cli.md
-- 不变量：
--   I3: 可回滚（DROP COLUMN + MODIFY enum 去掉 'cli'）
--   I4: enum MODIFY 完整列出旧值+新值，不破坏现有 openworker/opencode 数据
-- ============================================================

ALTER TABLE `team_agent` ADD `engine_config` json;--> statement-breakpoint
ALTER TABLE `team_agent` MODIFY COLUMN `engine` enum('openworker','opencode','mcp','generic','cli') NOT NULL DEFAULT 'openworker';
