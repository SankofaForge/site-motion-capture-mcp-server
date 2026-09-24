import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparePerformanceResults, REQUIRED_CELLS } from "../scripts/compare-performance.mjs";
import { tempDir } from "./fixtures.mjs";

const runtimes = {
  rollbackBaseline: {
    captureRuntime: "site-motion-capture",
    captureRuntimeVersion: "1.2.0",
    browserExecutable: "/opt/chromium/chrome",
    browserVersion: "140.0.1.2",
    browserUseVersion: "0.13.10",
    mediaToolVersion: "ffmpeg 7.1",
  },
  browserUseCandidate: {
    captureRuntime: "browser-use",
    captureRuntimeVersion: "0.13.10",
    browserExecutable: "/opt/chromium/chrome",
    browserVersion: "140.0.1.2",
    browserUseVersion: "0.13.10",
    mediaToolVersion: "ffmpeg 7.1",
  },
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeManifest(root, route, run, cellId, manifestOverrides = {}) {
  const runId = `${route}-${run.id}-${cellId}`;
  const directory = join(root, route, run.id, cellId);
  await mkdir(directory, { recursive: true });
  const video = Buffer.from(`${runId}-video`);
  const jank = Buffer.from(`${runId}-jank`);
  const videoPath = `${cellId}.webm`;
  const jankPath = `${cellId}.jank.json`;
  await writeFile(join(directory, videoPath), video);
  await writeFile(join(directory, jankPath), jank);
  const runtime = runtimes[route];
  const attestation = {
    schemaVersion: "runner-egress-boundary.v1",
    boundaryId: `boundary-${runId}`,
    checkedAt: "2026-09-23T10:00:00Z",
    expiresAt: "2026-09-23T10:01:00Z",
    runnerInstanceId: "runner-7",
    browserExecutable: runtime.browserExecutable,
    browserVersion: runtime.browserVersion,
    captureRuntime: runtime.captureRuntime,
    captureRuntimeVersion: runtime.captureRuntimeVersion,
    browserUseVersion: runtime.browserUseVersion,
    approvedHost: "fixture.test",
    directEgressBlocked: true,
    proxyPolicy: "capture-exact-host.v1",
    networkNamespaceInode: 4026532001,
    controls: { direct: { status: "blocked" }, proxied: { status: "passed" } },
  };
  const mobile = cellId.startsWith("mobile-");
  const reducedMotion = cellId.endsWith("reduced");
  const manifest = {
    contractVersion: "capture-cell.v2",
    runId,
    cellId,
    status: "complete",
    finalUrl: "https://fixture.test/",
    viewport: { width: mobile ? 390 : 1920, height: mobile ? 844 : 1080, mobile, reducedMotion },
    validation: {
      media: { status: "valid", format: "matroska,webm", durationSeconds: 1, videoStreamCount: 1 },
      jank: { status: "valid" },
    },
    cleanup: "confirmed",
    files: [
      { path: videoPath, size: video.length, sha256: digest(video) },
      { path: jankPath, size: jank.length, sha256: digest(jank) },
    ],
    evidence: {
      gpu: { status: "verified" },
      egress: { status: "verified", boundaryId: attestation.boundaryId, approvedHost: "fixture.test", networkNamespaceInode: 4026532001, directEgressBlocked: true, approvedProxyProbe: true, proxyPolicy: "capture-exact-host.v1" },
      egressAttestation: attestation,
      consent: { mode: "reject", action: "rejected", actionTaken: true, verified: true, blindSpots: [] },
      scroll: { completed: true, truncated: false },
      interactionFailures: [],
    },
    ...manifestOverrides,
  };
  const path = join(directory, `${cellId}.capture-cell.v2.json`);
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path, bytes);
  return {
    cellId,
    runId,
    status: "complete",
    timedOut: false,
    durationMs: 10000,
    timeoutMs: 180000,
    peakMemoryBytes: 1_000_000,
    manifestPath: path.slice(root.length + 1),
    manifestSha256: digest(bytes),
  };
}

async function routeRuns(root, route, { durationMs = 10000, peakMemoryBytes = 1_000_000, slow = null } = {}) {
  const temperatures = ["cold", "cold", "cold", "warm", "warm", "warm", "warm", "warm"];
  const runs = [];
  for (let index = 0; index < temperatures.length; index += 1) {
    const run = { id: `${temperatures[index]}-${index}`, temperature: temperatures[index], captures: [] };
    for (const cellId of REQUIRED_CELLS) {
      const capture = await writeManifest(root, route, run, cellId);
      capture.durationMs = slow?.cellId === cellId && slow.runIndex === index ? durationMs * 1.3 : durationMs;
      capture.peakMemoryBytes = slow?.memoryCellId === cellId && slow.memoryRunIndex === index ? peakMemoryBytes * 1.3 : peakMemoryBytes;
      run.captures.push(capture);
    }
    runs.push(run);
  }
  return runs;
}

async function resultSet(overrides = {}) {
  const workspaceRoot = await tempDir("capture-perf-evidence-");
  const runner = { id: "runner-7", machineFingerprint: "machine-sha256", fixtureSetId: "fixtures-2026-09" };
  const baselineRuns = await routeRuns(workspaceRoot, "rollbackBaseline", overrides.baseline);
  const candidateRuns = await routeRuns(workspaceRoot, "browserUseCandidate", {
    durationMs: 11000,
    peakMemoryBytes: 1_100_000,
    ...overrides.candidate,
  });
  return {
    workspaceRoot,
    input: {
      schemaVersion: "capture-performance.v1",
      workspaceRoot,
      runner,
      measurementProtocol: { cold: "cold-start-before-warm-up", warm: "after-one-unmeasured-warm-up-matrix" },
      rollbackBaseline: { runner: { ...runner }, runtime: runtimes.rollbackBaseline, runs: baselineRuns },
      browserUseCandidate: { runner: { ...runner }, runtime: runtimes.browserUseCandidate, runs: candidateRuns },
    },
  };
}

