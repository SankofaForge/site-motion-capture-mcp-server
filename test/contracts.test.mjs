import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
