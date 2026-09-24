import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, shimBin, writeExecutable } from "./fixtures.mjs";
import { captureCellShimSource } from "./capture-cell-fixtures.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function server(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "index.mjs")], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
      } else {
        reject(new Error(`exit ${code}: ${output}`));
      }
    });
    const input = messages.map((m) => {
      if (typeof m === "string") return m;
      const params = m?.params;
      if (params?.name !== "capture_site_motion" || !params.arguments || typeof params.arguments !== "object" || params.arguments.gpu !== undefined) return JSON.stringify(m);
      return JSON.stringify({ ...m, params: { ...params, arguments: { gpu: false, ...params.arguments } } });
    }).join("\n") + "\n";
    child.stdin.end(input);
  });
}

test("check_capture_gpu tool returns GPU details and Chromium WebGL renderer", async () => {
  const bin = await shimBin();
  await writeExecutable(bin, "ssh", `
const arg = process.argv.join(" ");
if (arg.includes("nvidia-smi")) {
  process.stdout.write("NVIDIA RTX 4090, 24576 MiB, 550.54.14\\n");
} else if (arg.includes("check-gpu-renderer.mjs")) {
  process.stdout.write("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)\\n");
} else {
  process.stdout.write("ok\\n");
}
`);

  const replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "check_capture_gpu", arguments: {} },
      },
    ],
    {
      PATH: `${bin}:${process.env.PATH}`,
      SITE_MOTION_SSH_URL: "ssh://customuser@gpu.fixture.test:22022",
    }
  );

  assert.equal(replies[0].id, 101);
  assert.equal(replies[0].result.content[0].type, "text");
  const data = JSON.parse(replies[0].result.content[0].text);
  assert.match(data.gpu, /RTX 4090/);
  assert.match(data.chromiumWebgl, /ANGLE/);
});

test("unknown tool returns errorResult", async () => {
  const replies = await server([
    {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    },
  ]);
  assert.equal(replies[0].id, 102);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /Unknown tool: nonexistent_tool/);
});

test("server ignores invalid JSON lines and messages without id", async () => {
  const replies = await server([
    "   ",
    "{ invalid json }",
    123,
    JSON.stringify({ jsonrpc: "2.0", method: "notification_without_id" }),
    JSON.stringify({ jsonrpc: "2.0", id: 103, method: "ping" }),
  ]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 103);
});

test("validates capture input options comprehensively", async () => {
  const out = await tempDir("validate-input-");

  // Non-object input
  let replies = await server([
    {
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: "not-an-object" },
    },
  ]);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /must be an object/);

  // Missing or invalid url
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 203,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: { url: "not-a-valid-url" } },
    },
    {
      jsonrpc: "2.0",
      id: 204,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: { url: "ftp://example.com" } },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /url is required/);
  assert.match(replies[1].result.content[0].text, /valid HTTP or HTTPS URL/);
  assert.match(replies[2].result.content[0].text, /must use http:\/\/ or https:\/\//);

  // Invalid name
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 205,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", name: "-invalid-start-dash" },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /name must contain/);

  // Invalid integer options
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 206,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", width: 50 },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /width must be an integer/);

  // Invalid boolean options
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 207,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", gpu: "true" },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /gpu must be true or false/);

  // Invalid consent_mode
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 208,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", consent_mode: "unsupported" },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /consent_mode must be reject, accept, none, or granular/);

  // Granular consent mode without required selectors
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 209,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", consent_mode: "granular" },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /granular consent_mode requires/);

  // Accept consent mode without approval
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 210,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", consent_mode: "accept", consent_accept_approved: false },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /accept consent_mode requires explicit/);

  // Excessively long string selector
  replies = await server([
    {
      jsonrpc: "2.0",
      id: 211,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", hover_selector: "x".repeat(301) },
      },
    },
  ]);
  assert.match(replies[0].result.content[0].text, /hover_selector must be a non-empty string of at most 300 characters/);
});

test("SSH connection endpoint parsing and resolution", async () => {
  // Invalid SSH URL
  let replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 301,
        method: "tools/call",
        params: { name: "check_capture_gpu", arguments: {} },
      },
    ],
    { SITE_MOTION_SSH_URL: "invalid-url" }
  );
  assert.equal(replies[0].result.structuredContent.reasonCode, "capture-worker-malformed-url");
  assert.match(replies[0].result.content[0].text, /not a valid ssh:\/\/ URL/);

  // Non-SSH protocol URL
  replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 302,
        method: "tools/call",
        params: { name: "check_capture_gpu", arguments: {} },
      },
    ],
    { SITE_MOTION_SSH_URL: "https://example.com:22" }
  );
  assert.equal(replies[0].result.structuredContent.reasonCode, "capture-worker-malformed-url");
  assert.match(replies[0].result.content[0].text, /must use ssh:\/\/user@host:port/);

  // Vast CLI resolution failure
  const bin = await shimBin();
  await writeExecutable(bin, "vastai", `
if (process.argv.includes("fail")) {
  process.exit(1);
} else {
  process.stdout.write("no-ssh-endpoint-found\\n");
}
`);

  replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 303,
        method: "tools/call",
        params: { name: "check_capture_gpu", arguments: {} },
      },
    ],
    { PATH: `${bin}:${process.env.PATH}`, VAST_INSTANCE_ID: "fail" }
  );
  assert.equal(replies[0].result.structuredContent.reasonCode, "capture-worker-unavailable");

  replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 304,
        method: "tools/call",
        params: { name: "check_capture_gpu", arguments: {} },
      },
    ],
    { PATH: `${bin}:${process.env.PATH}`, VAST_INSTANCE_ID: "stale-instance" }
  );
  assert.equal(replies[0].result.structuredContent.reasonCode, "capture-worker-unavailable");
  assert.equal(replies[0].result.isError, true);
});

