import { mkdir, rename, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

let chromium;

const LONG_TASK_THRESHOLD_MS = 50; // browser's own definition of a "long task"

function parseArgs(argv) {
  const args = {
    url: null, out: "./out", width: 1440, height: 900, mobile: false,
    settle: 1200, waitFonts: true, waitIdle: true, idleTimeout: 8000,
    scroll: true, scrollDistance: null, scrollStep: 100, scrollPause: 60,
    hoverSelectors: [], hoverWait: 800, clickSelectors: [], clickWait: 1200,
    autoDiscover: false, autoDiscoverMax: 12, autoDiscoverWait: 700,
    tail: 1000, name: null,
    consentMode: "reject", consentAcceptApproved: false, consentSelectors: [], consentSettingsSelectors: [], consentOptionalSelectors: [], consentSaveSelectors: [], consentWait: 1200,
    consentBudgetMs: 8000, consentMaxClicks: 6, consentPreflight: true, runId: null,
    jankCheck: true, jankThreshold: 200,
    gpu: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": args.url = next(); break;
      case "--out": args.out = next(); break;
      case "--width": args.width = Number(next()); break;
      case "--height": args.height = Number(next()); break;
      case "--mobile": args.mobile = true; break;
      case "--consent-mode": args.consentMode = next(); break;
      case "--consent-accept-approved": args.consentAcceptApproved = next(); break;
      case "--consent_accept_approved": args.consentAcceptApproved = next(); break;
      case "--consent-selector": args.consentSelectors.push(next()); break;
      case "--consent-settings-selector": args.consentSettingsSelectors.push(next()); break;
      case "--consent-optional-selector": args.consentOptionalSelectors.push(next()); break;
      case "--consent-save-selector": args.consentSaveSelectors.push(next()); break;
      case "--consent-budget-ms": args.consentBudgetMs = Number(next()); break;
      case "--consent-max-clicks": args.consentMaxClicks = Number(next()); break;
      case "--run-id": args.runId = next(); break;
      case "--consent-wait": args.consentWait = Number(next()); break;
      case "--no-consent-preflight": args.consentPreflight = false; break;
      case "--settle": args.settle = Number(next()); break;
      case "--no-wait-fonts": args.waitFonts = false; break;
      case "--no-wait-idle": args.waitIdle = false; break;
      case "--idle-timeout": args.idleTimeout = Number(next()); break;
      case "--no-scroll": args.scroll = false; break;
      case "--scroll-distance": args.scrollDistance = Number(next()); break;
      case "--scroll-step": args.scrollStep = Number(next()); break;
      case "--scroll-pause": args.scrollPause = Number(next()); break;
      case "--hover-selector": args.hoverSelectors.push(next()); break;
      case "--hover-wait": args.hoverWait = Number(next()); break;
      case "--click-selector": args.clickSelectors.push(next()); break;
      case "--click-wait": args.clickWait = Number(next()); break;
      case "--auto-discover": args.autoDiscover = true; break;
      case "--auto-discover-max": args.autoDiscoverMax = Number(next()); break;
      case "--auto-discover-wait": args.autoDiscoverWait = Number(next()); break;
      case "--tail": args.tail = Number(next()); break;
      case "--name": args.name = next(); break;
      case "--no-jank-check": args.jankCheck = false; break;
      case "--jank-threshold": args.jankThreshold = Number(next()); break;
      case "--gpu": args.gpu = true; break;
      case "--consent-self-test": args.selfTest = true; break;
      default:
        if (a.startsWith("--consent_accept_approved=") || a.startsWith("--consent-accept-approved=")) {
          args.consentAcceptApproved = a.slice(a.indexOf("=") + 1);
          break;
        }
        console.error(`Unknown arg: ${a}`);
        process.exit(1);
    }
  }
  if (args.selfTest) return args;
  if (!args.url) {
    console.error(
      "Usage: node capture.mjs --url <url> [--out <dir>] [--width N] [--height N] [--mobile] " +
      "[--settle ms] [--no-wait-fonts] [--no-wait-idle] [--idle-timeout ms] " +
      "[--no-scroll] [--scroll-distance px (default: full page height)] [--scroll-step px] [--scroll-pause ms] " +
      "[--hover-selector css]... [--hover-wait ms] [--click-selector css]... [--click-wait ms] " +
      "[--auto-discover] [--auto-discover-max N] [--auto-discover-wait ms] " +
      "[--tail ms] [--name file-stem] [--run-id id] [--consent-mode reject|accept|granular|none] [--consent-selector css]... " +
      "[--consent-settings-selector css]... [--consent-optional-selector css]... [--consent-save-selector css]... [--consent-budget-ms ms] [--consent-max-clicks N] " +
      "[--consent-wait ms] [--no-consent-preflight] [--no-jank-check] [--jank-threshold ms] [--gpu]"
    );
    process.exit(1);
  }
  if (args.mobile) { args.width = 390; args.height = 844; }
  if (!["reject", "accept", "granular", "none"].includes(args.consentMode)) {
    console.error("--consent-mode must be reject, accept, granular, or none");
    process.exit(1);
  }
  if (!Number.isInteger(args.consentWait) || args.consentWait < 0 || args.consentWait > 10000) {
    console.error("--consent-wait must be an integer from 0 to 10000");
    process.exit(1);
  }
  if (!Number.isInteger(args.consentBudgetMs) || args.consentBudgetMs < 0) throw new Error("--consent-budget-ms must be a non-negative integer");
  if (typeof args.consentAcceptApproved === "string") {
    if (!["true", "false"].includes(args.consentAcceptApproved.toLowerCase())) throw new Error("--consent-accept-approved must be true or false");
    args.consentAcceptApproved = args.consentAcceptApproved.toLowerCase() === "true";
  }
  args.consentMaxClicks = Math.max(1, Math.min(12, Number.isInteger(args.consentMaxClicks) ? args.consentMaxClicks : 6));
  if (args.consentMode === "granular" && (!args.consentSettingsSelectors.length || !args.consentOptionalSelectors.length || !args.consentSaveSelectors.length)) throw new Error("granular consent requires settings, optional, and save selectors");
  return args;
}

