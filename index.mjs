#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { resolve, join, basename, dirname, relative, isAbsolute, sep } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "site-motion-capture";
const SERVER_VERSION = "1.0.0";
const CONTRACT_VERSION = "capture-cell.v2";
const REMOTE_ROOT = process.env.SITE_MOTION_REMOTE_ROOT || "/workspace/site-motion-capture";
const REMOTE_OUTPUT = process.env.SITE_MOTION_REMOTE_OUTPUT || `${REMOTE_ROOT}/out`;
const DEFAULT_LOCAL_OUTPUT =
  process.env.SITE_MOTION_OUTPUT_DIR ||
  join(process.cwd(), "artifacts", "design-inspiration", "site-motion-capture");
const LONG_TASK_THRESHOLD_MS = 50;
const GPU_CHECK_TTL_MS = 120_000;
const CAPTURE_LOCK_TTL_MS = 30 * 60 * 1000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 1200;
const WORKER_RESOLUTION_TIMEOUT_MS = 15_000;
const WORKER_PREFLIGHT_TIMEOUT_MS = 15_000;
const gpuChecks = new Map();
const activeCaptureControllers = new Set();

class CaptureWorkerError extends Error {
  constructor(reasonCode, message, diagnostic = undefined) {
    super(message);
    this.name = "CaptureWorkerError";
    this.reasonCode = reasonCode;
    this.diagnostic = diagnostic ? trimOutput(diagnostic) : undefined;
  }
}

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
        scroll_distance: { type: "integer", minimum: 0, maximum: 20000, description: "Optional scroll distance. Omit to measure the page." },
        scroll_step: { type: "integer", minimum: 1, maximum: 2000, default: 100 },
        scroll_pause_ms: { type: "integer", minimum: 0, maximum: 3000, default: 80 },
        tail_lines: { type: "integer", minimum: 0, maximum: 5000, default: 800 },
        hover_selector: { type: "string", description: "A CSS selector to hover during the capture." },
        click_selector: { type: "string", description: "A CSS selector to click during the capture." },
        auto_discover: { type: "boolean", default: false, description: "Discover and exercise likely interactive controls." },
        mobile: { type: "boolean", default: false, description: "Emulate a mobile device with touch at a 390×844 viewport." },
        reduced_motion: { type: "boolean", default: false, description: "Emulate prefers-reduced-motion during recording." },
        no_scroll: { type: "boolean", default: false },
        gpu: { type: "boolean", default: true },
        gpu_check_id: { type: "string", description: "Short-lived ID returned by check_capture_gpu." },
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

