#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, basename } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "site-motion-capture";
const SERVER_VERSION = "1.0.0";
const INSTANCE_ID = process.env.VAST_INSTANCE_ID || "48790763";
const REMOTE_ROOT = process.env.SITE_MOTION_REMOTE_ROOT || "/workspace/site-motion-capture";
const REMOTE_OUTPUT = process.env.SITE_MOTION_REMOTE_OUTPUT || `${REMOTE_ROOT}/out`;
const DEFAULT_LOCAL_OUTPUT =
  process.env.SITE_MOTION_OUTPUT_DIR ||
  join(process.cwd(), "artifacts", "design-inspiration", "site-motion-capture");

const tools = [
  {
    name: "capture_site_motion",
    description:
      "Capture a live website on the rented Vast GPU VM. The tool rejects non-essential cookies by default, then records page load, scroll, and optional hover or click behavior. It copies the WebM video and jank report to the local output directory. Use design-inspiration first to select a reference site.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "The live HTTP or HTTPS URL to capture." },
        width: { type: "integer", minimum: 320, maximum: 3840, default: 1920 },
        height: { type: "integer", minimum: 240, maximum: 2160, default: 1080 },
        consent_mode: {
          type: "string",
          enum: ["reject", "accept", "none", "granular"],
          default: "reject",
          description: "Consent action. Reject non-essential cookies by default. Use accept only with explicit approval.",
        },
        consent_accept_approved: { type: "boolean", default: false },
        consent_settings_selector: { type: "string" },
        consent_optional_selector: { type: "string" },
        consent_save_selector: { type: "string" },
        consent_budget_ms: { type: "integer", minimum: 0, maximum: 60000, default: 8000 },
        consent_max_clicks: { type: "integer", minimum: 1, maximum: 12, default: 6 },
        consent_selector: {
          type: "string",
          description: "Optional selector for the consent control. Use this when automatic detection does not find the control.",
        },
        consent_wait_ms: { type: "integer", minimum: 0, maximum: 10000, default: 1200 },
        consent_preflight: {
          type: "boolean",
          default: true,
          description: "Use an unrecorded pass to save consent state before the recorded pass.",
        },
        name: {
          type: "string",
          description: "A short file name without a path. Use letters, numbers, dot, dash, or underscore.",
        },
        output_dir: {
          type: "string",
          description:
            "The local directory for the WebM video and jank report. Defaults to artifacts/design-inspiration/site-motion-capture in the MCP client's current workspace.",
        },
        settle_ms: { type: "integer", minimum: 0, maximum: 30000, default: 2000 },
        scroll_distance: { type: "integer", minimum: 0, maximum: 20000, default: 2500 },
        scroll_step: { type: "integer", minimum: 1, maximum: 2000, default: 100 },
        scroll_pause_ms: { type: "integer", minimum: 0, maximum: 3000, default: 80 },
        tail_lines: { type: "integer", minimum: 0, maximum: 5000, default: 800 },
        hover_selector: { type: "string", description: "A CSS selector to hover during the capture." },
        click_selector: { type: "string", description: "A CSS selector to click during the capture." },
        mobile: { type: "boolean", default: false },
        no_scroll: { type: "boolean", default: false },
        gpu: { type: "boolean", default: true },
        timeout_ms: { type: "integer", minimum: 30000, maximum: 600000, default: 180000 },
        overwrite: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "check_capture_gpu",
    description:
      "Check the NVIDIA GPU and Chromium WebGL renderer on the rented Vast GPU VM before a capture.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isSafeRemoteRunDir(value) {
  return new RegExp(`^${REMOTE_OUTPUT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/runs/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value);
}

function run(command, args, { timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      finish(new Error(`${command} timed out after ${timeoutMs} ms`), 124);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error, 1));
    child.on("close", (code, signal) => {
      if (signal) {
        finish(new Error(`${command} stopped with signal ${signal}`), 1);
      } else if (code === 0) {
        finish(null, 0);
      } else {
        finish(new Error(`${command} exited with code ${code}${stderr ? `: ${trimOutput(stderr)}` : ""}`), code);
      }
    });

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ error, code, stdout, stderr });
    }
  });
}

function trimOutput(value) {
  const text = String(value).trim();
  return text.length > 4000 ? `${text.slice(-4000)}…` : text;
}

async function resolveConnection() {
  const explicitUrl = process.env.SITE_MOTION_SSH_URL;
  if (explicitUrl) return parseSshUrl(explicitUrl);

  const explicitHost = process.env.SITE_MOTION_SSH_HOST;
  const explicitPort = process.env.SITE_MOTION_SSH_PORT;
  if (explicitHost && explicitPort) {
    return {
      user: process.env.SITE_MOTION_SSH_USER || "root",
      host: explicitHost,
      port: explicitPort,
    };
  }

  const result = await run("vastai", ["ssh-url", INSTANCE_ID], { timeoutMs: 30000 });
  if (result.error) {
    throw new Error(`Could not resolve the Vast SSH endpoint for instance ${INSTANCE_ID}. ${result.error.message}`);
  }
  const match = result.stdout.match(/ssh:\/\/[^\s]+/);
  if (!match) {
    throw new Error(`The Vast CLI did not return an SSH endpoint for instance ${INSTANCE_ID}.`);
  }
  return parseSshUrl(match[0]);
}

function parseSshUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("SITE_MOTION_SSH_URL is not a valid ssh:// URL.");
  }
  if (parsed.protocol !== "ssh:" || !parsed.hostname || !parsed.port) {
    throw new Error("The Vast SSH endpoint must use ssh://user@host:port.");
  }
  return {
    user: decodeURIComponent(parsed.username || "root"),
    host: parsed.hostname,
    port: parsed.port,
  };
}

function sshArgs(connection, remoteCommand) {
  return [
    "-T",
    "-i",
    process.env.SITE_MOTION_SSH_KEY || join(homedir(), ".ssh", "id_ed25519"),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=30",
    "-p",
    connection.port,
    `${connection.user}@${connection.host}`,
    remoteCommand,
  ];
}

async function runRemote(connection, command, args, timeoutMs) {
  const remoteCommand = [command, ...args].map(shellQuote).join(" ");
  const result = await run("ssh", sshArgs(connection, remoteCommand), { timeoutMs });
  if (result.error) throw result.error;
  return result;
}

async function runRemoteCommand(connection, command, timeoutMs, runDir) {
  const result = await run("ssh", sshArgs(connection, command), { timeoutMs });
  if (result.error) {
    let cleanup = "not-attempted";
    if (isSafeRemoteRunDir(runDir)) {
      try {
        await runRemote(connection, "sh", ["-c", `if test -s ${shellQuote(`${runDir}/pid`)}; then kill -TERM $(cat ${shellQuote(`${runDir}/pid`)}) 2>/dev/null || true; fi; test ! -s ${shellQuote(`${runDir}/pid`)}`], 10000);
        cleanup = "confirmed";
      } catch {
        cleanup = "pending";
      }
    }
    throw new Error(`${result.error.message}; remote cleanup ${cleanup}`);
  }
  return result;
}

async function copyRemote(connection, remotePath, localPath, timeoutMs) {
  const result = await run(
    "scp",
    [
      "-q",
      "-i",
      process.env.SITE_MOTION_SSH_KEY || join(homedir(), ".ssh", "id_ed25519"),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=30",
      "-P",
      connection.port,
      `${connection.user}@${connection.host}:${remotePath}`,
      localPath,
    ],
    { timeoutMs },
  );
  if (result.error) throw result.error;
}

function validateString(value, name, { maxLength = 500 } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function integerOption(input, name, fallback, min, max) {
  const value = input[name] ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function booleanOption(input, name, fallback) {
  const value = input[name] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

function validateCaptureInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The capture input must be an object.");
  }
  const urlValue = validateString(input.url, "url", { maxLength: 4000 });
  if (!urlValue) throw new Error("url is required.");
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("url must be a valid HTTP or HTTPS URL.");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("url must use http:// or https://.");
  }

  const name = input.name ?? `capture-${Date.now()}`;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new Error("name must contain 1 to 81 letters, numbers, dots, dashes, or underscores.");
  }
  const outputDir = resolve(input.output_dir || DEFAULT_LOCAL_OUTPUT);
  const hoverSelector = validateString(input.hover_selector, "hover_selector", { maxLength: 300 });
  const clickSelector = validateString(input.click_selector, "click_selector", { maxLength: 300 });
  const consentSelector = validateString(input.consent_selector, "consent_selector", { maxLength: 300 });
  const consentMode = input.consent_mode ?? "reject";
  if (!["reject", "accept", "none", "granular"].includes(consentMode)) {
    throw new Error("consent_mode must be reject, accept, none, or granular.");
  }
  const consentAcceptApproved = booleanOption(input, "consent_accept_approved", false);
  const granularSelectors = [
    [input.consent_settings_selector, "consent_settings_selector"],
    [input.consent_optional_selector, "consent_optional_selector"],
    [input.consent_save_selector, "consent_save_selector"],
  ];
  if (consentMode === "granular" && granularSelectors.some(([value]) => value === undefined)) {
    throw new Error("granular consent_mode requires consent_settings_selector, consent_optional_selector, and consent_save_selector.");
  }
  if (consentMode === "accept" && consentAcceptApproved !== true) {
    throw new Error("accept consent_mode requires explicit consent_accept_approved=true.");
  }
  return {
    url: url.href,
    width: integerOption(input, "width", 1920, 320, 3840),
    height: integerOption(input, "height", 1080, 240, 2160),
    name,
    outputDir,
    settleMs: integerOption(input, "settle_ms", 2000, 0, 30000),
    scrollDistance: integerOption(input, "scroll_distance", 2500, 0, 20000),
    scrollStep: integerOption(input, "scroll_step", 100, 1, 2000),
    scrollPauseMs: integerOption(input, "scroll_pause_ms", 80, 0, 3000),
    tailLines: integerOption(input, "tail_lines", 800, 0, 5000),
    hoverSelector,
    clickSelector,
    consentMode,
    consentAcceptApproved,
    consentSelector,
    consentSettingsSelector: validateString(input.consent_settings_selector, "consent_settings_selector", { maxLength: 300 }),
    consentOptionalSelector: validateString(input.consent_optional_selector, "consent_optional_selector", { maxLength: 300 }),
    consentSaveSelector: validateString(input.consent_save_selector, "consent_save_selector", { maxLength: 300 }),
    consentBudgetMs: integerOption(input, "consent_budget_ms", 8000, 0, 60000),
    consentMaxClicks: integerOption(input, "consent_max_clicks", 6, 1, 12),
    consentWaitMs: integerOption(input, "consent_wait_ms", 1200, 0, 10000),
    consentPreflight: booleanOption(input, "consent_preflight", true),
    mobile: booleanOption(input, "mobile", false),
    noScroll: booleanOption(input, "no_scroll", false),
    gpu: booleanOption(input, "gpu", true),
    timeoutMs: integerOption(input, "timeout_ms", 180000, 30000, 600000),
    overwrite: booleanOption(input, "overwrite", false),
  };
}

async function captureSiteMotion(input) {
  const capture = validateCaptureInput(input);
  const runId = randomUUID();
  const localVideo = join(capture.outputDir, `${capture.name}.webm`);
  const localJank = join(capture.outputDir, `${capture.name}.jank.json`);
  const lockPath = join(capture.outputDir, `.${capture.name}.capture.lock`);
  await mkdir(capture.outputDir, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("capture_target_busy");
    throw error;
  }
  try {
    const connection = await resolveConnection();
    if (!capture.overwrite) {
      for (const target of [localVideo, localJank]) {
        try {
          await stat(target);
          throw new Error(`capture target exists: ${target}; set overwrite=true to replace it.`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  await ensureRemoteEncoder(connection);

  const remoteRunDir = `${REMOTE_OUTPUT}/runs/${runId}`;
  const remoteVideo = `${remoteRunDir}/${capture.name}.webm`;
  const remoteJank = `${remoteRunDir}/${capture.name}.jank.json`;
  const remoteManifest = `${remoteRunDir}/manifest.json`;
  const remoteArgs = [
    `${REMOTE_ROOT}/capture.mjs`,
    "--url",
    capture.url,
    "--consent-mode",
    capture.consentMode,
    "--consent-wait",
    String(capture.consentWaitMs),
    "--width",
    String(capture.width),
    "--height",
    String(capture.height),
    "--out",
    remoteRunDir,
    "--run-id",
    runId,
    "--settle",
    String(capture.settleMs),
    "--scroll-distance",
    String(capture.scrollDistance),
    "--scroll-step",
    String(capture.scrollStep),
    "--scroll-pause",
    String(capture.scrollPauseMs),
    "--tail",
    String(capture.tailLines),
    "--name",
    capture.name,
  ];
  if (capture.gpu) remoteArgs.push("--gpu");
  if (capture.mobile) remoteArgs.push("--mobile");
  if (capture.noScroll) remoteArgs.push("--no-scroll");
  if (!capture.consentPreflight) remoteArgs.push("--no-consent-preflight");
  if (capture.consentSelector) remoteArgs.push("--consent-selector", capture.consentSelector);
  if (capture.consentSettingsSelector) remoteArgs.push("--consent-settings-selector", capture.consentSettingsSelector);
  if (capture.consentOptionalSelector) remoteArgs.push("--consent-optional-selector", capture.consentOptionalSelector);
  if (capture.consentSaveSelector) remoteArgs.push("--consent-save-selector", capture.consentSaveSelector);
  remoteArgs.push("--consent-budget-ms", String(capture.consentBudgetMs), "--consent-max-clicks", String(capture.consentMaxClicks));
  if (capture.hoverSelector) remoteArgs.push("--hover-selector", capture.hoverSelector);
  if (capture.clickSelector) remoteArgs.push("--click-selector", capture.clickSelector);

  if (capture.consentAcceptApproved) remoteArgs.push("--consent-accept-approved");
  const remoteCommand = `set -eu; mkdir -p ${shellQuote(remoteRunDir)}; echo $$ > ${shellQuote(`${remoteRunDir}/pid`)}; trap 'rm -f ${shellQuote(`${remoteRunDir}/pid`)}' EXIT; exec ${["node", ...remoteArgs].map(shellQuote).join(" ")}`;
  const stageDir = join(capture.outputDir, `.capture-${runId}`);
  let remote;
  let cleanup = "pending";
  try {
    remote = await runRemoteCommand(connection, remoteCommand, capture.timeoutMs, remoteRunDir);
    await mkdir(stageDir, { recursive: true });
    await copyRemote(connection, remoteManifest, join(stageDir, "manifest.json"), 60000);
    await copyRemote(connection, remoteVideo, join(stageDir, `${capture.name}.webm`), 60000);
    await copyRemote(connection, remoteJank, join(stageDir, `${capture.name}.jank.json`), 60000);
    const manifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8"));
    const expectedNames = new Set([`${capture.name}.webm`, `${capture.name}.jank.json`]);
    if (manifest.runId !== runId || !Array.isArray(manifest.files) || manifest.files.length !== expectedNames.size) throw new Error("manifest validation failed");
    const seenNames = new Set();
    for (const file of manifest.files) {
      if (!file || typeof file.path !== "string" || basename(file.path) !== file.path || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file.path) || !expectedNames.has(file.path) || seenNames.has(file.path)) throw new Error("manifest validation failed");
      seenNames.add(file.path);
      const path = join(stageDir, file.path);
      const bytes = await readFile(path);
      const info = await stat(path);
      if (info.size !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`manifest validation failed for ${file.path}`);
    }
    await rename(join(stageDir, `${capture.name}.webm`), localVideo);
    await rename(join(stageDir, `${capture.name}.jank.json`), localJank);
    await runRemote(connection, "rm", ["-rf", "--", remoteRunDir], 30000);
    cleanup = "confirmed";
  } catch (error) {
    cleanup = "pending";
    try {
      await runRemote(connection, "rm", ["-rf", "--", remoteRunDir], 30000);
      cleanup = "confirmed";
    } catch {}
    throw error;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
  const jankReport = JSON.parse(await readFile(localJank, "utf8"));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            runId,
            url: capture.url,
            instanceId: INSTANCE_ID,
            gpuCapture: capture.gpu,
            remoteVideo,
            remoteJank,
            localVideoPath: localVideo,
            localJankPath: localJank,
            consent: jankReport.consent || null,
            recorderOutput: trimOutput(remote.stdout),
            cleanup,
          },
          null,
          2,
        ),
      },
    ],
  };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function ensureRemoteEncoder(connection) {
  const bundlePath = `${REMOTE_ROOT}/node_modules/playwright-core/lib/coreBundle.js`;
  const lockPath = `${REMOTE_ROOT}/.encoder-provision.lock`;
  const patchScript = [
    "const fs = require('fs');",
    `const path = ${JSON.stringify(bundlePath)};`,
    "const source = fs.readFileSync(path, 'utf8');",
    "if (source.includes('-b:v 8M')) process.exit(0);",
    "const matches = source.match(/-b:v 1M/g) || [];",
    "if (matches.length !== 1) throw new Error('Playwright encoder bitrate is not at the expected setting.');",
    "fs.writeFileSync(path, source.replace('-b:v 1M', '-b:v 8M'));",
  ].join(" ");
  const command = `set -eu; if mkdir ${shellQuote(lockPath)} 2>/dev/null; then trap 'rmdir ${shellQuote(lockPath)}' EXIT; node -e ${shellQuote(patchScript)}; else node -e ${shellQuote(patchScript)}; fi`;
  await runRemoteCommand(connection, command, 30000, lockPath);
}

async function checkCaptureGpu() {
  const connection = await resolveConnection();
  const gpu = await runRemote(
    connection,
    "nvidia-smi",
    ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
    30000,
  );
  const renderer = await runRemote(connection, "node", [`${REMOTE_ROOT}/check-gpu-renderer.mjs`], 60000);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            instanceId: INSTANCE_ID,
            gpu: gpu.stdout.trim(),
            chromiumWebgl: trimOutput(renderer.stdout),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function callTool(name, input) {
  if (name === "capture_site_motion") return captureSiteMotion(input);
  if (name === "check_capture_gpu") return checkCaptureGpu();
  return errorResult(`Unknown tool: ${name}`);
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.id === undefined) return;

  try {
    if (message.method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Use design-inspiration to find candidate references. Use capture_site_motion to study live behavior on a selected site.",
        },
      });
      return;
    }
    if (message.method === "ping") {
      writeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method === "tools/list") {
      writeMessage({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const result = await callTool(name, message.params?.arguments || {});
      writeMessage({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported method: ${message.method}` },
    });
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: errorResult(error instanceof Error ? error.message : String(error)),
    });
  }
}

const isMainModule = resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handleMessage(message);
  });
}

export {
  run,
  resolveConnection,
  parseSshUrl,
  sshArgs,
  runRemote,
  runRemoteCommand,
  copyRemote,
  validateString,
  integerOption,
  booleanOption,
  validateCaptureInput,
  captureSiteMotion,
  ensureRemoteEncoder,
  checkCaptureGpu,
  callTool,
  handleMessage,
  writeMessage,
  errorResult,
  shellQuote,
  isSafeRemoteRunDir,
  trimOutput,
  tools,
  SERVER_NAME,
  SERVER_VERSION,
  INSTANCE_ID,
  REMOTE_ROOT,
  REMOTE_OUTPUT,
  DEFAULT_LOCAL_OUTPUT,
};