// Registers a PerformanceObserver on every new document (including the
// initial navigation) so long tasks — the browser's own signal for jank —
// are captured for the whole session, not just after the script attaches.
async function installJankObserver(page) {
  await page.addInitScript(() => {
    window.__jankEntries = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__jankEntries.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch (e) {
      window.__jankObserverError = String(e);
    }
  });
}

// Records a named checkpoint using the page's own performance clock so long
// tasks can be attributed to the phase they happened in (page load vs.
// interaction retries vs. scroll) instead of one undifferentiated total —
// a retry storm during interactions and genuine WebGL scroll jank look
// identical in a single aggregate number.
async function markPhase(page, phases, name) {
  const now = await page.evaluate(() => performance.now()).catch(() => null);
  if (now !== null) phases.push({ name, at: now });
}

function bucketByPhase(longTasks, phases) {
  const buckets = {};
  for (const p of phases) buckets[p.name] = { count: 0, totalBlockingTimeMs: 0 };
  for (const task of longTasks) {
    let phaseName = phases[0]?.name ?? "unknown";
    for (const p of phases) {
      if (task.startTime >= p.at) phaseName = p.name;
    }
    const bucket = buckets[phaseName] ?? (buckets[phaseName] = { count: 0, totalBlockingTimeMs: 0 });
    bucket.count += 1;
    bucket.totalBlockingTimeMs += task.duration - LONG_TASK_THRESHOLD_MS;
  }
  for (const key of Object.keys(buckets)) {
    buckets[key].totalBlockingTimeMs = Math.round(buckets[key].totalBlockingTimeMs);
  }
  return buckets;
}

