/**
 * Surface Registry（openspec-surface-abstraction.md）
 *
 * 注册所有可用 Surface，按 kind / destination 路由。
 *
 * 不变量：
 * I1: surfaceId 全局唯一（重复注册 -> 抛错，fail-fast）
 * I2: resolveForDestination 仅返回 kind 与 destination 匹配的 surface
 */

import type { Surface, SurfaceDestination, SurfaceKind } from "./types.js";

export interface SurfaceRegistry {
  /** 注册一个 surface（surfaceId 重复时抛错） */
  register(surface: Surface): void;
  /** 按 kind 查询 */
  getByKind(kind: SurfaceKind): Surface | null;
  /** 按 destination 路由到合适的 surface */
  resolveForDestination(destination: SurfaceDestination): Surface | null;
  /** 列出所有已注册 surface */
  list(): readonly Surface[];
}

export function createSurfaceRegistry(): SurfaceRegistry {
  const byId = new Map<string, Surface>();
  const byKind = new Map<SurfaceKind, Surface>();

  return {
    register(surface) {
      if (byId.has(surface.surfaceId)) {
        throw new Error(`Surface already registered: ${surface.surfaceId}`);
      }
      byId.set(surface.surfaceId, surface);
      // 后注册的同类 surface 覆盖前者（last-wins），便于热替换
      byKind.set(surface.kind, surface);
    },

    getByKind(kind) {
      return byKind.get(kind) ?? null;
    },

    resolveForDestination(destination) {
      // destination.extension.surfaceKind 优先（平台特化指定）
      const ext = destination.extension as { surfaceKind?: SurfaceKind } | undefined;
      if (ext?.surfaceKind) {
        const s = byKind.get(ext.surfaceKind);
        if (s) return s;
      }
      // 回退：按 destination.type 启发式映射
      // openwork-chat 通道类型只有一种，默认返回 openwork-chat surface
      // 其他 surface 由调用方通过 extension.surfaceKind 显式指定
      return byKind.get("openwork-chat") ?? null;
    },

    list() {
      return [...byId.values()];
    },
  };
}