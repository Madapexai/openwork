import type { DynamicToolUIPart, JSONValue, ProviderMetadata, TextUIPart } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";

import { safeStringify } from "@/app/utils";
import { normalizeErrorText } from "@/lib/error-text";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JSONValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 4_096 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length <= 4_096 && entries.every((entry) => isJsonValue(entry, depth + 1));
}

function toolCallProviderMetadata(part: ToolPart): ProviderMetadata {
  const stateMetadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {};
  const mcpResult = isJsonValue(stateMetadata.openworkMcpResult)
    ? stateMetadata.openworkMcpResult
    : isJsonValue(stateMetadata.openworkMcpApp)
      ? stateMetadata.openworkMcpApp
      : null;
  return {
    opencode: { partId: part.id },
    ...(mcpResult ? { openwork: { mcpResult } } : {}),
  };
}

function shouldDeferInProgressTool(part: ToolPart) {
  if (part.state.status === "completed" || part.state.status === "error") {
    return false;
  }

  return Object.keys(part.state.input).length === 0;
}

export function parseStructuredOutputUIPart(part: ToolPart): TextUIPart | null {
  if (part.state.status === "error") {
    return null;
  }

  const text = safeStringify(part.state.input);

  if (text === "{}" && part.state.status !== "completed") {
    return null;
  }

  return {
    type: "text",
    text,
    state: part.state.status === "completed" ? "done" : "streaming",
    providerMetadata: { opencode: { partId: `structured-output-${part.callID}`, toolPartId: part.id } },
  };
}

export function parseDynamicToolUIPart(part: ToolPart): DynamicToolUIPart | null {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    return null;
  }

  if (part.state.status === "error") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-error",
      input: part.state.input,
      errorText: normalizeErrorText(part.state.error).display,
      callProviderMetadata: toolCallProviderMetadata(part),
    };
  }

  if (part.state.status === "completed") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-available",
      input: part.state.input,
      output: part.state.output,
      callProviderMetadata: toolCallProviderMetadata(part),
    };
  }

  // OpenCode emits pending/running tool parts with `{}` input before args
  // (e.g. filePath) are filled in. Skip UI until the next part.updated.
  if (shouldDeferInProgressTool(part)) {
    return null;
  }

  return {
    type: "dynamic-tool",
    toolName: part.tool,
    toolCallId: part.callID,
    state: "input-streaming",
    input: part.state.input,
    callProviderMetadata: toolCallProviderMetadata(part),
  };
}