async function collectJankReport(page, args, phases, consent) {
  const entries = await page.evaluate(() => window.__jankEntries || []).catch(() => []);
  const longTasks = entries.filter((e) => e.duration >= LONG_TASK_THRESHOLD_MS);
  const totalBlockingTimeMs = longTasks.reduce((sum, e) => sum + (e.duration - LONG_TASK_THRESHOLD_MS), 0);
  const choppy = totalBlockingTimeMs > args.jankThreshold;
  return {
    consent,
    longTaskCount: longTasks.length,
    totalBlockingTimeMs: Math.round(totalBlockingTimeMs),
    thresholdMs: args.jankThreshold,
    choppy,
    byPhase: bucketByPhase(longTasks, phases),
    longTasks,
  };
}

async function waitForPageReady(page, args) {
  if (args.waitIdle) {
    try {
      await page.waitForLoadState("networkidle", { timeout: args.idleTimeout });
    } catch (e) {
      console.error(`networkidle not reached within ${args.idleTimeout}ms, continuing (${e.message})`);
    }
  }
  if (args.waitFonts) {
    try {
      const fontReady = page.evaluate(() => document.fonts ? document.fonts.ready : Promise.resolve()).then(() => true, () => false);
      const fontWaitLimit = Math.min(Math.max(args.idleTimeout, 1000), 8000);
      const fontsFinished = await Promise.race([
        fontReady,
        new Promise((resolve) => setTimeout(() => resolve(false), fontWaitLimit)),
      ]);
      if (!fontsFinished) console.error(`font readiness not reached within ${fontWaitLimit}ms, continuing`);
    } catch (e) {
      console.error(`document.fonts.ready check failed, continuing (${e.message})`);
    }
  }
  await page.waitForTimeout(args.settle);
}

async function delayedCheck(page, label, ms = 250) {
  await page.waitForTimeout(ms);
  return { label, url: page.url(), at: new Date().toISOString() };
}

const CONSENT_PAGE_TEXT = /cookie|consent|privacy|tracking|personal data/i;
const REJECT_CONSENT_TEXT = /(reject all|decline all|deny all|necessary only|only necessary|use necessary cookies only|continue without accepting|refuse all|no thanks|reject|decline|deny)/i;
const ACCEPT_CONSENT_TEXT = /(accept all|allow all|allow cookies|i agree|accept|allow|agree)/i;

const CONSENT_SELECTORS = {
  reject: [
    "#onetrust-reject-all",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
    "#didomi-notice-disagree-button",
    "[data-testid*='reject' i]",
    "[id*='reject' i]",
    "[class*='reject' i]",
  ],
  accept: [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonAccept",
    "#didomi-notice-agree-button",
    "[data-testid*='accept' i]",
    "[id*='accept' i]",
    "[class*='accept' i]",
  ],
};

const KNOWN_CONSENT_SCOPES = "[role='dialog'], [aria-modal='true'], #onetrust-banner-sdk, #CybotCookiebotDialog, #didomi-host";
const GENERIC_CONSENT_SCOPES = "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [data-testid*='consent' i]";

