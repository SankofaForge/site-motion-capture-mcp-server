import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tempDir } from "./fixtures.mjs";

async function loadRecorder() {
  let source = await readFile(new URL("../remote/capture.mjs", import.meta.url), "utf8");
  source = source.replace('import { chromium } from "playwright";', "const chromium = {};" );
  source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, "");
  source += "\nexport { writeManifest };\n";
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("manifest uses safe basename paths and bridge validates the same field", async () => {
  const { writeManifest } = await loadRecorder();
  const dir = await tempDir("manifest-regression-");
  const file = `${dir}/capture.webm`;
  await (await import("node:fs/promises")).writeFile(file, "fixture");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(await writeManifest(dir, [file], "run"), "utf8"));
  assert.deepEqual(manifest.files.map((entry) => entry.path), ["capture.webm"]);
  assert.ok(manifest.files.every((entry) => !entry.path.includes("/")));

  const bridge = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(bridge, /join\(stageDir, file\.path\)/);
});
