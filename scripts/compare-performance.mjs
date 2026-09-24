import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const REQUIRED_CELLS = [
  "desktop-full",
  "desktop-reduced",
  "mobile-full",
  "mobile-reduced",
];
export const REQUIRED_RUNS = { cold: 3, warm: 5 };
export const MAX_REGRESSION = 0.2;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function assertContained(root, target, label) {
  const rel = relative(root, target);
  requireValue(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label}: path escapes workspace root`);
}

async function verifiedFile(root, base, relativePath, expectedSize, expectedHash, label) {
  requireValue(typeof relativePath === "string" && relativePath.length > 0 && !isAbsolute(relativePath), `${label}: path must be workspace-relative`);
  const target = resolve(base, relativePath);
  assertContained(root, target, label);
  const actual = await realpath(target);
  assertContained(root, actual, label);
  const info = await stat(actual);
  requireValue(info.isFile() && info.size > 0, `${label}: file is missing or empty`);
  if (expectedSize !== undefined) requireValue(Number.isSafeInteger(expectedSize) && info.size === expectedSize, `${label}: file size mismatch`);
  const hash = createHash("sha256").update(await readFile(actual)).digest("hex");
  requireValue(typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash) && hash === expectedHash, `${label}: SHA-256 mismatch`);
  return actual;
}

async function validateCapture(capture, runId, workspaceRoot, runtime) {
  requireValue(capture && typeof capture === "object" && !Array.isArray(capture), `${runId}: capture must be an object`);
  requireValue(typeof capture.cellId === "string" && REQUIRED_CELLS.includes(capture.cellId), `${runId}: unknown capture cell`);
  requireValue(capture.status === "complete", `${runId}/${capture.cellId}: capture is not complete`);
  requireValue(capture.timedOut === false, `${runId}/${capture.cellId}: capture timed out`);
  requireValue(Number.isFinite(capture.durationMs) && capture.durationMs > 0, `${runId}/${capture.cellId}: durationMs must be positive`);
  requireValue(Number.isFinite(capture.timeoutMs) && capture.timeoutMs > 0, `${runId}/${capture.cellId}: timeoutMs must be positive`);
  requireValue(capture.durationMs <= capture.timeoutMs, `${runId}/${capture.cellId}: capture exceeded its timeout`);
  requireValue(Number.isSafeInteger(capture.peakMemoryBytes) && capture.peakMemoryBytes > 0, `${runId}/${capture.cellId}: peakMemoryBytes must be a positive integer`);
  requireValue(typeof capture.runId === "string" && capture.runId.length > 0, `${runId}/${capture.cellId}: runId is required`);
  requireValue(typeof capture.manifestPath === "string" && capture.manifestPath.length > 0, `${runId}/${capture.cellId}: manifestPath is required`);
  requireValue(typeof capture.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(capture.manifestSha256), `${runId}/${capture.cellId}: manifestSha256 must be a SHA-256 digest`);
  const manifestPath = await verifiedFile(workspaceRoot, workspaceRoot, capture.manifestPath, undefined, capture.manifestSha256, `${runId}/${capture.cellId} manifest`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${runId}/${capture.cellId}: capture-cell manifest is invalid JSON (${error.message})`);
  }
  requireValue(manifest.contractVersion === "capture-cell.v2", `${runId}/${capture.cellId}: unsupported capture-cell manifest`);
  requireValue(manifest.status === "complete" && capture.status === manifest.status, `${runId}/${capture.cellId}: capture status does not match complete manifest`);
  requireValue(manifest.runId === capture.runId, `${runId}/${capture.cellId}: run ID does not match capture-cell manifest`);
  requireValue(manifest.cellId === capture.cellId, `${runId}/${capture.cellId}: cell ID does not match capture-cell manifest`);
  requireValue(manifest.validation?.media?.status === "valid" && manifest.validation?.jank?.status === "valid", `${runId}/${capture.cellId}: manifest validations are incomplete`);
  requireValue(typeof manifest.validation.media.format === "string" && manifest.validation.media.format.toLowerCase().includes("webm")
    && Number.isFinite(manifest.validation.media.durationSeconds) && manifest.validation.media.durationSeconds > 0
    && Number.isSafeInteger(manifest.validation.media.videoStreamCount) && manifest.validation.media.videoStreamCount > 0,
  `${runId}/${capture.cellId}: manifest media evidence is invalid`);
  requireValue(manifest.cleanup === "confirmed", `${runId}/${capture.cellId}: manifest cleanup is not confirmed`);
  const viewport = manifest.viewport;
  requireValue(viewport && Number.isSafeInteger(viewport.width) && viewport.width > 0
    && Number.isSafeInteger(viewport.height) && viewport.height > 0
    && typeof viewport.mobile === "boolean" && typeof viewport.reducedMotion === "boolean",
  `${runId}/${capture.cellId}: manifest viewport is invalid`);
  const manifestCellId = `${viewport.mobile ? "mobile" : "desktop"}-${viewport.reducedMotion ? "reduced" : "full"}`;
  requireValue(manifestCellId === capture.cellId, `${runId}/${capture.cellId}: viewport does not match capture cell`);
  const files = manifest.files;
  requireValue(Array.isArray(files), `${runId}/${capture.cellId}: manifest files are missing`);
  const videoFiles = files.filter((file) => typeof file?.path === "string" && file.path.toLowerCase().endsWith(".webm"));
  const jankFiles = files.filter((file) => typeof file?.path === "string" && file.path.toLowerCase().endsWith(".jank.json"));
  requireValue(videoFiles.length === 1 && jankFiles.length === 1, `${runId}/${capture.cellId}: manifest must bind one video and one jank report`);
  const manifestDirectory = relative(workspaceRoot, manifestPath) ? resolve(manifestPath, "..") : workspaceRoot;
  for (const file of [videoFiles[0], jankFiles[0]]) {
    await verifiedFile(workspaceRoot, manifestDirectory, file.path, file.size, file.sha256, `${runId}/${capture.cellId} artifact ${basename(file.path)}`);
  }
  const attestation = manifest.evidence?.egressAttestation;
  const egress = manifest.evidence?.egress;
  requireValue(manifest.evidence?.gpu?.status === "verified", `${runId}/${capture.cellId}: GPU evidence is not verified`);
  requireValue(egress?.status === "verified" && egress.boundaryId === attestation?.boundaryId
    && egress.networkNamespaceInode === attestation?.networkNamespaceInode
    && Number.isSafeInteger(egress.networkNamespaceInode) && egress.networkNamespaceInode > 0
    && egress.directEgressBlocked === true && egress.approvedProxyProbe === true
    && egress.proxyPolicy === "capture-exact-host.v1",
  `${runId}/${capture.cellId}: egress summary and attestation are invalid`);
  requireValue(manifest.evidence?.consent?.verified === true
    && Array.isArray(manifest.evidence.consent.blindSpots) && manifest.evidence.consent.blindSpots.length === 0,
  `${runId}/${capture.cellId}: consent evidence is incomplete`);
  requireValue(manifest.evidence?.scroll?.completed === true && manifest.evidence.scroll.truncated === false
    && Array.isArray(manifest.evidence.interactionFailures) && manifest.evidence.interactionFailures.length === 0,
  `${runId}/${capture.cellId}: scroll or interaction evidence is incomplete`);
  requireValue(attestation && typeof attestation === "object", `${runId}/${capture.cellId}: full egress attestation is missing`);
  requireValue(attestation && attestation.captureRuntime === runtime.captureRuntime
    && attestation.captureRuntimeVersion === runtime.captureRuntimeVersion
    && attestation.browserExecutable === runtime.browserExecutable
    && attestation.browserVersion === runtime.browserVersion
    && attestation.browserUseVersion === runtime.browserUseVersion,
  `${runId}/${capture.cellId}: runtime metadata does not match manifest attestation`);
  const checkedAt = Date.parse(attestation.checkedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  requireValue(attestation.schemaVersion === "runner-egress-boundary.v1"
    && attestation.approvedHost === egress.approvedHost
    && attestation.directEgressBlocked === true && attestation.proxyPolicy === "capture-exact-host.v1"
    && attestation.controls?.direct?.status === "blocked" && attestation.controls?.proxied?.status === "passed"
    && Number.isFinite(checkedAt) && Number.isFinite(expiresAt) && expiresAt > checkedAt && expiresAt - checkedAt <= 120_000,
  `${runId}/${capture.cellId}: full egress attestation is invalid`);
}