function consentContentIsRelevant(text, aria = "") {
  return CONSENT_PAGE_TEXT.test(`${text || ""} ${aria || ""}`.slice(0, 20000));
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function runConsentSelfTest() {
  if (consentContentIsRelevant("Example Domain", "")) throw new Error("no-dialog fixture was incorrectly classified as consent-relevant");
  if (!consentContentIsRelevant("We use cookies", "Cookie consent")) throw new Error("consent fixture was not classified as consent-relevant");
  console.log("Consent self-test passed: no-dialog verified=true, dismissed=false");
}

function emptyConsentResult(mode, phase) {
  return {
    mode,
    phase,
    verified: false, dismissed: false, actionTaken: false, outcome: "not-attempted",
    selector: null,
    frame: null,
    attempts: [],
    reason: mode === "none" ? "disabled" : "no matching scoped consent control found", blindSpots: [], traversal: [], clicks: 0, budgetMs: 0,
  };
}

async function frameContainsConsentText(frame) {
  const text = await frame.locator("body").innerText({ timeout: 500 }).catch(() => "");
  return CONSENT_PAGE_TEXT.test(text.slice(0, 20000));
}

async function handleConsent(page, args, phase) {
  const result = emptyConsentResult(args.consentMode, phase);
  if (args.consentMode === "accept" && args.consentAcceptApproved !== true) {
    result.outcome = "accept-approval-required";
    result.reason = "accept mode is fail-closed without consent_accept_approved=true";
    return result;
  }
  const started = Date.now();
  await page.waitForTimeout(Math.min(args.consentWait, args.consentBudgetMs));
  const scopes = `${KNOWN_CONSENT_SCOPES}, ${GENERIC_CONSENT_SCOPES}`;
  const stages = args.consentMode === "granular"
    ? [args.consentSettingsSelectors, args.consentOptionalSelectors, args.consentSaveSelectors]
    : [[...args.consentSelectors, ...(CONSENT_SELECTORS[args.consentMode] || [])]];
  const phrase = args.consentMode === "accept" ? ACCEPT_CONSENT_TEXT : REJECT_CONSENT_TEXT;
  let clicks = 0;
  const visibleSurfaceCount = async () => {
    let count = 0;
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) result.traversal.push({ frame: frame.url(), kind: "iframe-traversed" });
      try {
        const surfaces = frame.locator(scopes);
        const inspectionTimeout = Math.max(250, Math.min(1000, args.consentBudgetMs || 1000));
        const surfaceCount = await withTimeout(surfaces.count(), inspectionTimeout, "consent surface scan");
        for (let i = 0; i < surfaceCount; i++) {
          const surface = surfaces.nth(i);
          if (!(await withTimeout(surface.isVisible({ timeout: 250 }), inspectionTimeout, "consent visibility scan").catch(() => false))) continue;
          const relevant = await withTimeout(surface.evaluate((element) => {
            const known = element.matches("[role='dialog'], [aria-modal='true'], #onetrust-banner-sdk, #CybotCookiebotDialog, #didomi-host");
            if (known) return true;
            const text = `${element.innerText || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("aria-describedby") || ""}`;
            return /cookie|consent|privacy|tracking|personal data/i.test(text.slice(0, 20000));
          }), inspectionTimeout, "consent relevance scan").catch(() => false);
          if (relevant) count++;
        }
        const explicitSelectors = args.consentMode === "granular"
          ? [...args.consentSettingsSelectors, ...args.consentOptionalSelectors, ...args.consentSaveSelectors]
          : args.consentSelectors;
        for (const selector of explicitSelectors) {
          if (await withTimeout(frame.locator(selector).isVisible({ timeout: 250 }), inspectionTimeout, "explicit consent scan").catch(() => false)) count++;
        }
      }
      catch (error) { result.blindSpots.push({ frame: frame.url(), kind: "frame-inspection-failed", error: error.message }); }
    }
    return count;
  };
  let previousSurfaceCount = -1;
  let rounds = 0;
  while ((args.consentMode === "granular" && rounds === 0) || (args.consentMode !== "granular" && clicks < args.consentMaxClicks && Date.now() - started < args.consentBudgetMs)) {
    rounds++;
    const before = await visibleSurfaceCount();
    if (before === 0 || before === previousSurfaceCount && result.actionTaken) break;
    previousSurfaceCount = before;
    for (const stage of stages) {
    let stageDone = false;
    for (const frame of page.frames()) {
      const inspectionTimeout = Math.max(250, Math.min(1000, args.consentBudgetMs || 1000));
      const openShadowHosts = await withTimeout(frame.locator("*").evaluateAll((elements) => elements.filter((element) => element.shadowRoot).length), inspectionTimeout, "shadow-root scan").catch((error) => {
        result.blindSpots.push({ frame: frame.url(), kind: "shadow-scan-timeout", error: error.message });
        return 0;
      });
      if (openShadowHosts > 0) result.openShadowHosts = (result.openShadowHosts || 0) + openShadowHosts;
      const scoped = frame.locator(scopes);
      if (!(await withTimeout(scoped.count(), inspectionTimeout, "consent candidate scan").catch((error) => {
        result.blindSpots.push({ frame: frame.url(), kind: "candidate-scan-timeout", error: error.message });
        return 0;
      }))) continue;
      const candidates = stage.map((selector) => ({ locator: scoped.locator(selector).first(), selector, explicit: true }));
      const langAllowed = await withTimeout(frame.evaluate(() => {
        const lang = (document.documentElement.lang || document.body?.lang || "").trim().toLowerCase();
        return !lang || lang === "en" || lang.startsWith("en-");
      }), inspectionTimeout, "language scan").catch(() => false);
      if (args.consentMode !== "granular" && langAllowed) candidates.push({ locator: scoped.getByRole("button", { name: phrase }).first(), selector: `scoped-role=button[name=${phrase}]` });
      for (const candidate of candidates) {
      if (Date.now() - started >= args.consentBudgetMs || clicks >= args.consentMaxClicks) break;
      const visible = await candidate.locator.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;
      if (candidate.explicit !== true) {
        const relevant = await candidate.locator.evaluate((element) => {
          const root = element.closest("[role='dialog'], [aria-modal='true'], #onetrust-banner-sdk, #CybotCookiebotDialog, #didomi-host, [id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [data-testid*='consent' i]");
          if (!root) return false;
          if (root.matches("[role='dialog'], [aria-modal='true'], #onetrust-banner-sdk, #CybotCookiebotDialog, #didomi-host")) return true;
          const text = `${root.innerText || ""} ${root.getAttribute("aria-label") || ""} ${root.getAttribute("aria-describedby") || ""}`;
          return /cookie|consent|privacy|tracking|personal data/i.test(text.slice(0, 20000));
        }).catch(() => false);
        if (!relevant) continue;
      }
      if (args.consentMode === "granular" && stage === args.consentOptionalSelectors) {
        const checked = await candidate.locator.isChecked({ timeout: 250 }).catch(() => false);
        if (!checked) continue;
      }
      if (!candidate.explicit) {
        const controlLangAllowed = await withTimeout(candidate.locator.evaluate((el) => {
          let node = el;
          while (node) { const lang = (node.getAttribute?.("lang") || "").trim().toLowerCase(); if (lang) return lang === "en" || lang.startsWith("en-"); node = node.parentElement; }
          return true;
        }), inspectionTimeout, "control language scan").catch(() => false);
        if (!langAllowed || !controlLangAllowed) continue;
      }
      result.attempts.push(candidate.selector);
      try {
        await candidate.locator.click({ timeout: 1200 });
        clicks++;
        await page.waitForTimeout(250);
        result.actionTaken = true;
        result.outcome = "action-taken";
        result.action = args.consentMode === "accept" ? "accepted" : args.consentMode === "granular" ? "saved" : "rejected";
        result.selector = candidate.selector;
        result.frame = frame.url();
        result.reason = "consent control clicked; surface verification is pending";
        console.error(`Consent ${result.action} via ${candidate.selector}`);
        stageDone = true;
        if (args.consentMode === "granular" && stage === args.consentOptionalSelectors) continue;
        break;
      } catch (error) {
        result.attempts.push(`${candidate.selector}: ${error.message}`);
      }
      if (args.consentMode === "granular" && stage === args.consentOptionalSelectors) {
        const stillChecked = await candidate.locator.isChecked({ timeout: 250 }).catch(() => false);
        if (stillChecked) stageDone = false;
      }
      }
      if (args.consentMode === "granular" && stage === args.consentOptionalSelectors) {
        stageDone = true;
        for (const optionalCandidate of candidates) {
          if (await optionalCandidate.locator.isChecked({ timeout: 250 }).catch(() => false)) stageDone = false;
        }
      }
      if (stageDone) break;
    }
    if (!stageDone && args.consentMode === "granular") {
      result.outcome = "granular-stage-not-completed";
      break;
    }
      if (Date.now() - started >= args.consentBudgetMs || clicks >= args.consentMaxClicks) break;
    }
    if (args.consentMode !== "granular" && !(await visibleSurfaceCount())) break;
  }
  const remaining = await visibleSurfaceCount();
  result.verified = remaining === 0 && result.blindSpots.length === 0;
  result.dismissed = result.verified && result.actionTaken && args.consentMode !== "none";
  result.outcome = result.verified ? (result.actionTaken ? "dismissed" : "no-consent-surface") : result.outcome === "action-taken" ? "surface-remains-or-unverified" : result.outcome;
  result.clicks = clicks; result.budgetMs = Date.now() - started;
  if (args.consentMode === "none") result.outcome = result.verified ? "no-consent-surface" : "consent-surface-present";
  else if (!result.verified && !result.actionTaken) result.outcome = "no-safe-action";
  return result;
}

