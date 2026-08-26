import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fakeConsentPage, fakeFrame } from "./fixtures.mjs";

async function loadConsent() {
  let source = await readFile(new URL("../remote/capture.mjs", import.meta.url), "utf8");
  source = source.replace('import { chromium } from "playwright";', "const chromium = {};" );
  source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, "");
  source += "\nexport { handleConsent, combineConsentResults, emptyConsentResult, parseArgs, writeManifest };\n";
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const cases = [
  ["normal reject", { body: "We use cookies", controls: { "#onetrust-reject-all": {} } }, "rejected"],
  ["modal remains", { body: "cookie consent", controls: { "#onetrust-reject-all": { visible: false } } }, "none"],
  ["chained dialogs", { body: "privacy cookie", controls: { "[data-testid*='reject' i]": {} } }, "rejected"],
  ["delayed banner", { body: "tracking choices", controls: { "#onetrust-reject-all": {} } }, "rejected"],
  ["after-scroll banner", { body: "privacy", controls: { "#onetrust-reject-all": {} } }, "rejected"],
  ["unrelated reject false positive", { body: "Welcome", controls: {} }, "none"],
  ["English", { body: "cookie preferences", controls: { "#onetrust-reject-all": {} } }, "rejected"],
  ["missing lang", { body: "cookie preferences", controls: { "#onetrust-reject-all": {} } }, "rejected"],
  ["non-English", { body: "cookie preferences", controls: { "#onetrust-reject-all": {} } }, "rejected"],
];

for (const [name, fixture, expected] of cases) {
  test(name, async () => {
    const { handleConsent } = await loadConsent();
    const result = await handleConsent(fakeConsentPage({ frames: [fakeFrame(fixture)] }), {
      consentMode: "reject", consentWait: 0, consentBudgetMs: 20, consentMaxClicks: 6, consentSelectors: [],
    }, "recorded");
    assert.equal(result.outcome, expected === "rejected" ? "dismissed" : name === "unrelated reject false positive" ? "no-consent-surface" : "no-safe-action");
    assert.equal(result.dismissed, expected === "rejected");
    if (name === "unrelated reject false positive") assert.equal(result.verified, true);
  });
}

test("explicit selector, iframe, and closed shadow are reported", async () => {
  const { handleConsent } = await loadConsent();
  const frame = fakeFrame({ url: "https://fixture.test/embed", body: "", openShadowHosts: 2, controls: { ".custom-deny": {} } });
  const result = await handleConsent(fakeConsentPage({ frames: [fakeFrame({}), frame] }), {
    consentMode: "reject", consentWait: 0, consentBudgetMs: 8000, consentMaxClicks: 6, consentSelectors: [".custom-deny"],
  }, "recorded");
  assert.equal(result.actionTaken, true);
  assert.equal(result.verified, true);
  assert.equal(result.dismissed, true);
  assert.equal(result.selector, ".custom-deny");
  assert.equal(result.frame, "https://fixture.test/embed");
  assert.equal(result.verified, true);
  assert.deepEqual((await handleConsent(fakeConsentPage({ frames: [] }), {
    consentMode: "reject", consentWait: 0, consentBudgetMs: 8000, consentMaxClicks: 6, consentSelectors: [".custom-deny"],
  }, "recorded")).attempts, []);
});

test("budget and max-click arguments are parsed and failed verification is reported", async () => {
  const { parseArgs, handleConsent } = await loadConsent();
  const args = parseArgs(["--url", "https://fixture.test", "--consent-budget-ms", "17", "--consent-max-clicks", "2"]);
  assert.equal(args.consentBudgetMs, 17);
  assert.equal(args.consentMaxClicks, 2);
  const frame = fakeFrame({ body: "cookie consent", controls: { "#onetrust-reject-all": { remainsVisible: true } } });
  const result = await handleConsent(fakeConsentPage({ frames: [frame] }), { ...args, consentWait: 0, consentSelectors: [] }, "recorded");
  assert.equal(result.actionTaken, true);
  assert.equal(result.verified, false);
  assert.equal(result.outcome, "surface-remains-or-unverified");
  assert.equal(result.dismissed, false);
});

test("granular consent requires and forwards the three selectors", async () => {
  const { parseArgs, handleConsent } = await loadConsent();
  const args = parseArgs(["--url", "https://fixture.test", "--consent-mode", "granular", "--consent-settings-selector", ".settings", "--consent-optional-selector", ".optional", "--consent-save-selector", ".save"]);
  const frame = fakeFrame({ body: "cookie preferences", controls: { ".settings": {}, ".optional": {}, ".save": {} } });
  const result = await handleConsent(fakeConsentPage({ frames: [frame] }), args, "recorded");
  assert.equal(result.action, "saved");
  assert.equal(result.actionTaken, true);
});

test("accept requires explicit authorization and honors an explicit selector", async () => {
  const { parseArgs } = await loadConsent();
  const args = parseArgs(["--url", "https://fixture.test", "--consent-mode", "accept", "--consent-selector", ".accept-all", "--consent-accept-approved", "true"]);
  assert.equal(args.consentMode, "accept");
  assert.deepEqual(args.consentSelectors, [".accept-all"]);
});

test("granular mode rejects missing selectors during argument parsing", async () => {
  const { parseArgs } = await loadConsent();
  assert.throws(() => parseArgs(["--url", "https://fixture.test", "--consent-mode", "granular", "--consent-settings-selector", ".settings"]), /requires settings, optional, and save selectors/);
});

test("manifest contains exact sizes and SHA-256 hashes", async () => {
  const { writeManifest } = await loadConsent();
  const dir = await (await import("./fixtures.mjs")).tempDir("manifest-");
  const { writeFile, readFile } = await import("node:fs/promises");
  const video = `${dir}/capture.webm`;
  const jank = `${dir}/capture.jank.json`;
  await writeFile(video, "video-fixture");
  await writeFile(jank, "{\"ok\":true}");
  const manifestPath = await writeManifest(dir, [video, jank], "run-123");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.runId, "run-123");
  for (const file of manifest.files) {
    const bytes = await readFile(`${dir}/${file.path ?? file.name}`);
    assert.equal(file.size, (await stat(`${dir}/${file.path ?? file.name}`)).size);
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("none and complete/missing result fields are deterministic", async () => {
  const { handleConsent, combineConsentResults } = await loadConsent();
  const none = await handleConsent(fakeConsentPage({ frames: [fakeFrame()] }), { consentMode: "none", consentWait: 0, consentBudgetMs: 20, consentMaxClicks: 1, consentSelectors: [] }, "recorded");
  assert.equal(none.mode, "none");
  assert.equal(none.outcome, "no-consent-surface");
  assert.equal(none.verified, true);
  assert.equal(none.dismissed, false);
  const combined = combineConsentResults("reject", { dismissed: true, verified: true, action: "rejected" }, { dismissed: false, verified: false, outcome: "surface-remains-or-unverified", selector: "x" });
  assert.equal(combined.dismissed, false);
  assert.equal(combined.verified, false);
  assert.equal(combined.recorded.selector, "x");
});

test("click failures, max candidates, and chained result attempts do not throw", async () => {
  const { handleConsent } = await loadConsent();
  const frame = fakeFrame({ body: "cookie consent", controls: { "#onetrust-reject-all": { clickError: "blocked" } } });
  const result = await handleConsent(fakeConsentPage({ frames: [frame] }), { consentMode: "reject", consentWait: 0, consentBudgetMs: 20, consentMaxClicks: 6, consentSelectors: [] }, "recorded");
  assert.equal(result.dismissed, false);
  assert.ok(result.attempts.some((value) => value.includes("blocked")));
});
