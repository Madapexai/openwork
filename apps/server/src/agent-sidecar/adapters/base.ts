/**
 * BaseSidecarAdapter - 公共逻辑
 *
 * 提供 detect / doctor 的默认实现，子类只需 override 必要方法。
 * 借鉴 cc-connect 的 agent doctor 机制。
 */

import type {
  AgentDetectResult,
  AgentDoctorInfo,
  AgentSidecarAdapter,
  AgentSidecarConfig,
  SidecarCapabilities,
  SidecarHandle,
  SidecarStartOptions,
} from "../types.js";
import { detectAgent } from "../detect.js";
import { AGENT_PRESETS } from "../presets.js";

export abstract class BaseSidecarAdapter implements AgentSidecarAdapter {
  abstract readonly protocol: AgentSidecarConfig["protocol"];

  constructor(protected readonly config: AgentSidecarConfig) {}

  get agentId(): string {
    return this.config.agentId;
  }

  get displayName(): string {
    return this.config.displayName ?? this.config.agentId;
  }

  get capabilities(): SidecarCapabilities | undefined {
    return this.config.capabilities;
  }

  abstract start(options: SidecarStartOptions): Promise<SidecarHandle>;

  async detect(): Promise<AgentDetectResult> {
    // 优先用 preset（包含完整 binary/args），fallback 到 config 自身的 binary
    const preset = AGENT_PRESETS[this.config.agentId];
    if (preset) {
      return detectAgent(preset);
    }
    // 自定义 agentId：用 config 字段构造一个类 preset 对象
    return detectAgent({
      agentId: this.config.agentId,
      binary: this.config.binary,
      binaryPath: this.config.binaryPath,
    });
  }

  async doctor(): Promise<AgentDoctorInfo> {
    const detection = await this.detect();
    const checks: AgentDoctorInfo["checks"] = [
      {
        name: "binary-exists",
        ok: detection.available,
        detail: detection.binaryPath ?? detection.error,
      },
    ];
    if (detection.version) {
      checks.push({
        name: "version-probe",
        ok: true,
        detail: `v${detection.version}`,
      });
    }
    return {
      agentId: this.config.agentId,
      healthy: detection.available,
      binaryName: this.config.binary ?? "",
      binaryPath: detection.binaryPath,
      checks,
    };
  }
}