function waitWithSignal(promise, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error("Capture was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function errorResult(reasonCode, message, diagnostic = undefined) {
  if (message === undefined) {
    message = reasonCode;
    reasonCode = "capture-error";
  }
  const payload = {
    status: "blocked",
    reasonCode,
    message: redactDiagnostic(message),
    ...(diagnostic ? { diagnostic: trimOutput(diagnostic) } : {}),
  };
  return {
    content: [{ type: "text", text: `${reasonCode}: ${payload.message}` }],
    isError: true,
    structuredContent: payload,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isSafeRemoteRunDir(value) {
  return new RegExp(`^${REMOTE_OUTPUT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/runs/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value);
}

function run(command, args, { timeoutMs = 120000, env = process.env, killDelayMs = 5000, signal } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError = null;
    let terminationRequested = false;
    const stop = (kind = "terminated") => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationError = new Error(`${command} ${kind}`);
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      setTimeout(() => {
        if (settled) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, killDelayMs).unref();
    };
    const timer = setTimeout(() => {
      stop(`timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    const onAbort = () => stop("was cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => finish(error, 1));
    child.on("close", (code, signal) => {
      if (terminationError) {
        finish(terminationError, 124);
      } else if (signal) {
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
      signal?.removeEventListener("abort", onAbort);
      resolveRun({ error, code, stdout, stderr });
    }
  });
}

function trimOutput(value) {
  const text = redactDiagnostic(String(value).trim());
  return text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(-MAX_DIAGNOSTIC_LENGTH)}…` : text;
}

function appendCapped(current, chunk) {
  const remaining = MAX_PROCESS_OUTPUT_BYTES - current.length;
  if (remaining <= 0) return current;
  return current + String(chunk).slice(0, remaining);
}

function redactDiagnostic(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|private[_-]?key|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(ssh:\/\/)[^:@\s]+:[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]");
}

async function validateMedia(filePath, signal) {
  const info = await stat(filePath);
  if (info.size === 0) return { status: "blocked", reason: "zero-byte WebM" };
  // SITE_MOTION_FFPROBE is intentionally ignored: complete evidence always requires validation.
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type", "-of", "json", filePath], { timeoutMs: 10000, signal });
  if (signal?.aborted) throw new Error("Capture was cancelled.");
  if (probe.error && /ENOENT|not found/i.test(probe.error.message)) {
    return { status: "blocked", reason: "ffprobe is unavailable" };
  }
  if (probe.error || !probe.stdout.trim()) return { status: "blocked", reason: "ffprobe rejected the WebM" };
  try {
    const probeData = JSON.parse(probe.stdout);
    const format = probeData.format;
    const duration = Number(format?.duration);
    if (!String(format?.format_name || "").toLowerCase().includes("webm")) return { status: "blocked", reason: "ffprobe did not identify WebM format" };
    if (!Number.isFinite(duration) || duration <= 0) return { status: "blocked", reason: "ffprobe returned no positive duration" };
    const videoStreamCount = Array.isArray(probeData.streams)
      ? probeData.streams.filter((stream) => stream?.codec_type === "video").length
      : 0;
    if (videoStreamCount < 1) return { status: "blocked", reason: "ffprobe found no video stream" };
    return { status: "valid", format: format.format_name, durationSeconds: duration, videoStreamCount };
  } catch {
    return { status: "blocked", reason: "ffprobe returned invalid JSON" };
  }
}

function validateJankReport(jankReport, expected = undefined) {
  const valid = jankReport && typeof jankReport === "object" && !Array.isArray(jankReport)
    && jankReport.schemaVersion === "jank-report.v1"
    && ["valid", "partial"].includes(jankReport.status)
    && typeof jankReport.finalUrl === "string" && jankReport.finalUrl.length > 0
    && Array.isArray(jankReport.longTasks)
    && Number.isInteger(jankReport.longTaskCount)
    && jankReport.longTaskCount === jankReport.longTasks.length
    && Number.isFinite(jankReport.totalBlockingTimeMs) && jankReport.totalBlockingTimeMs >= 0
    && Number.isFinite(jankReport.thresholdMs) && jankReport.thresholdMs >= 0
    && typeof jankReport.choppy === "boolean"
    && jankReport.byPhase && typeof jankReport.byPhase === "object" && !Array.isArray(jankReport.byPhase)
    && (jankReport.observerError === null || typeof jankReport.observerError === "string")
    && jankReport.longTasks.every((task) => task && Number.isFinite(task.startTime) && task.startTime >= 0
      && Number.isFinite(task.duration) && task.duration >= LONG_TASK_THRESHOLD_MS
      && typeof task.documentUrl === "string")
    && jankReport.consent && typeof jankReport.consent === "object"
    && ["reject", "accept", "none", "granular"].includes(jankReport.consent.mode)
    && typeof jankReport.consent.verified === "boolean"
    && typeof jankReport.consent.dismissed === "boolean"
    && typeof jankReport.consent.actionTaken === "boolean"
    && Array.isArray(jankReport.consent.blindSpots)
    && !(jankReport.consent.mode === "none" && (jankReport.consent.actionTaken === true || jankReport.consent.dismissed === true))
    && jankReport.scroll && typeof jankReport.scroll === "object"
    && typeof jankReport.scroll.requested === "boolean"
    && typeof jankReport.scroll.completed === "boolean"
    && typeof jankReport.scroll.timedOut === "boolean"
    && typeof jankReport.scroll.truncated === "boolean"
    && Number.isFinite(jankReport.scroll.actualDistance) && jankReport.scroll.actualDistance >= 0
    && Number.isFinite(jankReport.scroll.completedDistance) && jankReport.scroll.completedDistance >= 0
    && Array.isArray(jankReport.interactionFailures)
    && Array.isArray(jankReport.interactions)
    && jankReport.viewport && typeof jankReport.viewport === "object"
    && Number.isInteger(jankReport.viewport.width) && Number.isInteger(jankReport.viewport.height)
    && typeof jankReport.viewport.mobile === "boolean"
    && typeof jankReport.viewport.reducedMotion === "boolean";
  if (!valid) throw new Error("jank validation failed");
  if (jankReport.status === "valid" && (jankReport.consent.verified !== true
    || jankReport.consent.blindSpots.length !== 0
    || jankReport.scroll.completed !== true || jankReport.scroll.truncated !== false
    || jankReport.interactionFailures.length !== 0
    || jankReport.interactions.some((interaction) => interaction?.status === "failed")
    || jankReport.observerError !== null)) throw new Error("jank validation failed: valid status contradicts report evidence");
  if (expected) {
    const viewport = jankReport.viewport;
    if (viewport.width !== expected.width || viewport.height !== expected.height
      || viewport.mobile !== expected.mobile || viewport.reducedMotion !== expected.reducedMotion) {
      throw new Error("jank validation failed: requested viewport mismatch");
    }
    if (typeof expected.finalUrl === "string" && jankReport.finalUrl !== expected.finalUrl) {
      throw new Error("jank validation failed: final URL mismatch");
    }
  }
  return jankReport;
}

function validateEgressEvidence(evidence, expectedUrl, attestation) {
  const expectedHost = new URL(expectedUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const namespaceInode = evidence?.networkNamespaceInode;
  if (!evidence || evidence.status !== "verified"
    || typeof evidence.boundaryId !== "string" || evidence.boundaryId.length === 0
    || evidence.directEgressBlocked !== true
    || evidence.proxyPolicy !== "capture-exact-host.v1"
    || evidence.approvedProxyProbe !== true
    || evidence.approvedHost !== expectedHost
    || !Number.isSafeInteger(namespaceInode) || namespaceInode <= 0) {
    throw new Error("egress validation failed: runner boundary is not verified for this capture host");
  }
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const checkedAt = typeof attestation?.checkedAt === "string" && timestampPattern.test(attestation.checkedAt) ? Date.parse(attestation.checkedAt) : NaN;
  const expiresAt = typeof attestation?.expiresAt === "string" && timestampPattern.test(attestation.expiresAt) ? Date.parse(attestation.expiresAt) : NaN;
  const expectedFields = ["schemaVersion", "boundaryId", "checkedAt", "expiresAt", "runnerInstanceId", "browserExecutable", "browserVersion", "captureRuntime", "captureRuntimeVersion", "browserUseVersion", "approvedHost", "directEgressBlocked", "proxyPolicy", "networkNamespaceInode", "controls"];
  const exactShape = attestation && typeof attestation === "object" && !Array.isArray(attestation)
    && Object.keys(attestation).length === expectedFields.length
    && expectedFields.every((key) => Object.hasOwn(attestation, key));
  if (!exactShape
    || attestation.schemaVersion !== "runner-egress-boundary.v1"
    || attestation.boundaryId !== evidence.boundaryId
    || attestation.approvedHost !== expectedHost
    || attestation.networkNamespaceInode !== namespaceInode
    || attestation.directEgressBlocked !== true
    || attestation.proxyPolicy !== "capture-exact-host.v1"
    || attestation.captureRuntime !== "site-motion-capture"
    || !["runnerInstanceId", "browserExecutable", "browserVersion", "captureRuntimeVersion", "browserUseVersion"].every((key) => typeof attestation[key] === "string" && attestation[key].length > 0)
    || !Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || expiresAt <= checkedAt || expiresAt - checkedAt > 120_000
    || attestation.controls?.direct?.status !== "blocked"
    || attestation.controls?.proxied?.status !== "passed") {
    throw new Error("egress validation failed: full runner attestation is missing or mismatched");
  }
  return evidence;
}

function workerConfiguration() {
  const sshUrl = process.env.SITE_MOTION_SSH_URL?.trim();
  const instanceId = process.env.VAST_INSTANCE_ID?.trim();
  if (sshUrl) return { source: "ssh-url", sshUrl, instanceId: null };
  if (instanceId) return { source: "vast-instance", sshUrl: null, instanceId };
  return null;
}

function workerIdentity() {
  const configuration = workerConfiguration();
  return {
    source: configuration?.source || "unconfigured",
    instanceId: configuration?.instanceId || null,
  };
}

function connectionFingerprint(connection) {
  const identity = JSON.stringify([connection.user, connection.host.toLowerCase(), connection.port]);
  return createHash("sha256").update(identity).digest("hex");
}

async function resolveConnection(signal, runCommand = run) {
  const configuration = workerConfiguration();
  if (!configuration) {
    throw new CaptureWorkerError(
      "capture-worker-unconfigured",
      "Capture worker is not configured. Set VAST_INSTANCE_ID or SITE_MOTION_SSH_URL.",
    );
  }
  if (configuration.source === "ssh-url") return parseSshUrl(configuration.sshUrl);

  const result = await runCommand("vastai", ["ssh-url", configuration.instanceId], { timeoutMs: WORKER_RESOLUTION_TIMEOUT_MS, signal });
  if (result.error) {
    const reasonCode = /timed out|timeout/i.test(result.error.message)
      ? "capture-worker-timeout"
      : "capture-worker-unavailable";
    throw new CaptureWorkerError(
      reasonCode,
      "The configured capture worker is unavailable.",
      result.error.message,
    );
  }
  const match = result.stdout.match(/ssh:\/\/[^\s]+/);
  if (!match) {
    throw new CaptureWorkerError(
      "capture-worker-unavailable",
      "The configured Vast instance did not provide an SSH endpoint.",
      result.stdout,
    );
  }
  try {
    return parseSshUrl(match[0]);
  } catch (error) {
    throw new CaptureWorkerError(
      "capture-worker-unavailable",
      "The configured Vast instance returned an invalid SSH endpoint.",
      error.message,
    );
  }
}

function parseSshUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CaptureWorkerError("capture-worker-malformed-url", "SITE_MOTION_SSH_URL is not a valid ssh:// URL.");
  }
  if (parsed.protocol !== "ssh:" || !parsed.hostname || !parsed.port || parsed.password || parsed.search || parsed.hash) {
    throw new CaptureWorkerError("capture-worker-malformed-url", "The Vast SSH endpoint must use ssh://user@host:port without credentials or query parameters.");
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
    "ConnectTimeout=10",
    "-p",
    connection.port,
    `${connection.user}@${connection.host}`,
    remoteCommand,
  ];
}

async function runRemote(connection, command, args, timeoutMs, signal) {
  const remoteCommand = [command, ...args].map(shellQuote).join(" ");
  const result = await run("ssh", sshArgs(connection, remoteCommand), { timeoutMs, signal });
  if (result.error) throw result.error;
  return result;
}

async function runRemoteCommand(connection, command, timeoutMs, runDir, signal) {
  const result = await run("ssh", sshArgs(connection, command), { timeoutMs, signal });
  if (result.error) {
    let cleanup = "not-attempted";
    if (isSafeRemoteRunDir(runDir)) {
      try {
        const terminate = [
          "set -eu",
          `pidfile=${shellQuote(`${runDir}/pid`)}`,
          "if test -s \"$pidfile\"; then",
          "  pid=$(cat \"$pidfile\")",
          "  case \"$pid\" in ''|*[!0-9]*) exit 1 ;; esac",
          "  cmdline=$(tr '\\000' ' ' < \"/proc/$pid/cmdline\")",
          `  case "$cmdline" in *capture.mjs*${basename(runDir)}*) ;; *) exit 1 ;; esac`,
          "  kill -TERM \"$pid\" 2>/dev/null || true",
          "  i=0",
          "  while kill -0 \"$pid\" 2>/dev/null && test \"$i\" -lt 25; do sleep 0.2; i=$((i + 1)); done",
          "  if kill -0 \"$pid\" 2>/dev/null; then kill -KILL \"$pid\" 2>/dev/null || true; fi",
          "  i=0",
          "  while kill -0 \"$pid\" 2>/dev/null && test \"$i\" -lt 25; do sleep 0.2; i=$((i + 1)); done",
          "  if kill -0 \"$pid\" 2>/dev/null; then exit 1; fi",
          "  rm -f \"$pidfile\"",
          "fi",
          `test ! -s ${shellQuote(`${runDir}/pid`)}`,
        ].join("\n");
        await runRemote(connection, "sh", ["-c", terminate], 15000);
        cleanup = "confirmed";
      } catch {
        cleanup = "pending";
      }
    }
    throw new Error(`${result.error.message}; remote cleanup ${cleanup}`);
  }
  return result;
}

async function copyRemote(connection, remotePath, localPath, timeoutMs, signal) {
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
    { timeoutMs, signal },
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
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password || /(^|\.)localhost$/.test(hostname) || hostname.endsWith(".local") ||
      /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname) ||
      /^(::1|fc|fd|fe80:)/i.test(hostname)) {
    throw new Error("url must target a public HTTP(S) host without credentials.");
  }

  const name = input.name ?? `capture-${Date.now()}`;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new Error("name must contain 1 to 81 letters, numbers, dots, dashes, or underscores.");
  }
  const outputDir = resolve(input.output_dir || DEFAULT_LOCAL_OUTPUT);
  const approvedRoots = [resolve(process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT || process.cwd()), resolve(tmpdir())];
  if (!approvedRoots.some((approvedRoot) => {
    const outputRelative = relative(approvedRoot, outputDir);
    return !isAbsolute(outputRelative) && !outputRelative.startsWith("..");
  })) {
    throw new Error("output_dir must remain inside the approved workspace output root.");
  }
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
  const mobile = booleanOption(input, "mobile", false);
  const width = integerOption(input, "width", 1920, 320, 3840);
  const height = integerOption(input, "height", 1080, 240, 2160);
  return {
    url: url.href,
    width: mobile ? 390 : width,
    height: mobile ? 844 : height,
    name,
    outputDir,
    settleMs: integerOption(input, "settle_ms", 2000, 0, 30000),
    scrollDistance: input.scroll_distance === undefined ? null : integerOption(input, "scroll_distance", null, 0, 20000),
    scrollStep: integerOption(input, "scroll_step", 100, 1, 2000),
    scrollPauseMs: integerOption(input, "scroll_pause_ms", 80, 0, 3000),
    tailLines: integerOption(input, "tail_lines", 800, 0, 5000),
    hoverSelector,
    clickSelector,
    autoDiscover: booleanOption(input, "auto_discover", false),
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
    mobile,
    reducedMotion: booleanOption(input, "reduced_motion", false),
    noScroll: booleanOption(input, "no_scroll", false),
    gpu: booleanOption(input, "gpu", true),
    gpuCheckId: validateString(input.gpu_check_id, "gpu_check_id", { maxLength: 80 }),
    timeoutMs: integerOption(input, "timeout_ms", 180000, 30000, 600000),
    overwrite: booleanOption(input, "overwrite", false),
  };
}

function isWithinRoot(root, candidate) {
  const outputRelative = relative(root, candidate);
  return (
    outputRelative === "" ||
    (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`))
  );
}

