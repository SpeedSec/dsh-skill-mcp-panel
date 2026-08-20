import assert from "node:assert/strict";
import { apply, modesFor, policyRow, removeRule, replaceRule, rulesFromRows } from "./lib/mode-policy.js";

let rules = [];
rules = replaceRule(rules, undefined, { kind: "mcp", name: "playwright", modes: ["web"] });
rules = replaceRule(rules, undefined, { kind: "tool", name: "jsfinder", modes: ["security-research-workers", "web"] });
assert.deepEqual(modesFor(rules, "mcp", "playwright"), ["web"]);
assert.deepEqual(modesFor(rules, "mcp", "missing"), ["*"]);

const row = policyRow(rules);
assert.equal(row.name, "dsh-skill-mcp-panel/mode-policy");
assert.deepEqual(rulesFromRows([row]), rules);

rules = replaceRule(rules, { kind: "mcp", name: "playwright" }, { kind: "mcp", name: "browser", modes: ["*"] });
assert.equal(rules.some((rule) => rule.name === "playwright"), false);
assert.deepEqual(removeRule(rules, "tool", "jsfinder"), [{ kind: "mcp", name: "browser", modes: ["*"] }]);

const disposers = [];
apply({
  agentPresets: { composedPreset: () => "standard" },
  agents: { list: () => [] },
  tools: { schemas: () => [], guard: () => {} },
  on: () => {},
  effect: (callback) => disposers.push(callback()),
});
assert.equal(disposers.length, 1);
disposers[0]();

let preset = "security-research";
let disposed = 0;
const restrictions = [];
const listeners = new Map();
const agent = {
  session: { id: "session-1", header: {} },
  ctx: { tools: { restrict: (policy) => {
    restrictions.push(policy);
    return () => { disposed += 1; };
  } } },
};
apply({
  agentPresets: { composedPreset: () => preset },
  agents: { list: () => [agent] },
  tools: {
    schemas: () => [{ name: "mcp__playwright__browser_navigate" }],
    guard: () => {},
  },
  on: (event, listener) => listeners.set(event, listener),
  effect: () => {},
}, { rules: [{ kind: "mcp", name: "playwright", modes: ["standard"] }] });
assert.deepEqual(restrictions, [{ deny: ["mcp__playwright__browser_navigate"] }]);
preset = "standard";
listeners.get("agent-preset/selected")("session-1", "standard");
assert.equal(disposed, 1);
assert.equal(restrictions.length, 1);
preset = "security-research";
listeners.get("agent-preset/selected")("other-session", "security-research");
assert.equal(restrictions.length, 1);
listeners.get("agent-preset/selected")("session-1", "security-research");
assert.deepEqual(restrictions.at(-1), { deny: ["mcp__playwright__browser_navigate"] });

console.log("8 passed, 0 failed");
console.log("ALL MODE POLICY TESTS PASSED");
