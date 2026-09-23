import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJankReport, validateMedia } from "../index.mjs";
import { writeExecutable } from "./fixtures.mjs";

test("recorder safety/reporting contract remains present", async () => {
  const source = await readFile(new URL("../remote/capture.mjs", import.meta.url), "utf8");
  for (const marker of [
    "consentSettingsSelectors", "consentOptionalSelectors", "consentSaveSelectors",
    "consentMaxClicks", "consentBudgetMs", "writeManifest", "createHash(\"sha256\")",
    "before-finalization", "cleaning", "runId",
  ]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  assert.match(source, /function withTimeout\(operation, timeoutMs, label\)/);
  assert.match(source, /function runConsentBounded\(page, args, phase\)/);
  assert.match(source, /consent-check-timeout/);
  assert.match(source, /shadow-scan-timeout/);
  assert.match(source, /scroll input/);
  assert.ok(source.indexOf("await page.close();") < source.indexOf("const videoPath = await video.path();"));
  assert.match(source, /font readiness not reached within/);
});

test("launcher preserves distinct concurrent names and rejects unsafe overwrite inputs", async () => {
  const source = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(source, /name must contain 1 to 81/);
  assert.match(source, /overwrite: \{ type: "boolean", default: false \}/);
  assert.match(source, /randomUUID/);
  assert.match(source, /runRemoteCommand/);
});

test("capture artifact contract includes reduced motion, validation, and persistence hooks", async () => {
  const source = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  for (const marker of ["reduced_motion", "--reduced-motion", "structuredContent", "manifest.json", "SITE_MOTION_FFPROBE", "zero-byte WebM", "jank validation failed"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")), marker);
  }
});

test("media validation rejects empty files and blocks unverified non-empty files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-motion-media-"));
  const empty = join(dir, "empty.webm");
  const bytes = join(dir, "bytes.webm");
  await writeFile(empty, "");
  await writeFile(bytes, "fixture");
  assert.deepEqual(await validateMedia(empty), { status: "blocked", reason: "zero-byte WebM" });
  assert.deepEqual(
    await withFfprobe("", () => validateMedia(bytes)),
    { status: "blocked", reason: "ffprobe rejected the WebM" },
  );
});

test("remote recorder declares reduced-motion and non-secret identity metadata", async () => {
  const source = await readFile(new URL("../remote/capture.mjs", import.meta.url), "utf8");
  assert.match(source, /reducedMotion/);
  assert.match(source, /RECORDER_VERSION/);
  assert.match(source, /sha256/);
  assert.match(source, /reducedMotion \? "reduce"/);
});

async function withFfprobe(output, callback) {
  const bin = await mkdtemp(join(tmpdir(), "site-motion-ffprobe-"));
  await writeExecutable(bin, "ffprobe", `process.stdout.write(${JSON.stringify(output)});`);
  const previousPath = process.env.PATH;
  const previousContract = process.env.SITE_MOTION_FFPROBE;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.SITE_MOTION_FFPROBE = "true";
  try { return await callback(); } finally {
    process.env.PATH = previousPath;
    if (previousContract === undefined) delete process.env.SITE_MOTION_FFPROBE;
    else process.env.SITE_MOTION_FFPROBE = previousContract;
  }
}

test("validateMedia covers ffprobe success and failure states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-motion-media-"));
  const valid = join(dir, "valid.webm");
  const invalid = join(dir, "invalid.webm");
  await writeFile(valid, "fixture");
  await writeFile(invalid, "fixture");
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "2.5" } }), () => validateMedia(valid)), { status: "valid", format: "matroska,webm", durationSeconds: 2.5 });
  assert.deepEqual(await withFfprobe("not-json", () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned invalid JSON" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "0" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { duration: "2.5" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe(JSON.stringify({}), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: null }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "not-a-number" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe("", () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe rejected the WebM" });
});

test("validateMedia reports unavailable ffprobe as blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-motion-media-"));
  const file = join(dir, "capture.webm");
  await writeFile(file, "fixture");
  const previousPath = process.env.PATH;
  const previousContract = process.env.SITE_MOTION_FFPROBE;
  process.env.PATH = dir;
  process.env.SITE_MOTION_FFPROBE = "true";
  try { assert.deepEqual(await validateMedia(file), { status: "blocked", reason: "ffprobe is unavailable" }); }
  finally { process.env.PATH = previousPath; if (previousContract === undefined) delete process.env.SITE_MOTION_FFPROBE; else process.env.SITE_MOTION_FFPROBE = previousContract; }
});

test("validateMedia rejects a failing ffprobe process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-motion-media-"));
  const file = join(dir, "capture.webm");
  await writeFile(file, "fixture");
  const bin = await mkdtemp(join(tmpdir(), "site-motion-ffprobe-fail-"));
  await writeExecutable(bin, "ffprobe", "process.stderr.write('decoder failed'); process.exit(1);");
  const previousPath = process.env.PATH;
  const previousContract = process.env.SITE_MOTION_FFPROBE;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.SITE_MOTION_FFPROBE = "true";
  try { assert.deepEqual(await validateMedia(file), { status: "blocked", reason: "ffprobe rejected the WebM" }); }
  finally { process.env.PATH = previousPath; if (previousContract === undefined) delete process.env.SITE_MOTION_FFPROBE; else process.env.SITE_MOTION_FFPROBE = previousContract; }
});

test("validateMedia stops when its capture signal is already aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-motion-media-cancel-"));
  const file = join(dir, "capture.webm");
  const bin = await mkdtemp(join(tmpdir(), "site-motion-ffprobe-pending-"));
  await writeFile(file, "fixture");
  await writeExecutable(bin, "ffprobe", "setInterval(() => {}, 1000);");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(() => validateMedia(file, controller.signal), /Capture was cancelled/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("structured capture response retains legacy artifact paths", async () => {
  const source = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(source, /structuredContent:/);
  assert.match(source, /localVideoPath: localVideo/);
  assert.match(source, /localJankPath: localJank/);
});

test("jank validation rejects malformed reports", () => {
  assert.throws(() => validateJankReport(null), /jank validation failed/);
  assert.deepEqual(validateJankReport({}), {});
  assert.deepEqual(validateJankReport({ longTaskCount: 0, longTasks: [] }), { longTaskCount: 0, longTasks: [] });
  assert.deepEqual(validateJankReport({ longTaskCount: 1, longTasks: [] }), { longTaskCount: 1, longTasks: [] });
  assert.throws(() => validateJankReport({ longTaskCount: -1 }), /jank validation failed/);
  assert.throws(() => validateJankReport({ longTaskCount: "invalid" }), /jank validation failed/);
  assert.throws(() => validateJankReport({ longTasks: "invalid" }), /jank validation failed/);
  assert.throws(() => validateJankReport("invalid"), /jank validation failed/);
});