async function validateRouteRuns(runs, label, workspaceRoot, runtime) {
  requireValue(Array.isArray(runs), `${label}: runs must be an array`);
  const ids = new Set();
  const counts = { cold: 0, warm: 0 };
  for (const run of runs) {
    requireValue(run && typeof run === "object" && !Array.isArray(run), `${label}: run must be an object`);
    requireValue(typeof run.id === "string" && run.id.length > 0 && !ids.has(run.id), `${label}: run IDs must be nonempty and unique`);
    ids.add(run.id);
    requireValue(Object.hasOwn(REQUIRED_RUNS, run.temperature), `${label}/${run.id}: temperature must be cold or warm`);
    counts[run.temperature] += 1;
    requireValue(Array.isArray(run.captures) && run.captures.length === REQUIRED_CELLS.length, `${label}/${run.id}: run must contain four captures`);
    const cellIds = new Set();
    for (const capture of run.captures) {
      await validateCapture(capture, run.id, workspaceRoot, runtime);
      requireValue(!cellIds.has(capture.cellId), `${label}/${run.id}: duplicate capture cell ${capture.cellId}`);
      cellIds.add(capture.cellId);
    }
    requireValue(REQUIRED_CELLS.every((cellId) => cellIds.has(cellId)), `${label}/${run.id}: required viewport/motion cell is missing`);
  }
  for (const [temperature, count] of Object.entries(REQUIRED_RUNS)) {
    requireValue(counts[temperature] === count, `${label}: expected ${count} ${temperature} runs, received ${counts[temperature]}`);
  }
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function metrics(runs) {
  const byTemperature = {};
  const byCell = {};
  for (const temperature of Object.keys(REQUIRED_RUNS)) {
    const selected = runs.filter((run) => run.temperature === temperature);
    byTemperature[temperature] = {
      runDurationP95Ms: percentile95(selected.map((run) => run.captures.reduce((sum, capture) => sum + capture.durationMs, 0))),
      peakMemoryBytes: Math.max(...selected.flatMap((run) => run.captures.map((capture) => capture.peakMemoryBytes))),
    };
  }
  for (const cellId of REQUIRED_CELLS) {
    byCell[cellId] = {};
    for (const temperature of ["cold", "warm", "all"]) {
      const captures = runs
        .filter((run) => temperature === "all" || run.temperature === temperature)
        .map((run) => run.captures.find((capture) => capture.cellId === cellId));
      byCell[cellId][temperature] = {
        durationP95Ms: percentile95(captures.map((capture) => capture.durationMs)),
        peakMemoryBytes: Math.max(...captures.map((capture) => capture.peakMemoryBytes)),
      };
    }
  }
  return {
    runDurationP95Ms: percentile95(runs.map((run) => run.captures.reduce((sum, capture) => sum + capture.durationMs, 0))),
    peakMemoryBytes: Math.max(...runs.flatMap((run) => run.captures.map((capture) => capture.peakMemoryBytes))),
    byTemperature,
    byCell,
  };
}

export async function comparePerformanceResults(input) {
  requireValue(input && typeof input === "object" && !Array.isArray(input), "results must be a JSON object");
  requireValue(input.schemaVersion === "capture-performance.v1", "unsupported performance results schemaVersion");
  const runner = input.runner;
  requireValue(runner && typeof runner === "object", "runner metadata is required");
  for (const key of ["id", "machineFingerprint", "fixtureSetId"]) {
    requireValue(typeof runner[key] === "string" && runner[key].trim().length > 0, `runner.${key} is required`);
  }
  const measurementProtocol = input.measurementProtocol;
  requireValue(measurementProtocol && typeof measurementProtocol === "object", "measurementProtocol is required");
  for (const key of ["cold", "warm"]) {
    requireValue(typeof measurementProtocol[key] === "string" && measurementProtocol[key].trim().length > 0, `measurementProtocol.${key} is required`);
  }
  requireValue(typeof input.workspaceRoot === "string" && isAbsolute(input.workspaceRoot), "workspaceRoot must be an absolute directory path");
  const workspaceRoot = await realpath(input.workspaceRoot);
  requireValue((await stat(workspaceRoot)).isDirectory(), "workspaceRoot must be a directory");
  requireValue(input.rollbackBaseline?.runner && input.browserUseCandidate?.runner, "both route runner records are required");
  for (const [route, routeData] of [["rollbackBaseline", input.rollbackBaseline], ["browserUseCandidate", input.browserUseCandidate]]) {
    requireValue(routeData.runner.id === runner.id
      && routeData.runner.machineFingerprint === runner.machineFingerprint
      && routeData.runner.fixtureSetId === runner.fixtureSetId,
    `${route}: runner, machine, and fixture set must match the declared runner`);
    const runtime = routeData.runtime;
    requireValue(runtime && typeof runtime === "object", `${route}: runtime metadata is required`);
    for (const key of ["captureRuntime", "captureRuntimeVersion", "browserExecutable", "browserVersion", "browserUseVersion", "mediaToolVersion"]) {
      requireValue(typeof runtime[key] === "string" && runtime[key].trim().length > 0, `${route}.runtime.${key} is required`);
    }
    requireValue(runtime.captureRuntime === (route === "rollbackBaseline" ? "site-motion-capture" : "browser-use"), `${route}: unexpected capture runtime`);
    await validateRouteRuns(routeData.runs, route, workspaceRoot, runtime);
  }

  const baseline = metrics(input.rollbackBaseline.runs);
  const candidate = metrics(input.browserUseCandidate.runs);
  const comparisons = [];
  const cellComparisons = [];
  for (const temperature of ["cold", "warm", "all"]) {
    const baselineMetrics = temperature === "all" ? baseline : baseline.byTemperature[temperature];
    const candidateMetrics = temperature === "all" ? candidate : candidate.byTemperature[temperature];
    comparisons.push({
      temperature,
      baselineRunDurationP95Ms: baselineMetrics.runDurationP95Ms,
      candidateRunDurationP95Ms: candidateMetrics.runDurationP95Ms,
      durationRatio: candidateMetrics.runDurationP95Ms / baselineMetrics.runDurationP95Ms,
      durationWithinTwentyPercent: candidateMetrics.runDurationP95Ms <= baselineMetrics.runDurationP95Ms * (1 + MAX_REGRESSION),
      baselinePeakMemoryBytes: baselineMetrics.peakMemoryBytes,
      candidatePeakMemoryBytes: candidateMetrics.peakMemoryBytes,
      peakMemoryRatio: candidateMetrics.peakMemoryBytes / baselineMetrics.peakMemoryBytes,
      peakMemoryWithinTwentyPercent: candidateMetrics.peakMemoryBytes <= baselineMetrics.peakMemoryBytes * (1 + MAX_REGRESSION),
    });
  }
  for (const cellId of REQUIRED_CELLS) {
    for (const temperature of ["cold", "warm", "all"]) {
      const baselineMetric = baseline.byCell[cellId][temperature];
      const candidateMetric = candidate.byCell[cellId][temperature];
      cellComparisons.push({
        cellId,
        temperature,
        baselineDurationP95Ms: baselineMetric.durationP95Ms,
        candidateDurationP95Ms: candidateMetric.durationP95Ms,
        durationRatio: candidateMetric.durationP95Ms / baselineMetric.durationP95Ms,
        durationWithinTwentyPercent: candidateMetric.durationP95Ms <= baselineMetric.durationP95Ms * (1 + MAX_REGRESSION),
        baselinePeakMemoryBytes: baselineMetric.peakMemoryBytes,
        candidatePeakMemoryBytes: candidateMetric.peakMemoryBytes,
        peakMemoryRatio: candidateMetric.peakMemoryBytes / baselineMetric.peakMemoryBytes,
        peakMemoryWithinTwentyPercent: candidateMetric.peakMemoryBytes <= baselineMetric.peakMemoryBytes * (1 + MAX_REGRESSION),
      });
    }
  }
  const passed = comparisons.every((item) => item.durationWithinTwentyPercent && item.peakMemoryWithinTwentyPercent)
    && cellComparisons.every((item) => item.durationWithinTwentyPercent && item.peakMemoryWithinTwentyPercent);
  return {
    schemaVersion: "capture-performance-report.v1",
    status: passed ? "passed" : "failed",
    passed,
    runner,
    workspaceRoot,
    measurementProtocol,
    runtimes: {
      rollbackBaseline: input.rollbackBaseline.runtime,
      browserUseCandidate: input.browserUseCandidate.runtime,
    },
    requiredRuns: REQUIRED_RUNS,
    requiredCells: REQUIRED_CELLS,
    maxRegression: MAX_REGRESSION,
    baseline,
    candidate,
    comparisons,
    cellComparisons,
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) {
    console.error("Usage: node scripts/compare-performance.mjs <capture-performance.v1.json>");
    process.exitCode = 2;
    return;
  }
  try {
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const report = await comparePerformanceResults(input);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Performance acceptance input is invalid: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