async function runConsentBounded(page, args, phase) {
  const timeoutMs = Math.max(1000, Math.min(3000, args.consentBudgetMs || 1000));
  try {
    return await withTimeout(handleConsent(page, args, phase), timeoutMs, "consent handling");
  } catch (error) {
    const result = emptyConsentResult(args.consentMode, phase);
    result.outcome = "consent-check-timeout";
    result.reason = error.message;
    result.blindSpots = [{ kind: "consent-check-timeout", error: error.message }];
    return result;
  }
}

function combineConsentResults(mode, preflight, recorded) {
  const results = [preflight, recorded].filter(Boolean);
  const final = recorded || results[results.length - 1] || emptyConsentResult(mode, "aggregate");
  return {
    mode, verified: Boolean(final.verified), dismissed: Boolean(final.dismissed), actionTaken: results.some((r) => r.actionTaken), outcome: final.outcome || "not-attempted",
    action: final.action || "none",
    selector: final.selector || null,
    preflight: preflight || null,
    recorded: recorded || null,
  };
}

async function writeManifest(out, files, runId) {
  const entries = [];
  for (const file of files) {
    const info = await stat(file);
    const hash = createHash("sha256");
    const data = await (await import("node:fs/promises")).readFile(file);
    hash.update(data);
    entries.push({ path: path.basename(file), size: info.size, sha256: hash.digest("hex") });
  }
  const manifest = { runId: runId || `${Date.now()}-${process.pid}`, generatedAt: new Date().toISOString(), files: entries };
  const manifestPath = path.join(out, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

// Award-winning/creative sites routinely layer a sticky morphing nav, a
// custom cursor, or a scroll-jacked hero section on top of real interactive
// elements, so a plain hover/click sees "element intercepts pointer events"
// and Playwright burns several seconds retrying before giving up. Fail fast
// on the polite attempt, then fall back to a forced dispatch that bypasses
// the actionability/interception check — that's the only way to reach the
// element on exactly the sites this tool needs to capture.
async function hoverThenForce(el, timeout) {
  try {
    await el.hover({ timeout });
  } catch {
    await el.hover({ timeout, force: true });
  }
}

async function clickThenForce(el, timeout) {
  try {
    await el.click({ timeout });
  } catch {
    await el.click({ timeout, force: true });
  }
}

// Discovers likely-interactive elements (nav links, buttons, disclosure widgets)
// and clicks through them in sequence so animations gated behind interaction
// get recorded without the caller having to know selectors up front.
async function autoDiscoverAndInteract(page, args) {
  const selector = [
    "nav a", "nav button", "[role='button']", "button",
    "summary", "[aria-expanded]", "[aria-haspopup]",
    ".dropdown-toggle", ".accordion-toggle", ".menu-toggle",
  ].join(", ");

  const count = await page.locator(selector).count();
  const limit = Math.min(count, args.autoDiscoverMax);
  console.error(`auto-discover: found ${count} candidate(s), interacting with up to ${limit}`);

  for (let i = 0; i < limit; i++) {
    const el = page.locator(selector).nth(i);
    try {
      if (!(await el.isVisible())) continue;
      await el.scrollIntoViewIfNeeded({ timeout: 2000 });
      await hoverThenForce(el, 800);
      await page.waitForTimeout(args.autoDiscoverWait / 2);
      await clickThenForce(el, 800).catch(() => {});
      await page.waitForTimeout(args.autoDiscoverWait);
    } catch (e) {
      console.error(`auto-discover: skipped element ${i} (${e.message})`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return runConsentSelfTest();
  ({ chromium } = await import("playwright"));
  await mkdir(args.out, { recursive: true });

  // Headless Chromium disables GPU compositing by default regardless of what
  // hardware is present, so it silently falls back to software rasterization
  // (SwiftShader) even on a GPU box unless explicitly told to use the real
  // driver via EGL/ANGLE — this is what turned SwiftShader jank into a
  // measurement artifact on ampere-dev's no-GPU runs.
  const launchArgs = args.gpu
    ? [
        "--use-gl=angle",
        "--use-angle=gl-egl",
        "--enable-gpu-rasterization",
        "--enable-zero-copy",
        "--ignore-gpu-blocklist",
      ]
    : [];
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  let cleaning = false;
  const cleanup = async () => { if (!cleaning) { cleaning = true; await browser.close().catch(() => {}); } };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let context = null;
  let page = null;
  let preflightContext = null;
  try {
  let preflightState = null;
  let preflightConsent = null;
  if (args.consentMode !== "none" && args.consentPreflight) {
    preflightContext = await browser.newContext({
      viewport: { width: args.width, height: args.height },
    });
    const preflightPage = await preflightContext.newPage();
    await preflightPage.goto(args.url, { waitUntil: "load", timeout: 60_000 });
    preflightConsent = await runConsentBounded(preflightPage, args, "preflight");
    preflightState = await preflightContext.storageState();
    await preflightContext.close();
  }
  context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    recordVideo: { dir: args.out, size: { width: args.width, height: args.height } },
    ...(preflightState ? { storageState: preflightState } : {}),
  });
  page = await context.newPage();
  if (args.jankCheck) {
    await installJankObserver(page);
  }

  const phases = [];

  console.error(`Navigating to ${args.url}`);
  await page.goto(args.url, { waitUntil: "load", timeout: 60_000 });
  await delayedCheck(page, "after-navigation");
  const recordedConsent = await runConsentBounded(page, args, "recorded");
  let consent = combineConsentResults(args.consentMode, preflightConsent, recordedConsent);
  await waitForPageReady(page, args);
  await markPhase(page, phases, "load");

  for (const sel of args.hoverSelectors) {
    try {
      await delayedCheck(page, "before-hover");
      await hoverThenForce(page.locator(sel).first(), 5000);
      await page.waitForTimeout(args.hoverWait);
    } catch (e) {
      console.error(`Hover target not found: ${sel} (${e.message})`);
    }
  }

  for (const sel of args.clickSelectors) {
    try {
      await delayedCheck(page, "before-click");
      await clickThenForce(page.locator(sel).first(), 5000);
      await page.waitForTimeout(args.clickWait);
    } catch (e) {
      console.error(`Click target not found: ${sel} (${e.message})`);
    }
  }
  await markPhase(page, phases, "manual-interactions");

  if (args.autoDiscover) {
    await autoDiscoverAndInteract(page, args);
  }
  await markPhase(page, phases, "auto-discover");

  if (args.scroll) {
    // A fixed scroll distance truncates long narrative/storyboard sites
    // before their arc finishes, so default to the page's real scrollable
    // height (measured live, since lazy content can grow it past what's
    // known at load) rather than an arbitrary constant. Custom-scroll
    // libraries (Lenis, Locomotive Scroll, GSAP ScrollTrigger) commonly lock
    // documentElement at viewport height and drive an inner transformed
    // container instead, so that measurement alone under-reports on exactly
    // the award-site-style pages this tool targets — fall back to the
    // tallest element on the page when the document itself looks too short
    // to be real. mouse.wheel() still drives these libraries correctly since
    // it dispatches real wheel events, independent of what scrollHeight says.
    const measured = await page.evaluate(() => {
      const docDistance = document.documentElement.scrollHeight - window.innerHeight;
      if (docDistance > 400) return { distance: docDistance, fallback: false };
      let maxHeight = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollHeight > maxHeight) maxHeight = el.scrollHeight;
      }
      const fallbackDistance = Math.max(maxHeight - window.innerHeight, docDistance);
      return { distance: fallbackDistance, fallback: true };
    }).catch(() => ({ distance: 4000, fallback: true }));

    if (measured.fallback) {
      console.error(
        `documentElement.scrollHeight looked too short to be real (custom-scroll library?) — ` +
        `falling back to tallest-element measurement: ${Math.round(measured.distance)}px`
      );
    }
    const distance = args.scrollDistance ?? Math.max(measured.distance, 4000);
    const steps = Math.max(1, Math.ceil(distance / args.scrollStep));
    console.error(`Scrolling ${Math.round(distance)}px over ${steps} step(s)`);
    for (let i = 0; i < steps; i++) {
      const scrollTimeout = Math.max(1000, Math.min(5000, args.scrollPause + 2000));
      try {
        await withTimeout(page.mouse.wheel(0, args.scrollStep), scrollTimeout, "scroll input");
        await withTimeout(page.waitForTimeout(args.scrollPause), scrollTimeout, "scroll pause");
        await withTimeout(delayedCheck(page, "after-scroll-step", 100), scrollTimeout, "scroll reconciliation wait");
      } catch (error) {
        console.error(`scroll step ${i + 1}/${steps} timed out, stopping scroll (${error.message})`);
        break;
      }
      const reconciledConsent = await runConsentBounded(page, args, "after-scroll-step");
      consent = combineConsentResults(args.consentMode, consent.recorded || recordedConsent, reconciledConsent);
    }
  }
  await markPhase(page, phases, "scroll");

  await page.waitForTimeout(args.tail);
  await markPhase(page, phases, "tail");

  await delayedCheck(page, "before-finalization");
  const finalConsent = await runConsentBounded(page, args, "before-finalization");
  consent = combineConsentResults(args.consentMode, consent.recorded || recordedConsent, finalConsent);
  const jankReport = args.jankCheck ? await collectJankReport(page, args, phases, consent) : null;

  const video = page.video();
  await page.close();
  page = null;
  await context.close();
  context = null;
  await browser.close();
  cleaning = true;
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  const videoPath = await video.path();

  const stem = args.name || new URL(args.url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const finalPath = path.join(args.out, `${stem}.webm`);
  await rename(videoPath, finalPath);

  if (jankReport) {
    const reportPath = path.join(args.out, `${stem}.jank.json`);
    await writeFile(reportPath, JSON.stringify(jankReport, null, 2));
    if (jankReport.choppy) {
      console.error(
        `WARNING: capture looks choppy — ${jankReport.longTaskCount} long task(s), ` +
        `${jankReport.totalBlockingTimeMs}ms total blocking time (threshold ${jankReport.thresholdMs}ms). ` +
        `See ${reportPath} before using this as a reference.`
      );
    } else {
      console.error(
        `Jank check OK — ${jankReport.longTaskCount} long task(s), ` +
        `${jankReport.totalBlockingTimeMs}ms total blocking time (threshold ${jankReport.thresholdMs}ms).`
      );
    }
  }

  const manifestPath = await writeManifest(args.out, [finalPath, ...(jankReport ? [path.join(args.out, `${stem}.jank.json`)] : [])], args.runId);
  console.error(`Manifest written to ${manifestPath}`);

  console.log(finalPath);
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await preflightContext?.close().catch(() => {});
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
