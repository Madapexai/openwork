/**
 * Surface 能力错误（openspec-surface-abstraction.md）
 *
 * 调用方在不支持的能力上调用方法时抛出；让 agent 侧能 fail-fast 降级，
 * 而不是默默吞掉。
 */

/**
 * Surface 不支持某能力时抛出
 */
export class SurfaceCapabilityError extends Error {
  constructor(surfaceId: string, capability: string, message?: string) {
    super(`Surface '${surfaceId}' does not support '${capability}'${message ? `: ${message}` : ""}`);
    this.name = "SurfaceCapabilityError";
  }
}

/**
 * 方法尚未实现（占位 surface / 未完成迁移）
 */
export class NotImplementedError extends Error {
  constructor(method: string, surfaceId: string) {
    super(`Method '${method}' not implemented for surface '${surfaceId}'`);
    this.name = "NotImplementedError";
  }
}