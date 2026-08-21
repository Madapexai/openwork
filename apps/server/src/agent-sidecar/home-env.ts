/**
 * 真实 HOME 恢复（Electron dev 模式隔离 HOME 的统一补偿）
 *
 * Electron dev 模式会把 process.env.HOME 重定向到隔离目录
 * （apps/desktop/electron/runtime.mjs buildChildEnv 在 OPENWORK_DEV_MODE=1
 * 时设置 HOME=openwork-dev-data/home），导致用户已登录/已安装的 CLI agent
 * （kimi/claude/codex/trae-cli 等从 $HOME/.<agent> 读登录态与配置，且 macOS
 * 上还会访问 $HOME/Library/Keychains/login.keychain-db）在隔离 HOME 下
 * 找不到登录态，甚至触发系统"找不到钥匙串"弹窗。
 *
 * Electron 启动时会把真实 HOME 存入 OPENWORK_REAL_HOME（runtime.mjs
 * buildChildEnv dev 分支）。兜底逻辑：即使该变量未设置，也从系统用户库
 * 读取真实 home（os.userInfo().homedir 读 getpwuid，不受 $HOME 覆盖影响），
 * 保证 CLI agent 始终能读到用户已登录的配置。
 * 非 dev 模式（当前 HOME 已是真实 HOME）返回 undefined，调用方合并后无副作用。
 */

import os from "node:os";

export function restoreRealHomeEnv(): Record<string, string> | undefined {
  const realHome = process.env.OPENWORK_REAL_HOME?.trim() || os.userInfo().homedir;
  if (!realHome) return undefined;
  const currentHome = process.env.HOME ?? "";
  // 当前 HOME 已是真实 HOME（非 dev 隔离）时无需覆盖
  if (currentHome === realHome) return undefined;
  return { HOME: realHome, USERPROFILE: realHome };
}

/** 把真实 HOME 覆盖合并进目标 env（homeOverride 优先于 process.env，但被显式传入的 env 覆盖保持原优先级） */
export function mergeRealHomeEnv(
  base: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const homeOverride = restoreRealHomeEnv();
  return { ...base, ...homeOverride, ...extra };
}
