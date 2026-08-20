/**
 * dsh-skill-mcp-panel —— MCP 宿主服务（mcpManager）。
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { MCP_PLUGIN_NAME, MODE_POLICY_ROW_ID, SUBPROCESS_ADAPTER_PLUGIN_NAME, extractManagedRows, listMcpPatchRows, listSubprocessAdapterRows, readPatchFile, writeManagedRows } from "../patch-editor.js";
import { applyServerEdit, inputFromPatchRow, patchRowToView, serverNameFromRowId } from "./model.js";
import { mcpRemovePayloadSchema, mcpSavePayloadSchema, mcpSetEnabledPayloadSchema, mcpTestPayloadSchema, toolRemovePayloadSchema, toolSavePayloadSchema, toolSetEnabledPayloadSchema, toolTestPayloadSchema } from "./wire.js";
import { fiberPhaseOf, getLoaderEntry, mcpToolCount, waitForLoaderState } from "./status.js";
import { probeMcpServer } from "./probe.js";
import { modesFor, policyRow, removeRule, replaceRule, rulesFromRows } from "../mode-policy.js";
import { applyToolEdit, toolInputFromRow, toolNameFromRowId, toolRowToView } from "../tool/model.js";
import { probeSubprocessTool } from "../tool/probe.js";
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map((item) => stripUndefined(item));
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            out[key] = stripUndefined(item);
        }
        return out;
    }
    return value;
}
const MANAGED_ROW_IDS = new Set();
function isManagedRow(row) {
    return typeof row.id === "string" && (row.id.startsWith("panel-mcp-") || row.id.startsWith("panel-tool-"));
}
export class McpManagerGateway extends TypertRemoteService {
    constructor(ctx) {
        super(ctx, "mcpManager");
    }
    get C() {
        return this.ctx;
    }
    patchPath() {
        const base = this.C.baseUrl;
        if (typeof base === "string" && base.length > 0) {
            try {
                const url = new URL(base);
                if (url.protocol === "file:")
                    return join(fileURLToPath(url), "cordis.patch.yml");
            }
            catch {
                // fall through to package-location fallback
            }
        }
        const packageDir = fileURLToPath(new URL("../../", import.meta.url));
        return join(resolve(packageDir, "../.."), "cordis.patch.yml");
    }
    async readRows() {
        const path = this.patchPath();
        const raw = await readPatchFile(path);
        const managed = extractManagedRows(raw);
        const managedMcp = managed.filter((row) => row.name === MCP_PLUGIN_NAME);
        const managedTools = managed.filter((row) => row.name === SUBPROCESS_ADAPTER_PLUGIN_NAME);
        const rules = rulesFromRows(managed);
        const allMcp = listMcpPatchRows(raw);
        const allTools = listSubprocessAdapterRows(raw);
        const managedIds = new Set(managed.map((row) => row.id).filter((id) => typeof id === "string"));
        const external = allMcp.filter((row) => typeof row.id !== "string" || !managedIds.has(row.id));
        const externalTools = allTools.filter((row) => typeof row.id !== "string" || !managedIds.has(row.id));
        return { path, raw, managed, managedMcp, managedTools, rules, external, externalTools };
    }
    withRules(rows, rules) {
        const next = rows.filter((row) => row.id !== MODE_POLICY_ROW_ID);
        const policy = policyRow(rules);
        if (policy !== undefined)
            next.push(policy);
        return next;
    }
    async modes() {
        const presets = await this.C.agentPresets?.list?.() ?? [];
        const modes = presets.map((preset) => stripUndefined({
            id: preset.id,
            name: preset.name ?? preset.id,
            description: preset.description,
            trust: preset.trust,
            broken: preset.broken
        }));
        if (presets.some((preset) => preset.id === "security-research")) {
            modes.push({
                id: "security-research-workers",
                name: "安全研究执行 Worker",
                description: "Explorer、Experimenter、Challenger 与 Verifier；不包含 Coordinator、Hypothesizer 或 Synthesizer。",
                trust: "virtual"
            });
        }
        return modes;
    }
    decorate(row, managed, entry, enabled) {
        const view = patchRowToView(row);
        if (view === undefined)
            return undefined;
        const fiberPhase = fiberPhaseOf(entry?.fiber?.state);
        return stripUndefined({
            ...view,
            enabled,
            managed,
            fiberPhase,
            toolCount: enabled ? mcpToolCount(this.C, view.serverName) : 0
        });
    }
    async list() {
        let patch = { path: this.patchPath(), ok: false, error: null };
        try {
            const { path, managedMcp, managedTools, rules, external, externalTools } = await this.readRows();
            patch = { path, ok: true, error: null };
            const servers = [];
            for (const row of managedMcp) {
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                const view = this.decorate(row, true, entry, row.disabled !== true);
                if (view !== undefined)
                    servers.push({ ...view, modes: modesFor(rules, "mcp", view.serverName) });
            }
            const externalServers = [];
            for (const row of external) {
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                const view = this.decorate(row, false, entry, row.disabled !== true);
                if (view !== undefined)
                    externalServers.push(view);
            }
            const tools = managedTools.map((row) => {
                const view = toolRowToView(row);
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                return stripUndefined({ ...view, managed: true, fiberPhase: fiberPhaseOf(entry?.fiber?.state), modes: modesFor(rules, "tool", view.toolName) });
            });
            const externalToolViews = externalTools.flatMap((row) => {
                try {
                    const view = toolRowToView(row);
                    const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                    return [stripUndefined({ ...view, managed: false, fiberPhase: fiberPhaseOf(entry?.fiber?.state), modes: ["*"] })];
                }
                catch {
                    return [];
                }
            });
            return { servers, externalServers, tools, externalTools: externalToolViews, modes: await this.modes(), patch };
        }
        catch (error) {
            return { servers: [], externalServers: [], tools: [], externalTools: [], modes: [], patch: { ...patch, error: error instanceof Error ? error.message : String(error) } };
        }
    }
    findRowByServerName(rows, serverName) {
        return rows.find((row) => serverNameFromRowId(row.id) === serverName || (row.config?.serverName === serverName && isManagedRow(row)));
    }
    configInputFromRow(row) {
        return inputFromPatchRow(row);
    }
    async save(rawPayload) {
        const payload = mcpSavePayloadSchema.parse(rawPayload);
        const input = payload.input;
        const previousName = payload.previousServerName ?? input.serverName;
        const { managed, managedMcp, rules, external } = await this.readRows();
        for (const row of external) {
            const name = row.config?.serverName;
            if (name === input.serverName)
                throw new Error('serverName "' + input.serverName + '" 已被 cordis.patch.yml 中的外部 MCP 行占用，请在文件中手动处理');
        }
        for (const row of managedMcp) {
            const name = row.config?.serverName;
            if (name === input.serverName && serverNameFromRowId(row.id) !== previousName) {
                throw new Error('serverName "' + input.serverName + '" 已存在（受管行 ' + String(row.id) + "）");
            }
        }
        const previous = managedMcp.find((row) => serverNameFromRowId(row.id) === previousName || row.config?.serverName === previousName);
        if (payload.previousServerName !== undefined && previous === undefined) {
            throw new Error('要编辑的 MCP 行不存在："' + previousName + '"');
        }
        const enabled = previous !== undefined ? previous.disabled !== true : payload.enabled;
        const nextRow = applyServerEdit(previous, input, enabled);
        const nextRows = managed.filter((row) => row.name !== MCP_PLUGIN_NAME || (serverNameFromRowId(row.id) !== previousName && row.config?.serverName !== previousName));
        nextRows.push(nextRow);
        const nextRules = replaceRule(rules, payload.previousServerName === undefined ? undefined : { kind: "mcp", name: previousName }, { kind: "mcp", name: input.serverName, modes: payload.modes });
        await writeManagedRows(this.patchPath(), this.withRules(nextRows, nextRules));
        const reconciled = enabled
            ? await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, nextRow.id);
        const server = this.decorate(nextRow, true, entry, enabled);
        if (server === undefined)
            throw new Error("写入成功但生成的 MCP 行无效");
        return { server: { ...server, modes: payload.modes }, reconciled };
    }
    async removeServer(rawPayload) {
        const payload = mcpRemovePayloadSchema.parse(rawPayload);
        const { managed, managedMcp, rules } = await this.readRows();
        const row = managedMcp.find((candidate) => serverNameFromRowId(candidate.id) === payload.serverName || candidate.config?.serverName === payload.serverName);
        if (row === undefined) {
            throw new Error('MCP 行 "' + payload.serverName + '" 不存在或不是面板受管行（外部行请在 cordis.patch.yml 中手动删除）');
        }
        const nextRows = managed.filter((candidate) => candidate !== row);
        await writeManagedRows(this.patchPath(), this.withRules(nextRows, removeRule(rules, "mcp", payload.serverName)));
        const reconciled = await waitForLoaderState(this.C, row.id, (entry) => entry === undefined);
        return { ok: true, reconciled };
    }
    async setEnabled(rawPayload) {
        const payload = mcpSetEnabledPayloadSchema.parse(rawPayload);
        const { managed, managedMcp, rules } = await this.readRows();
        const row = managedMcp.find((candidate) => serverNameFromRowId(candidate.id) === payload.serverName || candidate.config?.serverName === payload.serverName);
        if (row === undefined)
            throw new Error('MCP 行 "' + payload.serverName + '" 不存在或不是面板受管行');
        row.disabled = !payload.enabled;
        await writeManagedRows(this.patchPath(), managed);
        const reconciled = payload.enabled
            ? await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, row.id);
        const server = this.decorate(row, true, entry, payload.enabled);
        if (server === undefined)
            throw new Error("写入成功但生成的 MCP 行无效");
        return { server: { ...server, modes: modesFor(rules, "mcp", payload.serverName) }, reconciled };
    }
    async test(rawPayload) {
        const payload = mcpTestPayloadSchema.parse(rawPayload);
        if (payload !== null && typeof payload === "object" && !("transport" in payload) && "serverName" in payload) {
            const { managedMcp, external } = await this.readRows();
            const row = [...managedMcp, ...external].find((candidate) => candidate.config?.serverName === payload.serverName || serverNameFromRowId(candidate.id) === payload.serverName);
            if (row === undefined)
                throw new Error('MCP 行 "' + String(payload.serverName) + '" 不存在');
            return probeMcpServer(this.configInputFromRow(row));
        }
        return probeMcpServer(payload);
    }
    async saveTool(rawPayload) {
        const payload = toolSavePayloadSchema.parse(rawPayload);
        const previousName = payload.previousToolName ?? payload.input.toolName;
        const { managed, managedTools, rules, externalTools } = await this.readRows();
        if (externalTools.some((row) => row.config?.toolName === payload.input.toolName))
            throw new Error(`toolName ${JSON.stringify(payload.input.toolName)} 已被外部 adapter 行占用`);
        if (managedTools.some((row) => row.config?.toolName === payload.input.toolName && row.config?.toolName !== previousName))
            throw new Error(`toolName ${JSON.stringify(payload.input.toolName)} 已存在`);
        const previous = managedTools.find((row) => toolNameFromRowId(row.id) === previousName || row.config?.toolName === previousName);
        if (payload.previousToolName !== undefined && previous === undefined)
            throw new Error(`要编辑的适配工具不存在：${JSON.stringify(previousName)}`);
        const nextRow = applyToolEdit(previous, payload.input, payload.enabled);
        const nextRows = managed.filter((row) => row.name !== SUBPROCESS_ADAPTER_PLUGIN_NAME || (toolNameFromRowId(row.id) !== previousName && row.config?.toolName !== previousName));
        nextRows.push(nextRow);
        const nextRules = replaceRule(rules, payload.previousToolName === undefined ? undefined : { kind: "tool", name: previousName }, { kind: "tool", name: payload.input.toolName, modes: payload.modes });
        await writeManagedRows(this.patchPath(), this.withRules(nextRows, nextRules));
        const enabled = nextRow.disabled !== true;
        const reconciled = enabled
            ? await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, nextRow.id);
        return { tool: stripUndefined({ ...toolRowToView(nextRow), managed: true, fiberPhase: fiberPhaseOf(entry?.fiber?.state), modes: payload.modes }), reconciled };
    }
    async removeTool(rawPayload) {
        const payload = toolRemovePayloadSchema.parse(rawPayload);
        const { managed, managedTools, rules } = await this.readRows();
        const row = managedTools.find((candidate) => toolNameFromRowId(candidate.id) === payload.toolName || candidate.config?.toolName === payload.toolName);
        if (row === undefined)
            throw new Error(`适配工具 ${JSON.stringify(payload.toolName)} 不存在或不是面板受管行`);
        await writeManagedRows(this.patchPath(), this.withRules(managed.filter((candidate) => candidate !== row), removeRule(rules, "tool", payload.toolName)));
        return { ok: true, reconciled: await waitForLoaderState(this.C, row.id, (entry) => entry === undefined) };
    }
    async setToolEnabled(rawPayload) {
        const payload = toolSetEnabledPayloadSchema.parse(rawPayload);
        const { managed, managedTools, rules } = await this.readRows();
        const row = managedTools.find((candidate) => toolNameFromRowId(candidate.id) === payload.toolName || candidate.config?.toolName === payload.toolName);
        if (row === undefined)
            throw new Error(`适配工具 ${JSON.stringify(payload.toolName)} 不存在或不是面板受管行`);
        row.disabled = !payload.enabled;
        await writeManagedRows(this.patchPath(), managed);
        const reconciled = payload.enabled
            ? await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, row.id);
        return { tool: stripUndefined({ ...toolRowToView(row), managed: true, fiberPhase: fiberPhaseOf(entry?.fiber?.state), modes: modesFor(rules, "tool", payload.toolName) }), reconciled };
    }
    async testTool(rawPayload) {
        const payload = toolTestPayloadSchema.parse(rawPayload);
        if ("input" in payload)
            return probeSubprocessTool(this.C, payload.input, payload.target);
        const { managedTools, externalTools } = await this.readRows();
        const row = [...managedTools, ...externalTools].find((candidate) => candidate.config?.toolName === payload.toolName || toolNameFromRowId(candidate.id) === payload.toolName);
        if (row === undefined)
            throw new Error(`适配工具 ${JSON.stringify(payload.toolName)} 不存在`);
        return probeSubprocessTool(this.C, toolInputFromRow(row), payload.target);
    }
    reload() {
        return this.list();
    }
}
// 供 CLI 复用：判断一个 patch 行是否由面板管理。
export { MANAGED_ROW_IDS, isManagedRow, MCP_PLUGIN_NAME };
