/** Configuration model for one official subprocess adapter row. */
import { z } from "zod";
import {
  MANAGED_TOOL_ROW_ID_PREFIX,
  SUBPROCESS_ADAPTER_PLUGIN_NAME,
  type PatchRow
} from "../patch-editor.js";

export const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const subprocessToolInputSchema = z.object({
  toolName: z.string().regex(TOOL_NAME_RE, "toolName 必须是 1-64 位字母、数字、下划线或连字符，且不能以数字开头"),
  description: z.string().trim().min(1),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  failureText: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).default(15000),
  outputMaxBytes: z.number().int().min(1).default(65536),
  graceMs: z.number().int().min(1).default(2000)
});

export type SubprocessToolInput = z.infer<typeof subprocessToolInputSchema>;

export function toolRowId(toolName: string): string {
  return MANAGED_TOOL_ROW_ID_PREFIX + toolName;
}

export function toolNameFromRowId(id: string | undefined): string | undefined {
  if (typeof id !== "string" || !id.startsWith(MANAGED_TOOL_ROW_ID_PREFIX)) return undefined;
  const value = id.slice(MANAGED_TOOL_ROW_ID_PREFIX.length);
  return TOOL_NAME_RE.test(value) ? value : undefined;
}

export function toToolPatchRow(input: SubprocessToolInput, enabled = true): PatchRow {
  return {
    id: toolRowId(input.toolName),
    name: SUBPROCESS_ADAPTER_PLUGIN_NAME,
    ...(enabled ? {} : { disabled: true }),
    config: { ...input }
  };
}

export function toolInputFromRow(row: PatchRow): SubprocessToolInput {
  if (row.name !== SUBPROCESS_ADAPTER_PLUGIN_NAME) throw new Error("不是 subprocess adapter 行");
  return subprocessToolInputSchema.parse(row.config ?? {});
}

export function toolRowToView(row: PatchRow) {
  const input = toolInputFromRow(row);
  return { ...input, enabled: row.disabled !== true, entryId: row.id };
}

export function applyToolEdit(previous: PatchRow | undefined, input: SubprocessToolInput, enabled = true): PatchRow {
  if (previous === undefined) return toToolPatchRow(input, enabled);
  return toToolPatchRow(input, previous.disabled !== true);
}
