import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, shimBin, writeExecutable } from "./fixtures.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function server(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "index.mjs")], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim().split("\n").filter(Boolean).map(JSON.parse)) : reject(new Error(`exit ${code}: ${output}`)));
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  });
}

test("JSON-RPC initialize, list, ping, and unknown method responses are forwarded", async () => {
  const replies = await server([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    { jsonrpc: "2.0", id: 4, method: "nope" },
  ]);
  assert.equal(replies[0].result.serverInfo.name, "site-motion-capture");
  assert.equal(replies[1].result.tools.length, 2);
  assert.deepEqual(replies[2].result, {});
  assert.equal(replies[3].error.code, -32601);
});

test("capture arguments are forwarded to fake Vast/SSH/SCP shims", async () => {
  const bin = await shimBin();
  const out = await tempDir("site-motion-output-");
  const calls = join(bin, "calls");
  await writeExecutable(bin, "ssh", `
const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(process.argv.join(" ").includes("capture.mjs") ? "fixture\\n" : "");
`);
  await writeExecutable(bin, "scp", `
const fs = require("node:fs"); const dest = process.argv.at(-1);
if (dest.endsWith(".jank.json")) fs.writeFileSync(dest, JSON.stringify({ consent: { action: "rejected" } }));
else fs.writeFileSync(dest, "webm");
`);
  const replies = await server([{ jsonrpc: "2.0", id: 8, method: "tools/call", params: {
    name: "capture_site_motion", arguments: { url: "https://example.test", name: "forwarded", output_dir: out,
      consent_mode: "none", consent_selector: "#custom", scroll_distance: 7, scroll_step: 3, gpu: false },
  } }], { PATH: `${bin}:${process.env.PATH}`, SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22" });
  assert.equal(replies[0].id, 8);
  assert.equal(replies[0].result.content[0].type, "text");
  const callsText = await (await import("node:fs/promises")).readFile(calls, "utf8");
  assert.match(callsText, /'--consent-mode' 'none'/);
  assert.match(callsText, /'--consent-selector' '#custom'/);
  assert.match(callsText, /'--scroll-distance' '7'/);
  assert.match(callsText, /'--scroll-step' '3'/);
  assert.match(callsText, /--consent-budget-ms' '8000'/);
});

test("bridge protects existing outputs unless overwrite is explicit", async () => {
  const out = await tempDir("site-motion-existing-");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(out, "protected.webm"), "existing");
  const replies = await server([{ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
    name: "capture_site_motion", arguments: { url: "https://example.test", name: "protected", output_dir: out },
  } }], { SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22" });
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /set overwrite=true/);
});

test("remote timeout/error propagation attempts PID termination cleanup", async () => {
  const bin = await shimBin();
  const calls = join(bin, "cleanup-calls");
  await writeExecutable(bin, "ssh", `
const fs = require("node:fs"); const arg = process.argv.at(-1); fs.appendFileSync(${JSON.stringify(calls)}, arg + "\\n");
if (arg.includes("capture.mjs")) process.exit(124);
`);
  const replies = await server([{ jsonrpc: "2.0", id: 10, method: "tools/call", params: {
    name: "capture_site_motion", arguments: { url: "https://example.test", name: "timeout-cleanup", output_dir: await tempDir("site-motion-timeout-") },
  } }], { PATH: `${bin}:${process.env.PATH}`, SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22" });
  assert.equal(replies[0].result.isError, true);
  const cleanupLog = await (await import("node:fs/promises")).readFile(join(bin, "cleanup-calls"), "utf8");
  assert.match(cleanupLog, /pid/);
  assert.equal(cleanupLog.includes("kill-TERM") || cleanupLog.includes("kill -TERM"), true);
});