async function withResultSet(overrides, run) {
  const sample = await resultSet(overrides);
  try {
    return await run(sample);
  } finally {
    await rm(sample.workspaceRoot, { recursive: true, force: true });
  }
}

test("performance comparison binds artifacts and checks per-cell and matrix p95 within 20 percent", async () => {
  await withResultSet({}, async ({ input }) => {
    const report = await comparePerformanceResults(input);
    assert.equal(report.status, "passed");
    assert.equal(report.baseline.runDurationP95Ms, 40000);
    assert.equal(report.candidate.runDurationP95Ms, 44000);
    assert.equal(report.cellComparisons.length, REQUIRED_CELLS.length * 3);
    assert.equal(report.runtimes.rollbackBaseline.captureRuntime, "site-motion-capture");
    assert.equal(report.runtimes.browserUseCandidate.captureRuntime, "browser-use");
  });
});

test("a slow cell fails its own p95 gate even when matrix duration remains within 20 percent", async () => {
  await withResultSet({ candidate: { durationMs: 10000, peakMemoryBytes: 1_000_000, slow: { runIndex: 0, cellId: "mobile-reduced" } } }, async ({ input }) => {
    const report = await comparePerformanceResults(input);
    const matrixCold = report.comparisons.find((item) => item.temperature === "cold");
    const slowCell = report.cellComparisons.find((item) => item.cellId === "mobile-reduced" && item.temperature === "cold");
    assert.equal(matrixCold.durationWithinTwentyPercent, true);
    assert.equal(slowCell.durationWithinTwentyPercent, false);
    assert.equal(report.status, "failed");
  });
});

test("performance comparison rejects excessive memory regression and capture timeout failures", async () => {
  await withResultSet({ candidate: { durationMs: 10000, peakMemoryBytes: 1_000_000, slow: { memoryCellId: "desktop-full", memoryRunIndex: 4 } } }, async ({ input }) => {
    const report = await comparePerformanceResults(input);
    assert.equal(report.status, "failed");
    assert.equal(report.cellComparisons.find((item) => item.cellId === "desktop-full" && item.temperature === "warm").peakMemoryWithinTwentyPercent, false);
    input.browserUseCandidate.runs[0].captures[0].timedOut = true;
    await assert.rejects(() => comparePerformanceResults(input), /capture timed out/);
  });
});

test("performance comparison rejects missing, mismatched, or escaping manifest evidence", async () => {
  await withResultSet({}, async ({ input }) => {
    const capture = input.browserUseCandidate.runs[0].captures[0];
    const manifestPath = join(input.workspaceRoot, capture.manifestPath);
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    const mismatchedCell = { ...original, cellId: "desktop-reduced" };
    const cellBytes = Buffer.from(JSON.stringify(mismatchedCell));
    await writeFile(manifestPath, cellBytes);
    capture.manifestSha256 = digest(cellBytes);
    await assert.rejects(() => comparePerformanceResults(input), /cell ID does not match capture-cell manifest/);

    const incomplete = { ...original, status: "partial" };
    const incompleteBytes = Buffer.from(JSON.stringify(incomplete));
    await writeFile(manifestPath, incompleteBytes);
    capture.manifestSha256 = digest(incompleteBytes);
    await assert.rejects(() => comparePerformanceResults(input), /status does not match complete manifest/);

    const originalBytes = Buffer.from(JSON.stringify(original));
    await writeFile(manifestPath, originalBytes);
    capture.manifestSha256 = digest(originalBytes);
    const expectedHash = capture.manifestSha256;
    capture.manifestSha256 = "0".repeat(64);
    await assert.rejects(() => comparePerformanceResults(input), /SHA-256 mismatch/);
    capture.manifestSha256 = expectedHash;
    input.browserUseCandidate.runs[0].captures[0].manifestPath = "../outside.json";
    await assert.rejects(() => comparePerformanceResults(input), /path escapes workspace root/);
    capture.manifestPath = input.rollbackBaseline.runs[0].captures[0].manifestPath;
    capture.manifestSha256 = input.rollbackBaseline.runs[0].captures[0].manifestSha256;
    await assert.rejects(() => comparePerformanceResults(input), /run ID does not match capture-cell manifest/);

    const outsideRoot = await tempDir("capture-perf-outside-");
    try {
      const linkPath = join(input.workspaceRoot, "manifest-link.json");
      const outsidePath = join(outsideRoot, "manifest.json");
      const outsideBytes = Buffer.from(JSON.stringify(original));
      await writeFile(outsidePath, outsideBytes);
      await symlink(outsidePath, linkPath);
      capture.manifestPath = "manifest-link.json";
      capture.manifestSha256 = digest(outsideBytes);
      await assert.rejects(() => comparePerformanceResults(input), /path escapes workspace root/);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("performance comparison requires three cold and five warm matrices per route", async () => {
  await withResultSet({}, async ({ input }) => {
    input.browserUseCandidate.runs.pop();
    await assert.rejects(() => comparePerformanceResults(input), /expected 5 warm runs/);
  });
});
