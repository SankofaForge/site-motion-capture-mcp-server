import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEgressEvidence, validateJankReport, validateMedia } from "../index.mjs";
import { writeExecutable } from "./fixtures.mjs";
import { fixtureEgressAttestation } from "./capture-cell-fixtures.mjs";

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
  const validProbe = JSON.stringify({ format: { format_name: "matroska,webm", duration: "2.5" }, streams: [{ codec_type: "video" }] });
  assert.deepEqual(await withFfprobe(validProbe, () => validateMedia(valid)), { status: "valid", format: "matroska,webm", durationSeconds: 2.5, videoStreamCount: 1 });
  assert.deepEqual(await withFfprobe("not-json", () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned invalid JSON" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "0" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { duration: "2.5" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe did not identify WebM format" });
  assert.deepEqual(await withFfprobe(JSON.stringify({}), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe did not identify WebM format" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: null }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe did not identify WebM format" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "not-a-number" } }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe returned no positive duration" });
  assert.deepEqual(await withFfprobe("", () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe rejected the WebM" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska", duration: "2.5" }, streams: [{ codec_type: "video" }] }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe did not identify WebM format" });
  assert.deepEqual(await withFfprobe(JSON.stringify({ format: { format_name: "matroska,webm", duration: "2.5" }, streams: [{ codec_type: "audio" }] }), () => validateMedia(invalid)), { status: "blocked", reason: "ffprobe found no video stream" });
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
  const report = {
    schemaVersion: "jank-report.v1",
    status: "valid",
    finalUrl: "https://fixture.test/",
    viewport: { width: 1920, height: 1080, mobile: false, reducedMotion: false },
    longTaskCount: 0,
    longTasks: [],
    totalBlockingTimeMs: 0,
    thresholdMs: 200,
    choppy: false,
    byPhase: {},
    observerError: null,
    consent: { mode: "reject", verified: true, dismissed: false, actionTaken: false, blindSpots: [] },
    scroll: { requested: true, completed: true, timedOut: false, truncated: false, actualDistance: 100, completedDistance: 100 },
    interactionFailures: [],
    interactions: [],
  };
  assert.deepEqual(validateJankReport(report), report);
  assert.throws(() => validateJankReport({ ...report, longTaskCount: -1 }), /jank validation failed/);
  assert.throws(() => validateJankReport({ ...report, longTaskCount: 1 }), /jank validation failed/);
  assert.throws(() => validateJankReport({ ...report, longTasks: "invalid" }), /jank validation failed/);
  assert.throws(() => validateJankReport({ ...report, viewport: { ...report.viewport, width: 390 } }, { width: 1920, height: 1080, mobile: false, reducedMotion: false }), /requested viewport mismatch/);
  assert.throws(() => validateJankReport({ ...report, consent: { verified: true, blindSpots: "unknown" } }), /jank validation failed/);
  assert.throws(() => validateJankReport("invalid"), /jank validation failed/);
});

test("capture-cell egress evidence must prove the runner boundary for its exact URL host", () => {
  const evidence = {
    status: "verified",
    boundaryId: "boundary-123",
    directEgressBlocked: true,
    proxyPolicy: "capture-exact-host.v1",
    approvedHost: "fixture.test",
    approvedProxyProbe: true,
    networkNamespaceInode: 4026532001,
  };
  const attestation = fixtureEgressAttestation({ host: "fixture.test", boundaryId: evidence.boundaryId, namespaceInode: evidence.networkNamespaceInode });
  assert.equal(validateEgressEvidence(evidence, "https://fixture.test/path", attestation), evidence);
  assert.throws(() => validateEgressEvidence({ ...evidence, approvedHost: "other.test" }, "https://fixture.test/", attestation), /egress validation failed/);
  assert.throws(() => validateEgressEvidence({ ...evidence, directEgressBlocked: false }, "https://fixture.test/", attestation), /egress validation failed/);
  assert.throws(() => validateEgressEvidence({ ...evidence, networkNamespaceInode: "4026532001" }, "https://fixture.test/", attestation), /egress validation failed/);
  assert.throws(() => validateEgressEvidence(evidence, "https://fixture.test/"), /egress validation failed/);
  assert.throws(() => validateEgressEvidence(evidence, "https://fixture.test/", { ...attestation, networkNamespaceInode: "4026532001" }), /egress validation failed/);
});

test("rollback capture binds touch emulation and Chromium process to the attested namespace", async () => {
  const recorder = await readFile(new URL("../remote/capture.mjs", import.meta.url), "utf8");
  const bridge = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(recorder, /isMobile: args\.mobile/);
  assert.match(recorder, /hasTouch: args\.mobile/);
  assert.match(recorder, /browserServer\.process\(\)/);
  assert.match(recorder, /\/proc\/\$\{browserProcess\.pid\}\/ns\/net/);
  assert.match(recorder, /egress: egressEvidence, egressAttestation/);
  assert.match(bridge, /wait "\$worker_pid"/);
  assert.match(bridge, /egressAttestation: manifest\.egressAttestation/);
  assert.match(bridge, /Keep the remote run directory when process exit or evidence validation is uncertain/);
});
