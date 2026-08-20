/** Per-agent visibility policy for panel-managed MCP and subprocess tools. */
import { MODE_POLICY_PLUGIN_NAME, MODE_POLICY_ROW_ID, type PatchRow } from "./patch-editor.js";
export const name = "skill-mcp-mode-policy";
export const inject = ["tools", "agents", "agentPresets"];

export interface ModeRule {
  kind: "mcp" | "tool";
  name: string;
  modes: string[];
}

export interface Config {
  rules?: ModeRule[];
}

function selectedTarget(ctx: any, agent: any): string | undefined {
  const preset = ctx.agentPresets?.composedPreset?.(agent.ctx);
  if (preset === "security-research" && agent.session?.header?.parentSession !== undefined) {
    return "security-research-workers";
  }
  return preset;
}

function matches(rule: ModeRule, toolName: string): boolean {
  return rule.kind === "mcp"
    ? toolName.startsWith(`mcp__${rule.name}__`)
    : toolName === rule.name;
}

function allows(rule: ModeRule, target: string | undefined): boolean {
  return rule.modes.includes("*") || rule.modes.includes(target ?? "");
}

export function rulesFromRows(rows: PatchRow[]): ModeRule[] {
  const row = rows.find((candidate) => candidate.id === MODE_POLICY_ROW_ID && candidate.name === MODE_POLICY_PLUGIN_NAME);
  return validRules({ rules: Array.isArray(row?.config?.rules) ? row.config.rules as ModeRule[] : [] });
}

export function policyRow(rules: ModeRule[]): PatchRow | undefined {
  return rules.length === 0 ? undefined : {
    id: MODE_POLICY_ROW_ID,
    name: MODE_POLICY_PLUGIN_NAME,
    config: { rules }
  };
}

export function modesFor(rules: ModeRule[], kind: ModeRule["kind"], resourceName: string): string[] {
  return rules.find((rule) => rule.kind === kind && rule.name === resourceName)?.modes ?? ["*"];
}

export function replaceRule(rules: ModeRule[], previous: Pick<ModeRule, "kind" | "name"> | undefined, next: ModeRule): ModeRule[] {
  return [...rules.filter((rule) => previous === undefined || rule.kind !== previous.kind || rule.name !== previous.name), next]
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

export function removeRule(rules: ModeRule[], kind: ModeRule["kind"], resourceName: string): ModeRule[] {
  return rules.filter((rule) => rule.kind !== kind || rule.name !== resourceName);
}

function validRules(config: Config | undefined): ModeRule[] {
  return (config?.rules ?? []).filter((rule) =>
    (rule.kind === "mcp" || rule.kind === "tool")
    && typeof rule.name === "string" && rule.name.length > 0
    && Array.isArray(rule.modes) && rule.modes.every((mode) => typeof mode === "string" && mode.length > 0));
}

export function apply(ctx: any, config?: Config): void {
  const rules = validRules(config);
  const restrictions = new Map<any, () => void>();
  let stopping = false;
  let reconciling = false;

  const managedNames = () => {
    const names = ctx.tools.schemas().map((schema: any) => schema.name).filter((value: unknown): value is string => typeof value === "string");
    return names.filter((toolName: string) => rules.some((rule) => matches(rule, toolName)));
  };

  const reconcile = (agent: any) => {
    if (stopping) return;
    restrictions.get(agent)?.();
    restrictions.delete(agent);
    const target = selectedTarget(ctx, agent);
    const denied = managedNames().filter((toolName: string) =>
      rules.some((rule) => matches(rule, toolName) && !allows(rule, target)));
    if (denied.length > 0) restrictions.set(agent, agent.ctx.tools.restrict({ deny: denied }));
  };

  const reconcileAll = () => {
    if (stopping || reconciling) return;
    reconciling = true;
    try {
      for (const agent of ctx.agents.list()) reconcile(agent);
    } finally {
      reconciling = false;
    }
  };

  ctx.on("agent/created", ({ agent }: any) => reconcile(agent));
  ctx.on("agent/disposed", ({ agent }: any) => {
    restrictions.get(agent)?.();
    restrictions.delete(agent);
  });
  ctx.on("agent-preset/selected", (sessionId: string) => {
    const agent = ctx.agents.list().find((candidate: any) => candidate.session?.id === sessionId);
    if (agent !== undefined) reconcile(agent);
  });
  ctx.on("tools/change", reconcileAll);
  ctx.tools.guard((exec: any) => {
    if (exec.agent === undefined) return undefined;
    const target = selectedTarget(ctx, exec.agent);
    const denied = rules.some((rule) => matches(rule, exec.name) && !allows(rule, target));
    return denied ? `tool ${JSON.stringify(exec.name)} is not enabled for mode ${JSON.stringify(target ?? "unknown")}` : undefined;
  });
  ctx.on("security-research/worker-tools", ({ tools }: any) => {
    for (const rule of rules) {
      if (!rule.modes.includes("security-research-workers")) continue;
      for (const schema of ctx.tools.schemas()) {
        if (typeof schema?.name === "string" && matches(rule, schema.name)) tools.add(schema.name);
      }
    }
  });
  reconcileAll();
  ctx.effect(() => () => {
    stopping = true;
    const disposers = [...restrictions.values()];
    restrictions.clear();
    for (const dispose of disposers) dispose();
  }, "skill-mcp-mode-policy.restrictions");
}
