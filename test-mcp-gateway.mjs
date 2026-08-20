import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { McpManagerGateway } from "./lib/mcp/gateway.js";
import { mcpListResultSchema } from "./lib/mcp/wire.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const dir = await mkdtemp(join(tmpdir(), "dsh-panel-gateway-"));
try {
  await writeFile(join(dir, "cordis.patch.yml"), "# profile\n[]\n");
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(dir).href + "/";
  ctx.provide("loader", {
    entries: function* () {
      yield { id: "panel-mcp-demo", disabled: true, fiber: undefined, options: { name: "@deepseek-ai/dsh-mcp-client" } };
      yield { id: "panel-tool-jsfinder", disabled: true, fiber: undefined, options: { name: "@deepseek-ai/dsh-tool-subprocess-adapter" } };
    }
  });
  ctx.provide("tools", {
    schemas() {
      return [];
    }
  });
  ctx.provide("agentPresets", {
    list() {
      return [{ id: "web", name: "标准模式" }, { id: "security-research", name: "安全研究" }];
    }
  });
  ctx.provide("subprocess", {
    spawn() {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: "ok" }) },
          stderr: { readFrom: () => ({ text: "" }) }
        },
        done: Promise.resolve({ exitCode: 0, signal: null })
      };
    }
  });
  const gateway = new McpManagerGateway(ctx);

  // 1. list empty
  const empty = await gateway.list();
  assert.equal(empty.patch.ok, true);
  assert.equal(empty.servers.length, 0);
  assert.equal(empty.externalServers.length, 0);
  assert.equal(empty.tools.length, 0);
  assert.equal(empty.modes.some((mode) => mode.id === "security-research-workers"), true);
  pass("gateway lists empty patch");

  // 2. save disabled row (fake loader already reports matching entry)
  const saved = await gateway.save({
    input: { serverName: "demo", transport: "stdio", command: "node" },
    modes: ["web"],
    enabled: false
  });
  assert.equal(saved.server.serverName, "demo");
  assert.equal(saved.server.enabled, false);
  assert.equal(saved.server.toolCount, 0);
  assert.deepEqual(saved.server.modes, ["web"]);
  assert.equal(saved.reconciled, true);
  const onDisk = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.match(onDisk, /panel-mcp-demo/);
  assert.match(onDisk, /serverName: demo/);
  pass("gateway save writes managed block and decorates row");

  // 3. list sees managed row
  const after = await gateway.list();
  assert.equal(after.servers.length, 1);
  assert.equal(after.servers[0].serverName, "demo");
  assert.equal(after.servers[0].fiberPhase, null);
  assert.deepEqual(after.servers[0].modes, ["web"]);
  const parsed = mcpListResultSchema.parse(after);
  assert.equal(JSON.stringify(parsed).includes("undefined"), false);
  assert.equal(JSON.stringify(parsed).includes("url"), false); // stdio view must not carry undefined optional fields
  pass("gateway list validates at the Typert JSON boundary");

  // 4. save a subprocess adapter row without deleting MCP or policy rows
  const toolSaved = await gateway.saveTool({
    input: { toolName: "jsfinder", description: "Discover endpoints", command: "node", args: ["runner.mjs"] },
    modes: ["web", "security-research-workers"],
    enabled: false
  });
  assert.equal(toolSaved.tool.toolName, "jsfinder");
  assert.equal(toolSaved.tool.enabled, false);
  assert.equal(toolSaved.reconciled, true);
  const mixed = await gateway.list();
  assert.equal(mixed.servers.length, 1);
  assert.equal(mixed.tools.length, 1);
  assert.deepEqual(mixed.tools[0].modes, ["web", "security-research-workers"]);
  pass("gateway preserves mixed MCP, adapter, and mode-policy rows");

  // 5. quick verification uses the subprocess service and reports real status
  const probe = await gateway.testTool({ toolName: "jsfinder", target: "https://example.com" });
  assert.equal(probe.ok, true);
  assert.equal(probe.stdout, "ok");
  pass("gateway probes an adapted tool through subprocess");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL MCP GATEWAY TESTS PASSED");
