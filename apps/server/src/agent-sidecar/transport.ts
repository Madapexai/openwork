/**
 * TransportInfo 构建工具
 *
 * 复用 managed-opencode.ts 的脱敏逻辑（SECRET_ENV_PATTERN）
 */

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

export interface TransportEnvEntry {
  name: string;
  value: string;
  redacted: boolean;
}

/**
 * 构造 TransportInfo 用的 env 数组（脱敏后）
 *
 * - 自动按 SECRET_ENV_PATTERN 脱敏（TOKEN/PASSWORD/USERNAME/AUTH/SECRET/KEY/CREDENTIAL）
 * - 通过 extraSecrets 额外指定的名称无论模式如何都会脱敏
 */
export function buildTransportEnv(
  env: Record<string, string | undefined>,
  extraSecrets: string[] = [],
): TransportEnvEntry[] {
  const secretSet = new Set(
    [...Object.keys(env)].filter((k) => SECRET_ENV_PATTERN.test(k)),
  );
  // extraSecrets 直接加入，不要求匹配模式
  for (const name of extraSecrets) secretSet.add(name);
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: secretSet.has(name) ? "<redacted>" : value,
      redacted: secretSet.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 检测一个环境变量名是否敏感
 */
export function isSecretEnv(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}