test("worker configuration is required and has structured blocked errors", async () => {
  const replies = await server([
    { jsonrpc: "2.0", id: 305, method: "tools/call", params: { name: "check_capture_gpu", arguments: {} } },
  ], { SITE_MOTION_SSH_URL: "", VAST_INSTANCE_ID: "" });
  assert.equal(replies[0].result.isError, true);
  assert.equal(replies[0].result.structuredContent.status, "blocked");
  assert.equal(replies[0].result.structuredContent.reasonCode, "capture-worker-unconfigured");
  assert.doesNotMatch(replies[0].result.content[0].text, /48790763/);
});

test("SIGTERM cancels a pending worker resolution", async () => {
  const bin = await shimBin();
  const started = join(bin, "vastai-started");
  await writeExecutable(bin, "vastai", `
require("node:fs").writeFileSync(${JSON.stringify(started)}, "started");
setTimeout(() => {}, 5000);
`);
  const child = spawn(process.execPath, [join(root, "index.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SITE_MOTION_SSH_URL: "",
      VAST_INSTANCE_ID: "fixture",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  let output = "";
  const replyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not return a cancellation response")), 2000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find(Boolean);
      if (!line) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line));
    });
    child.once("error", reject);
  });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 306,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: { url: "https://example.test", gpu: false } },
    })}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(started);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await stat(started);
    child.kill("SIGTERM");
    const reply = await replyPromise;
    child.stdin.end();
    const code = await closePromise;
    assert.equal(code, 0);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /Capture was cancelled/);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    child.stdin.destroy();
    let cleanupTimeout;
    await Promise.race([
      closePromise,
      new Promise((resolve) => { cleanupTimeout = setTimeout(resolve, 1000); }),
    ]);
    clearTimeout(cleanupTimeout);
  }
});

test("lock conflict reports capture_target_busy", async () => {
  const out = await tempDir("lock-test-");
  await mkdir(join(out, ".test-busy.capture.lock"));

  const replies = await server([
    {
      jsonrpc: "2.0",
      id: 401,
      method: "tools/call",
      params: {
        name: "capture_site_motion",
        arguments: { url: "https://example.test", name: "test-busy", output_dir: out },
      },
    },
  ], { SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22" });
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /capture_target_busy/);
});

test("validates manifest and output transfer with correct sha256 checksums", async () => {
  const bin = await shimBin();
  const out = await tempDir("manifest-test-");
  await writeExecutable(bin, "ffprobe", `process.stdout.write(JSON.stringify({ format: { format_name: "matroska,webm", duration: "1.0" }, streams: [{ codec_type: "video" }] }));`);

  await writeExecutable(bin, "ssh", `
const arg = process.argv.join(" ");
process.stdout.write("long output " + "a".repeat(4500) + "\\n");
`);

  await writeExecutable(bin, "scp", captureCellShimSource({ name: "valid-run", mobile: true, consentMode: "granular" }));

  const replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 501,
        method: "tools/call",
        params: {
          name: "capture_site_motion",
          arguments: {
            url: "https://example.test",
            name: "valid-run",
            output_dir: out,
            hover_selector: ".menu-item",
            click_selector: ".cta-button",
            mobile: true,
            consent_accept_approved: true,
            consent_mode: "granular",
            consent_settings_selector: ".settings",
            consent_optional_selector: ".analytics-toggle",
            consent_save_selector: ".save-btn",
          },
        },
      },
    ],
    {
      PATH: `${bin}:${process.env.PATH}`,
      SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22",
    }
  );

  assert.equal(replies[0].id, 501);
  assert.equal(replies[0].result.content[0].type, "text");
  const data = JSON.parse(replies[0].result.content[0].text);
  assert.equal(data.cleanup, "confirmed");
  assert.equal(data.localVideoPath, join(out, "valid-run.webm"));
  assert.match(data.recorderOutput, /…$/); // Verify output trimming
});

test("detects corrupted transfer and manifest validation failures", async () => {
  const bin = await shimBin();
  const out = await tempDir("manifest-corrupt-");

  await writeExecutable(bin, "ssh", `process.stdout.write("ok\\n");`);

  // SHA-256 hash mismatch
  await writeExecutable(bin, "scp", `
const fs = require("node:fs");
const dest = process.argv.at(-1);

if (dest.endsWith("manifest.json")) {
  const stageDir = require("node:path").dirname(dest);
  const runId = stageDir.replace(/^.*\\.capture-/, "");
  const manifest = {
    runId,
    files: [
      { path: "corrupt.webm", size: 10, sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      { path: "corrupt.jank.json", size: 10, sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
    ],
  };
  fs.writeFileSync(dest, JSON.stringify(manifest));
} else {
  fs.writeFileSync(dest, "corrupt data");
}
`);

  const replies = await server(
    [
      {
        jsonrpc: "2.0",
        id: 601,
        method: "tools/call",
        params: {
          name: "capture_site_motion",
          arguments: { url: "https://example.test", name: "corrupt", output_dir: out },
        },
      },
    ],
    {
      PATH: `${bin}:${process.env.PATH}`,
      SITE_MOTION_SSH_URL: "ssh://root@fixture.test:22",
    }
  );

  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /manifest validation failed/);
});
