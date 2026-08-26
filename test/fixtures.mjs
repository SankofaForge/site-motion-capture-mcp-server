import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(prefix = "site-motion-test-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export function fakeConsentPage({ frames = [], waits = [] } = {}) {
  const sleep = async (ms) => { waits.push(ms); };
  return { frames: () => frames, mainFrame: () => frames[0], waitForTimeout: sleep };
}

export function fakeFrame({ url = "https://fixture.test/", body = "", controls = {}, openShadowHosts = 0, lang = "" } = {}) {
  const locators = new Map();
  let dismissed = false;
  const lookup = (key) => {
    const control = controls[key];
    if (!control) return fakeLocator({ visible: false });
    if (!locators.has(key)) locators.set(key, fakeLocator({ ...control, onClick: () => { if (!control.remainsVisible) dismissed = true; } }));
    return locators.get(key);
  };
  const scoped = fakeLocator({ visible: true, text: body, countFn: () => {
    const surface = /cookie|consent|privacy|tracking|personal data/i.test(body) || Object.keys(controls).length;
    return surface && !dismissed ? 1 : 0;
  }});
  scoped.locator = (selector) => lookup(selector);
  scoped.getByRole = (kind, options) => lookup(`role=${kind}:${options.name}`);
  scoped.nth = () => scoped;
  return {
    url: () => url,
    locator(selector) {
      if (selector === "body") return fakeLocator({ text: body });
      if (selector === "*") return fakeLocator({ count: 0, evaluated: openShadowHosts });
      if (selector.includes("[role='dialog']")) return scoped;
      return lookup(selector);
    },
    async evaluate() { return lang; },
    getByRole(kind, options) { return lookup(`role=${kind}:${options.name}`); },
    getByText(text) { return lookup(`text=${text}`); },
  };
}

function fakeLocator({ visible = true, text = "", count = 1, countFn = null, evaluated = 0, clickError = null, clicked = null, onClick = null, remainsVisible = false } = {}) {
  let currentVisible = visible;
  return {
    first() { return this; },
    filter() { return this; },
    async innerText() { return text; },
    async evaluate() { return /cookie|consent|privacy|tracking|personal data/i.test(text); },
    async count() { return countFn ? countFn() : count; },
    async evaluateAll() { return Array.from({ length: evaluated }, () => ({})); },
    async isVisible() { return currentVisible; },
    visible() { return currentVisible; },
    async click(options = {}) {
      if (clickError) throw new Error(clickError);
      if (clicked) clicked();
      if (onClick) onClick();
      if (!remainsVisible) currentVisible = false;
    },
  };
}

export async function writeExecutable(dir, name, source) {
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}`);
  await import("node:fs/promises").then(({ chmod }) => chmod(file, 0o755));
  return file;
}

export async function shimBin() {
  const dir = await tempDir("site-motion-bin-");
  await mkdir(dir, { recursive: true });
  return dir;
}