async function resolveExistingAncestor(
  path,
  { pathRealpath = realpath, pathLstat = lstat, pathDirname = dirname } = {},
) {
  let current = path;
  while (true) {
    try {
      return await pathRealpath(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        const info = await pathLstat(current);
        if (info.isSymbolicLink()) throw new Error("output_dir contains an unresolved symbolic link.");
        throw error;
      } catch (parentError) {
        if (parentError.code !== "ENOENT") throw parentError;
      }
      const parent = pathDirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertApprovedOutputDirectory(approvedRoots, candidate) {
  if (!approvedRoots.some((root) => isWithinRoot(root, candidate))) {
    throw new Error("output_dir must remain inside the approved workspace output root.");
  }
}

async function resolveOutputDirectory(outputDir, { pathRealpath = realpath } = {}) {
  const requestedOutput = resolve(outputDir);
  const configuredRoot = resolve(process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT || process.cwd());
  const approvedRoots = await Promise.all([configuredRoot, resolve(tmpdir())].map((root) => pathRealpath(root)));
  const existingAncestor = await resolveExistingAncestor(requestedOutput, { pathRealpath });
  assertApprovedOutputDirectory(approvedRoots, existingAncestor);
  await mkdir(requestedOutput, { recursive: true });
  const resolvedOutput = await pathRealpath(requestedOutput);
  assertApprovedOutputDirectory(approvedRoots, resolvedOutput);
  return resolvedOutput;
}

async function acquireCaptureLock(lockPath, { writeOwner = writeFile, removeLock = rm, makeDirectory = mkdir } = {}) {
  const owner = { pid: process.pid, createdAt: Date.now(), token: randomUUID() };
  let lockCreated = false;
  try {
    await makeDirectory(lockPath);
    lockCreated = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const reclaimPath = `${lockPath}.reclaim`;
    try {
      await makeDirectory(reclaimPath);
    } catch (reclaimError) {
      if (reclaimError.code === "EEXIST") throw new Error("capture_target_busy");
      throw reclaimError;
    }
    try {
      let previousOwner;
      try {
        previousOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      } catch {
        throw new Error("capture_target_busy");
      }
      if (!Number.isFinite(previousOwner.createdAt) || Date.now() - previousOwner.createdAt <= CAPTURE_LOCK_TTL_MS) {
        throw new Error("capture_target_busy");
      }
      await rm(lockPath, { recursive: true, force: false });
      await makeDirectory(lockPath);
      lockCreated = true;
    } finally {
      await rm(reclaimPath, { recursive: true, force: true });
    }
  }
  try {
    await writeOwner(join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx" });
  } catch (error) {
    if (lockCreated) await removeLock(lockPath, { recursive: true, force: true });
    throw error;
  }
  return owner;
}

async function releaseCaptureLock(lockPath, owner) {
  try {
    const current = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (current.token === owner.token) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function workerPreflightError(error) {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(diagnostic)) {
    return new CaptureWorkerError("capture-worker-timeout", "The capture worker preflight timed out.", diagnostic);
  }
  if (/missing (?:capture\.mjs|check-gpu-renderer\.mjs)/i.test(diagnostic)) {
    return new CaptureWorkerError("capture-worker-files-missing", "The capture worker is missing a required recorder file.", diagnostic);
  }
  if (/missing (?:node|ffprobe|playwright)/i.test(diagnostic) || /cannot find package ['"]playwright/i.test(diagnostic)) {
    return new CaptureWorkerError("capture-worker-dependency-missing", "The capture worker is missing a required runtime dependency.", diagnostic);
  }
  if (/connection refused|could not resolve|no route|permission denied|host key|name or service not known/i.test(diagnostic)) {
    return new CaptureWorkerError("capture-worker-unavailable", "The configured capture worker is unavailable.", diagnostic);
  }
  return new CaptureWorkerError("capture-worker-preflight-failed", "The capture worker preflight failed.", diagnostic);
}

async function runWorkerPreflightCommand(connection, command, signal) {
  try {
    return await runRemote(connection, "sh", ["-c", command], WORKER_PREFLIGHT_TIMEOUT_MS, signal);
  } catch (error) {
    throw workerPreflightError(error);
  }
}

async function verifyRemoteWorker(connection, signal) {
  const capturePath = `${REMOTE_ROOT}/capture.mjs`;
  const gpuCheckPath = `${REMOTE_ROOT}/check-gpu-renderer.mjs`;
  const playwrightPath = `${REMOTE_ROOT}/node_modules/playwright`;
  const command = [
    "set -eu",
    `cd ${shellQuote(REMOTE_ROOT)}`,
    `test -f ${shellQuote(capturePath)} || { echo 'missing capture.mjs' >&2; exit 41; }`,
    `test -f ${shellQuote(gpuCheckPath)} || { echo 'missing check-gpu-renderer.mjs' >&2; exit 42; }`,
    "command -v node >/dev/null || { echo 'missing node' >&2; exit 43; }",
    "command -v ffprobe >/dev/null || { echo 'missing ffprobe' >&2; exit 44; }",
    "ffprobe -version >/dev/null 2>&1",
    `test -e ${shellQuote(playwrightPath)} || { echo 'missing playwright' >&2; exit 45; }`,
    `node --input-type=module -e ${shellQuote("await import('playwright');")} || { echo 'missing playwright package' >&2; exit 46; }`,
  ].join("; ");
  await runWorkerPreflightCommand(connection, command, signal);
}

async function captureSiteMotion(input) {
  const controller = new AbortController();
  activeCaptureControllers.add(controller);
  try {
    return await captureSiteMotionWithController(input, controller);
  } finally {
    activeCaptureControllers.delete(controller);
  }
}

async function captureSiteMotionWithController(input, controller) {
  const capture = validateCaptureInput(input);
  await waitWithSignal(assertPublicResolution(capture.url), controller.signal);
  let connection;
  if (capture.gpu) {
    const check = capture.gpuCheckId ? gpuChecks.get(capture.gpuCheckId) : undefined;
    if (!check || check.expiresAt < Date.now()) throw new Error("gpu_check_id is required and must be a fresh GPU check");
    connection = await waitWithSignal(resolveConnection(controller.signal), controller.signal);
    if (check.connectionFingerprint !== connectionFingerprint(connection)) {
      throw new Error("gpu_check_id must match the configured capture worker");
    }
    gpuChecks.delete(capture.gpuCheckId);
  } else {
    connection = await waitWithSignal(resolveConnection(controller.signal), controller.signal);
  }
  capture.outputDir = await waitWithSignal(resolveOutputDirectory(capture.outputDir), controller.signal);
  const expectedAddresses = await waitWithSignal(resolvePublicAddresses(capture.url), controller.signal);
  const runId = randomUUID();
  const localVideo = join(capture.outputDir, `${capture.name}.webm`);
  const localJank = join(capture.outputDir, `${capture.name}.jank.json`);
  const localManifest = join(capture.outputDir, `${capture.name}.capture-cell.v2.json`);
  const lockPath = join(capture.outputDir, `.${capture.name}.capture.lock`);
  const lockOwner = await acquireCaptureLock(lockPath);
  try {
    if (!capture.overwrite) {
      for (const target of [localVideo, localJank, localManifest]) {
        try {
          await stat(target);
          throw new Error(`capture target exists: ${target}; set overwrite=true to replace it.`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    await verifyRemoteWorker(connection, controller.signal);
    await ensureRemoteEncoder(connection, controller.signal);

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
      ...(capture.scrollDistance === null ? [] : ["--scroll-distance", String(capture.scrollDistance)]),
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
    if (capture.reducedMotion) remoteArgs.push("--reduced-motion");
    if (capture.noScroll) remoteArgs.push("--no-scroll");
    if (!capture.consentPreflight) remoteArgs.push("--no-consent-preflight");
    if (capture.consentSelector) remoteArgs.push("--consent-selector", capture.consentSelector);
    if (capture.consentSettingsSelector) remoteArgs.push("--consent-settings-selector", capture.consentSettingsSelector);
    if (capture.consentOptionalSelector) remoteArgs.push("--consent-optional-selector", capture.consentOptionalSelector);
    if (capture.consentSaveSelector) remoteArgs.push("--consent-save-selector", capture.consentSaveSelector);
    remoteArgs.push("--consent-budget-ms", String(capture.consentBudgetMs), "--consent-max-clicks", String(capture.consentMaxClicks));
    if (capture.hoverSelector) remoteArgs.push("--hover-selector", capture.hoverSelector);
    if (capture.clickSelector) remoteArgs.push("--click-selector", capture.clickSelector);
    if (capture.autoDiscover) remoteArgs.push("--auto-discover");
    remoteArgs.push("--expected-addresses", JSON.stringify(expectedAddresses));

    if (capture.consentAcceptApproved) remoteArgs.push("--consent-accept-approved");
    const remoteCommand = `set -eu; mkdir -p ${shellQuote(remoteRunDir)}; node ${remoteArgs.map(shellQuote).join(" ")} & worker_pid=$!; printf '%s\\n' "$worker_pid" > ${shellQuote(`${remoteRunDir}/pid`)}; set +e; wait "$worker_pid"; worker_status=$?; rm -f ${shellQuote(`${remoteRunDir}/pid`)}; exit "$worker_status"`;
    const stageDir = join(capture.outputDir, `.capture-${runId}`);
    let remote;
    let cleanup = "pending";
    let cleanupError = null;
    try {
      try {
        remote = await runRemoteCommand(connection, remoteCommand, capture.timeoutMs, remoteRunDir, controller.signal);
      } catch (error) {
        const diagnostic = String(error);
        if (/capture egress boundary/i.test(diagnostic)) {
          throw new CaptureWorkerError("capture-egress-unverified", "The runner egress boundary could not be verified for this capture.", diagnostic);
        }
        throw error;
      }
      await mkdir(stageDir, { recursive: true });
      await copyRemote(connection, remoteManifest, join(stageDir, "manifest.json"), 60000, controller.signal);
      await copyRemote(connection, remoteVideo, join(stageDir, `${capture.name}.webm`), 60000, controller.signal);
      await copyRemote(connection, remoteJank, join(stageDir, `${capture.name}.jank.json`), 60000, controller.signal);
      const manifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8"));
      const expectedNames = new Set([`${capture.name}.webm`, `${capture.name}.jank.json`]);
      if (manifest.runId !== runId || !Array.isArray(manifest.files)
        || manifest.files.length !== expectedNames.size) throw new Error("manifest validation failed");
      const seenNames = new Set();
      for (const file of manifest.files) {
        if (!file || typeof file.path !== "string" || basename(file.path) !== file.path || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file.path) || !expectedNames.has(file.path) || seenNames.has(file.path)) throw new Error("manifest validation failed");
        seenNames.add(file.path);
        const path = join(stageDir, file.path);
        const bytes = await readFile(path);
        const info = await stat(path);
        if (info.size === 0 || info.size !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`manifest validation failed for ${file.path}`);
      }
      if (manifest.contractVersion !== CONTRACT_VERSION) throw new Error("manifest validation failed: unsupported contract version");
      const jankReport = JSON.parse(await readFile(join(stageDir, `${capture.name}.jank.json`), "utf8"));
      const expectedViewport = {
        width: capture.width,
        height: capture.height,
        mobile: capture.mobile,
        reducedMotion: capture.reducedMotion,
      };
      if (!manifest.viewport || Object.entries(expectedViewport).some(([key, value]) => manifest.viewport[key] !== value)) {
        throw new Error("capture manifest validation failed: requested viewport mismatch");
      }
      if (typeof manifest.finalUrl !== "string" || manifest.finalUrl !== jankReport.finalUrl) {
        throw new Error("capture manifest validation failed: final URL mismatch");
      }
      const egressEvidence = validateEgressEvidence(manifest.egress, capture.url, manifest.egressAttestation);
      validateJankReport(jankReport, {
        ...expectedViewport,
        finalUrl: manifest.finalUrl,
      });
      const mediaValidation = await validateMedia(join(stageDir, `${capture.name}.webm`), controller.signal);
      if (mediaValidation.status === "blocked") throw new Error(`media validation failed: ${mediaValidation.reason}`);
      await rename(join(stageDir, `${capture.name}.webm`), localVideo);
      await rename(join(stageDir, `${capture.name}.jank.json`), localJank);
      const localManifestData = {
        ...manifest,
        contractVersion: CONTRACT_VERSION,
        cellId: `${capture.mobile ? "mobile" : "desktop"}-${capture.reducedMotion ? "reduced" : "full"}`,
        url: capture.url,
        finalUrl: jankReport.finalUrl,
        viewport: manifest.viewport,
        modes: { gpu: capture.gpu, scroll: !capture.noScroll },
        validation: { media: mediaValidation, jank: { status: jankReport.status } },
        cleanup: "pending",
        status: "partial",
        evidence: {
          gpu: { status: capture.gpu ? "verified" : "unverified" },
          egress: egressEvidence,
          egressAttestation: manifest.egressAttestation,
          consent: jankReport.consent,
          interactionFailures: jankReport.interactionFailures,
          scroll: jankReport.scroll,
        },
      };
      await writeFile(localManifest, JSON.stringify(localManifestData, null, 2));
      try {
        await runRemote(connection, "rm", ["-rf", "--", remoteRunDir], 30000, controller.signal);
        cleanup = "confirmed";
      } catch (error) {
        cleanupError = error.message;
        cleanup = "pending";
      }
    } catch (error) {
      // Keep the remote run directory when process exit or evidence validation is uncertain.
      throw error;
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
    const jankReport = JSON.parse(await readFile(localJank, "utf8"));
    const manifest = JSON.parse(await readFile(localManifest, "utf8"));
    const videoFile = manifest.files.find((file) => file.path.endsWith(".webm"));
    const jankFile = manifest.files.find((file) => file.path.endsWith(".jank.json"));
    manifest.cleanup = cleanup;
    if (cleanupError) manifest.cleanupError = cleanupError;
    const consent = manifest.evidence.consent;
    const scroll = manifest.evidence.scroll;
    const complete = manifest.validation.media.status === "valid"
      && manifest.validation.jank.status === "valid"
      && manifest.cleanup === "confirmed"
      && manifest.evidence.gpu.status === "verified"
      && manifest.evidence.egress?.status === "verified"
      && manifest.evidence.egressAttestation?.schemaVersion === "runner-egress-boundary.v1"
      && consent?.verified === true
      && Array.isArray(consent.blindSpots) && consent.blindSpots.length === 0
      && scroll?.completed === true && scroll?.truncated === false
      && Array.isArray(manifest.evidence.interactionFailures)
      && manifest.evidence.interactionFailures.length === 0;
    manifest.status = complete ? "complete" : "partial";
    await writeFile(localManifest, JSON.stringify(manifest, null, 2));
    const contract = {
      contractVersion: CONTRACT_VERSION,
      status: manifest.status,
      runId,
      url: capture.url,
      finalUrl: manifest.finalUrl,
      viewport: manifest.viewport,
      modes: manifest.modes,
      worker: { ...workerIdentity(), remoteRunDir, recorder: manifest.recorder || null },
      consent: jankReport.consent,
      egress: manifest.evidence.egress,
      artifacts: {
        video: { path: localVideo, size: videoFile.size, sha256: videoFile.sha256 },
        jank: { path: localJank, size: jankFile.size, sha256: jankFile.sha256 },
        manifest: { path: localManifest, size: (await stat(localManifest)).size },
      },
      validation: manifest.validation,
      cleanup,
      ...(cleanupError ? { cleanupError } : {}),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ...contract, remoteVideo, remoteJank, localVideoPath: localVideo, localJankPath: localJank, recorderOutput: trimOutput(remote.stdout) },
            null,
            2,
          ),
        },
      ],
      structuredContent: { ...contract, localVideoPath: localVideo, localJankPath: localJank },
    };
  } finally {
    await releaseCaptureLock(lockPath, lockOwner);
  }
}

async function assertPublicResolution(rawUrl, resolveAddresses = resolvePublicAddresses) {
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "example.test") return;
  const addresses = await resolveAddresses(rawUrl);
  if (!addresses.length) {
    throw new Error("url must resolve only to public IP addresses");
  }
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && octets[2] === 0) || (a === 192 && b === 0 && octets[2] === 2) || (a === 192 && b === 88 && octets[2] === 99) || (a === 192 && b === 168) || (a === 198 && b >= 18 && b <= 19) || a >= 224;
  }
  if (isIP(normalized) !== 6) return false;
  const value = ipv6ToBigInt(normalized);
  const ranges = [
    ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64], ["2001:db8::", 32], ["2001:10::", 28], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:2::", 48],
  ];
  return ranges.some(([base, bits]) => inIpv6Range(value, ipv6ToBigInt(base), bits));
}

function ipv6ToBigInt(address) {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((value, group) => (value << 16n) + BigInt(parseInt(group, 16)), 0n);
}

function inIpv6Range(value, base, bits) {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (base & mask);
}

async function resolvePublicAddresses(rawUrl, lookupHostname = lookup) {
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "example.test") return [hostname];
  if (isPrivateAddress(hostname)) throw new Error("url must resolve only to public IP addresses");
  if (isIP(hostname)) return [hostname];
  let records;
  try { records = await lookupHostname(hostname, { all: true, verbatim: true }); } catch { throw new Error("url host could not be resolved safely"); }
  const addresses = records.map(({ address }) => address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("url must resolve only to public IP addresses");
  return addresses.sort();
}

async function ensureRemoteEncoder(connection, signal) {
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
  await runRemoteCommand(connection, command, 30000, lockPath, signal);
}

async function checkCaptureGpu({
  resolveWorker = resolveConnection,
  verifyWorker = verifyRemoteWorker,
  remoteRunner = runRemote,
} = {}) {
  const connection = await resolveWorker();
  await verifyWorker(connection);
  let gpu;
  try {
    gpu = await remoteRunner(
      connection,
      "nvidia-smi",
      ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
      30000,
    );
  } catch (error) {
    throw new CaptureWorkerError("capture-gpu-unavailable", "The capture worker GPU check failed.", error instanceof Error ? error.message : String(error));
  }
  if (!gpu.stdout.trim()) throw new CaptureWorkerError("capture-gpu-unavailable", "The capture worker returned no GPU details.");
  let renderer;
  try {
    renderer = await remoteRunner(connection, "node", [`${REMOTE_ROOT}/check-gpu-renderer.mjs`], 60000);
  } catch (error) {
    throw new CaptureWorkerError("capture-gpu-webgl-unavailable", "The capture worker WebGL check failed.", error instanceof Error ? error.message : String(error));
  }
  if (!renderer.stdout.trim()) throw new CaptureWorkerError("capture-gpu-webgl-unavailable", "The capture worker returned no Chromium WebGL renderer.");
  const checkId = randomUUID();
  const expiresAt = Date.now() + GPU_CHECK_TTL_MS;
  gpuChecks.set(checkId, { expiresAt, connectionFingerprint: connectionFingerprint(connection) });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            checkId,
            expiresAt: new Date(expiresAt).toISOString(),
            ...workerIdentity(),
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
  return errorResult("unknown-tool", `Unknown tool: ${name}`);
}

async function handleMessage(message, write) {
  if (!message || typeof message !== "object") return;

  try {
    if (message.id === undefined) return;

    if (message.method === "initialize") {
      write({
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
      write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method === "tools/list") {
      write({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const result = await callTool(name, message.params?.arguments || {});
      write({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported method: ${message.method}` },
    });
  } catch (error) {
    if (error instanceof CaptureWorkerError) {
      write({ jsonrpc: "2.0", id: message.id, result: errorResult(error.reasonCode, error.message, error.diagnostic) });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: errorResult("capture-error", error instanceof Error ? error.message : String(error)),
    });
  }
}

const isMainModule = resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const abortActiveCaptures = () => { for (const controller of activeCaptureControllers) controller.abort(); };
  process.once("SIGTERM", abortActiveCaptures);
  process.once("SIGINT", abortActiveCaptures);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handleMessage(message, writeMessage);
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
  validateMedia,
  validateJankReport,
  validateEgressEvidence,
  assertPublicResolution,
  isPrivateAddress,
  resolvePublicAddresses,
  resolveOutputDirectory,
  resolveExistingAncestor,
  acquireCaptureLock,
  releaseCaptureLock,
  tools,
  SERVER_NAME,
  SERVER_VERSION,
  CaptureWorkerError,
  workerConfiguration,
  workerIdentity,
  verifyRemoteWorker,
  workerPreflightError,
  REMOTE_ROOT,
  REMOTE_OUTPUT,
  DEFAULT_LOCAL_OUTPUT,
  CONTRACT_VERSION,
};
