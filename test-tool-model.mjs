import assert from "node:assert/strict";
import { applyToolEdit, toolInputFromRow, toolNameFromRowId, toolRowId, toolRowToView, toToolPatchRow } from "./lib/tool/model.js";

const input = {
  toolName: "jsfinder",
  description: "Discover JavaScript endpoints",
  command: "node",
  args: ["runner.mjs"],
  failureText: ["FATAL"],
  timeoutMs: 12000,
  outputMaxBytes: 32768,
  graceMs: 1000
};

assert.equal(toolRowId("jsfinder"), "panel-tool-jsfinder");
assert.equal(toolNameFromRowId("panel-tool-jsfinder"), "jsfinder");
assert.equal(toolNameFromRowId("panel-mcp-jsfinder"), undefined);

const row = toToolPatchRow(input, false);
assert.equal(row.name, "@deepseek-ai/dsh-tool-subprocess-adapter");
assert.equal(row.disabled, true);
assert.deepEqual(toolInputFromRow(row), input);
assert.equal(toolRowToView(row).enabled, false);

const edited = applyToolEdit(row, { ...input, description: "Updated" }, true);
assert.equal(edited.disabled, true);
assert.equal(edited.config.description, "Updated");

console.log("5 passed, 0 failed");
console.log("ALL TOOL MODEL TESTS PASSED");
