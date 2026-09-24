import { createHash } from "node:crypto";

export const FIXTURE_URL = "https://example.test/";
export const FIXTURE_VIEWPORT = { width: 1440, height: 900, mobile: false, reducedMotion: false };
export const FIXTURE_EGRESS = {
  status: "verified",
  boundaryId: "fixture-boundary",
  directEgressBlocked: true,
  proxyPolicy: "capture-exact-host.v1",
  approvedHost: "example.test",
  approvedProxyProbe: true,
  networkNamespaceInode: 4026532001,
};

export function fixtureEgressAttestation({ host = "example.test", boundaryId = "fixture-boundary", namespaceInode = 4026532001 } = {}) {
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    schemaVersion: "runner-egress-boundary.v1",
    boundaryId,
    checkedAt,
    expiresAt,
    runnerInstanceId: "fixture-runner",
    browserExecutable: "/usr/bin/chromium",
    browserVersion: "140.0.1.2",
    captureRuntime: "site-motion-capture",
    captureRuntimeVersion: "1.2.0",
    browserUseVersion: "0.13.10",
    approvedHost: host,
    directEgressBlocked: true,
    proxyPolicy: "capture-exact-host.v1",
    networkNamespaceInode: namespaceInode,
    controls: { direct: { status: "blocked" }, proxied: { status: "passed" } },
  };
}

function fixtureConsent(consentMode) {
  const details = {
    none: { action: "untouched", outcome: "no-consent-surface", actionTaken: false, dismissed: false },
    reject: { action: "rejected", outcome: "verified-action", actionTaken: true, dismissed: true },
    accept: { action: "accepted", outcome: "verified-action", actionTaken: true, dismissed: true },
    granular: { action: "saved", outcome: "verified-action", actionTaken: true, dismissed: true },
  }[consentMode];
  return { mode: consentMode, verified: true, blindSpots: [], ...details };
}

export function validJankReport({ consentMode = "reject", viewport = FIXTURE_VIEWPORT, finalUrl = FIXTURE_URL, status = "valid" } = {}) {
  return {
    schemaVersion: "jank-report.v1",
    status,
    finalUrl,
    viewport,
    longTaskCount: 0,
    longTasks: [],
    totalBlockingTimeMs: 0,
    thresholdMs: 200,
    choppy: false,
    byPhase: {},
    observerError: null,
    consent: fixtureConsent(consentMode),
    scroll: { requested: true, completed: true, timedOut: false, truncated: false, actualDistance: 500, completedDistance: 500 },
    interactions: [],
    interactionFailures: [],
  };
}

export function fileEntry(path, bytes) {
  return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function validCaptureCell({ runId, name, video, jank, viewport = FIXTURE_VIEWPORT, finalUrl = FIXTURE_URL, consentMode = "reject" }) {
  const egressAttestation = fixtureEgressAttestation();
  return {
    contractVersion: "capture-cell.v2",
    runId,
    finalUrl,
    viewport,
    files: [fileEntry(`${name}.webm`, video), fileEntry(`${name}.jank.json`, jank)],
    egress: { ...FIXTURE_EGRESS },
    egressAttestation,
    validation: { media: { status: "valid", format: "matroska,webm", durationSeconds: 1, videoStreamCount: 1 }, jank: { status: "valid" } },
    cleanup: { confirmed: true },
    evidence: {
      gpu: { status: "verified" },
      consent: validJankReport({ consentMode, viewport, finalUrl }).consent,
      egress: { ...FIXTURE_EGRESS },
      egressAttestation,
      scroll: validJankReport({ consentMode, viewport, finalUrl }).scroll,
      interactionFailures: [],
    },
  };
}

export function captureCellShimSource({ name, mobile = false, reducedMotion = false, consentMode = "reject", finalUrl = FIXTURE_URL, jankStatus = "valid" } = {}) {
  const viewport = { width: mobile ? 390 : 1920, height: mobile ? 844 : 1080, mobile, reducedMotion };
  const video = Buffer.from("fake-webm-video-data");
  const report = validJankReport({ consentMode, viewport, finalUrl, status: jankStatus });
  if (jankStatus === "partial") report.scroll = { requested: true, completed: false, timedOut: false, truncated: true, actualDistance: 0, completedDistance: 0 };
  const jank = Buffer.from(JSON.stringify(report));
  const cell = validCaptureCell({ runId: "fixture-run", name, video, jank, viewport, finalUrl, consentMode });
  return `
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const dest = process.argv.at(-1);
const video = Buffer.from(${JSON.stringify(video.toString())});
const jank = Buffer.from(${JSON.stringify(jank.toString())});
const cell = ${JSON.stringify(cell)};
cell.runId = path.basename(path.dirname(dest)).replace(/^\\.capture-/, "");
cell.files = [
  { path: ${JSON.stringify(`${name}.webm`)}, size: video.length, sha256: crypto.createHash("sha256").update(video).digest("hex") },
  { path: ${JSON.stringify(`${name}.jank.json`)}, size: jank.length, sha256: crypto.createHash("sha256").update(jank).digest("hex") },
];
if (dest.endsWith("manifest.json")) fs.writeFileSync(dest, JSON.stringify(cell));
else if (dest.endsWith(".webm")) fs.writeFileSync(dest, video);
else fs.writeFileSync(dest, jank);
`;
}
