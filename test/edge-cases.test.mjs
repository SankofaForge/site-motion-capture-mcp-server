import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  run,
  resolveConnection,
  parseSshUrl,
  sshArgs,
  runRemote,
  runRemoteCommand,
  copyRemote,
  validateString,
  integerOption,
  booleanOption,
  validateCaptureInput,
  captureSiteMotion,
  ensureRemoteEncoder,
  checkCaptureGpu,
  callTool,
  handleMessage,
  writeMessage,
  errorResult,
  shellQuote,
  isSafeRemoteRunDir,
  trimOutput,
  tools,
  SERVER_NAME,
  SERVER_VERSION,
  DEFAULT_LOCAL_OUTPUT,
} from "../index.mjs";
import { tempDir, shimBin, writeExecutable } from "./fixtures.mjs";

test("run() handles timeouts, stderr data, error events, signals, and exit codes", async () => {
  // Timeout
  const timeoutResult = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 50,
  });
  assert.equal(timeoutResult.code, 124);
  assert.match(timeoutResult.error.message, /timed out after 50 ms/);

  // Stderr data and non-zero exit with stderr
  const stderrResult = await run(process.execPath, [
    "-e",
    "process.stderr.write('sample-error-output'); process.exit(2);",
  ]);
  assert.equal(stderrResult.code, 2);
  assert.equal(stderrResult.stderr, "sample-error-output");
  assert.match(stderrResult.error.message, /sample-error-output/);

  // Non-zero exit without stderr
  const noStderrResult = await run(process.execPath, ["-e", "process.exit(3);"]);
  assert.equal(noStderrResult.code, 3);
  assert.match(noStderrResult.error.message, /exited with code 3/);

  // Process error event (e.g. non-existent binary)
  const spawnErrorResult = await run("non_existent_binary_xyz_12345", []);
  assert.equal(spawnErrorResult.code, 1);
  assert.ok(spawnErrorResult.error);

  // Run with default options (omitted 3rd param) and custom env
  const defaultOptsResult = await run(process.execPath, ["-e", "process.stdout.write('ok');"]);
  assert.equal(defaultOptsResult.code, 0);
  assert.equal(defaultOptsResult.stdout, "ok");

  const customEnvResult = await run(
    process.execPath,
    ["-e", "process.stdout.write(process.env.CUSTOM_FLAG || '');"],
    { env: { CUSTOM_FLAG: "hello_env" } }
  );
  assert.equal(customEnvResult.code, 0);
  assert.equal(customEnvResult.stdout, "hello_env");

  // Killed by signal
  const signalResult = await run(process.execPath, [
    "-e",
    "process.kill(process.pid, 'SIGTERM');",
  ]);
  assert.equal(signalResult.code, 1);
  assert.match(signalResult.error.message, /stopped with signal SIGTERM/);
});

test("trimOutput() trims and truncates strings exceeding 4000 chars", () => {
  assert.equal(trimOutput("  hello world  "), "hello world");
  const longText = "a".repeat(4500);
  const trimmed = trimOutput(longText);
  assert.equal(trimmed.length, 4001); // 4000 slice + '…'
  assert.ok(trimmed.endsWith("…"));
});

test("shellQuote() escapes single quotes properly", () => {
  assert.equal(shellQuote("hello"), "'hello'");
  assert.equal(shellQuote("it's a 'test'"), "'it'\\''s a '\\''test'\\'''");
});

test("isSafeRemoteRunDir() validates safe UUID paths under remote output root", () => {
  assert.equal(
    isSafeRemoteRunDir("/workspace/site-motion-capture/out/runs/a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab"),
    true
  );
  assert.equal(isSafeRemoteRunDir("/workspace/site-motion-capture/out/runs/invalid-uuid"), false);
  assert.equal(isSafeRemoteRunDir("/tmp/runs/a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab"), false);
  assert.equal(isSafeRemoteRunDir("../runs/a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab"), false);
});

test("parseSshUrl() parses URLs and handles default username and invalid formats", () => {
  // Valid with explicit user
  const conn1 = parseSshUrl("ssh://alice@remote.host:2222");
  assert.deepEqual(conn1, { user: "alice", host: "remote.host", port: "2222" });

  // Valid without user -> defaults to root
  const conn2 = parseSshUrl("ssh://remote.host:2222");
  assert.deepEqual(conn2, { user: "root", host: "remote.host", port: "2222" });

  // Invalid URL string
  assert.throws(() => parseSshUrl("not-a-url"), /SITE_MOTION_SSH_URL is not a valid ssh:\/\/ URL/);

  // Non ssh protocol
  assert.throws(() => parseSshUrl("http://remote.host:2222"), /The Vast SSH endpoint must use ssh:\/\/user@host:port/);

  // Missing hostname
  assert.throws(() => parseSshUrl("ssh:///path"), /The Vast SSH endpoint must use ssh:\/\/user@host:port/);

  // Missing port
  assert.throws(() => parseSshUrl("ssh://remote.host"), /The Vast SSH endpoint must use ssh:\/\/user@host:port/);
});

test("resolveConnection() handles explicit host/port with and without user, and vastai success", async () => {
  const prevHost = process.env.SITE_MOTION_SSH_HOST;
  const prevPort = process.env.SITE_MOTION_SSH_PORT;
  const prevUser = process.env.SITE_MOTION_SSH_USER;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  delete process.env.SITE_MOTION_SSH_URL;

  try {
    // Both host and port set, user unset -> default root
    process.env.SITE_MOTION_SSH_HOST = "explicit.host";
    process.env.SITE_MOTION_SSH_PORT = "2200";
    delete process.env.SITE_MOTION_SSH_USER;
    const connDefaultUser = await resolveConnection();
    assert.deepEqual(connDefaultUser, { user: "root", host: "explicit.host", port: "2200" });

    // Host, port, user all set
    process.env.SITE_MOTION_SSH_USER = "custom_user";
    const connCustomUser = await resolveConnection();
    assert.deepEqual(connCustomUser, { user: "custom_user", host: "explicit.host", port: "2200" });

    // Only host set (missing port) -> should fall through to vastai
    delete process.env.SITE_MOTION_SSH_PORT;
    const bin = await shimBin();
    await writeExecutable(bin, "vastai", `process.stdout.write("ssh://vastuser@vast.host.test:33333\\n");`);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
    try {
      const connFallthrough = await resolveConnection();
      assert.deepEqual(connFallthrough, { user: "vastuser", host: "vast.host.test", port: "33333" });
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    if (prevHost !== undefined) process.env.SITE_MOTION_SSH_HOST = prevHost; else delete process.env.SITE_MOTION_SSH_HOST;
    if (prevPort !== undefined) process.env.SITE_MOTION_SSH_PORT = prevPort; else delete process.env.SITE_MOTION_SSH_PORT;
    if (prevUser !== undefined) process.env.SITE_MOTION_SSH_USER = prevUser; else delete process.env.SITE_MOTION_SSH_USER;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl; else delete process.env.SITE_MOTION_SSH_URL;
  }
});

test("sshArgs() and copyRemote() honor SITE_MOTION_SSH_KEY or fallback to default id_ed25519", async () => {
  const connection = { user: "root", host: "example.test", port: "22" };
  const prevKey = process.env.SITE_MOTION_SSH_KEY;

  delete process.env.SITE_MOTION_SSH_KEY;
  const argsDefault = sshArgs(connection, "echo 1");
  assert.equal(argsDefault[2], join(homedir(), ".ssh", "id_ed25519"));

  process.env.SITE_MOTION_SSH_KEY = "/custom/key/path";
  const argsCustom = sshArgs(connection, "echo 1");
  assert.equal(argsCustom[2], "/custom/key/path");

  // copyRemote failure throws (tested with both custom key and default key)
  const bin = await shimBin();
  await writeExecutable(bin, "scp", "process.exit(1);");
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    // Custom key
    process.env.SITE_MOTION_SSH_KEY = "/custom/key/path";
    await assert.rejects(
      async () => copyRemote(connection, "/remote/path", "/local/path", 10000),
      /exited with code 1/
    );

    // Default key
    delete process.env.SITE_MOTION_SSH_KEY;
    await assert.rejects(
      async () => copyRemote(connection, "/remote/path", "/local/path", 10000),
      /exited with code 1/
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevKey !== undefined) process.env.SITE_MOTION_SSH_KEY = prevKey; else delete process.env.SITE_MOTION_SSH_KEY;
  }
});

test("runRemote() and runRemoteCommand() error and cleanup paths", async () => {
  const connection = { user: "root", host: "example.test", port: "22" };
  const bin = await shimBin();
  const prevPath = process.env.PATH;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  process.env.SITE_MOTION_SSH_URL = "ssh://root@example.test:22";

  // runRemote throws on error
  await writeExecutable(bin, "ssh", "process.exit(1);");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    await assert.rejects(
      async () => runRemote(connection, "ls", ["-la"], 1000),
      /exited with code 1/
    );

    // runRemoteCommand with unsafe runDir -> cleanup "not-attempted"
    await assert.rejects(
      async () => runRemoteCommand(connection, "echo 1", 1000, "/unsafe/dir"),
      /remote cleanup not-attempted/
    );

    // runRemoteCommand with safe runDir and failed termination -> cleanup "pending"
    const safeRunDir = "/workspace/site-motion-capture/out/runs/a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
    await writeExecutable(
      bin,
      "ssh",
      `
const arg = process.argv.join(" ");
if (arg.includes("kill -TERM")) {
  process.exit(1);
} else {
  process.exit(2);
}
`
    );
    await assert.rejects(
      async () => runRemoteCommand(connection, "echo 1", 1000, safeRunDir),
      /remote cleanup pending/
    );

    // runRemoteCommand with safe runDir and successful termination -> cleanup "confirmed"
    await writeExecutable(
      bin,
      "ssh",
      `
const arg = process.argv.join(" ");
if (arg.includes("kill -TERM")) {
  process.exit(0);
} else {
  process.exit(2);
}
`
    );
    await assert.rejects(
      async () => runRemoteCommand(connection, "echo 1", 1000, safeRunDir),
      /remote cleanup confirmed/
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl; else delete process.env.SITE_MOTION_SSH_URL;
  }
});

test("validateString, integerOption, and booleanOption validation edge cases", () => {
  // validateString
  assert.equal(validateString(undefined, "field"), undefined);
  assert.equal(validateString("valid", "field"), "valid");
  assert.throws(() => validateString(123, "field"), /field must be a non-empty string/);
  assert.throws(() => validateString("", "field"), /field must be a non-empty string/);
  assert.throws(() => validateString("toolong", "field", { maxLength: 3 }), /field must be a non-empty string/);

  // integerOption
  assert.equal(integerOption({}, "opt", 10, 0, 100), 10);
  assert.equal(integerOption({ opt: 20 }, "opt", 10, 0, 100), 20);
  assert.throws(() => integerOption({ opt: "not-int" }, "opt", 10, 0, 100), /opt must be an integer/);
  assert.throws(() => integerOption({ opt: 3.14 }, "opt", 10, 0, 100), /opt must be an integer/);
  assert.throws(() => integerOption({ opt: -1 }, "opt", 10, 0, 100), /opt must be an integer from 0 to 100/);
  assert.throws(() => integerOption({ opt: 101 }, "opt", 10, 0, 100), /opt must be an integer from 0 to 100/);

  // booleanOption
  assert.equal(booleanOption({}, "flag", true), true);
  assert.equal(booleanOption({ flag: false }, "flag", true), false);
  assert.throws(() => booleanOption({ flag: "true" }, "flag", true), /flag must be true or false/);
  assert.throws(() => booleanOption({ flag: 1 }, "flag", true), /flag must be true or false/);
});

test("validateCaptureInput() default name and all parameter validations", () => {
  assert.throws(() => validateCaptureInput(null), /must be an object/);
  assert.throws(() => validateCaptureInput([1, 2, 3]), /must be an object/);

  const defaultParsed = validateCaptureInput({ url: "https://example.test" });
  assert.match(defaultParsed.name, /^capture-\d+$/);
  assert.equal(defaultParsed.consentMode, "reject");
  assert.equal(defaultParsed.consentPreflight, true);
  assert.equal(defaultParsed.gpu, true);
  assert.equal(defaultParsed.mobile, false);
  assert.equal(defaultParsed.noScroll, false);
  assert.equal(defaultParsed.overwrite, false);
  assert.equal(defaultParsed.width, 1920);
  assert.equal(defaultParsed.height, 1080);
  assert.equal(defaultParsed.outputDir, DEFAULT_LOCAL_OUTPUT);

  // non-string name
  assert.throws(
    () => validateCaptureInput({ url: "https://example.test", name: 123 }),
    /name must contain 1 to 81 letters/
  );
});

test("captureSiteMotion() file exist / lock error / manifest edge cases", async () => {
  const bin = await shimBin();
  const out = await tempDir("edge-capture-");
  const prevPath = process.env.PATH;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SITE_MOTION_SSH_URL = "ssh://root@example.test:22";

  try {
    // 1. Existing local file with overwrite=false
    await writeFile(join(out, "target-exists.webm"), "data");
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "target-exists",
          output_dir: out,
          overwrite: false,
        }),
      /capture target exists/
    );

    // Existing jank file with overwrite=false
    await writeFile(join(out, "jank-exists.jank.json"), "{}");
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "jank-exists",
          output_dir: out,
          overwrite: false,
        }),
      /capture target exists/
    );

    // 2. Manifest files validation: invalid count, invalid file path, duplicate file path
    await writeExecutable(bin, "ssh", `process.stdout.write("ok\\n");`);

    // Manifest has wrong runId
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({ runId: "wrong-run-id", files: [] }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-manifest-runid",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has non-array files or wrong files count
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({ runId, files: "not-array" }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-files-array",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has invalid file object (e.g. null or missing path)
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({ runId, files: [null, { path: 123 }] }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-file-entry",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has duplicate file paths
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "bad-dup.webm", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
      { path: "bad-dup.webm", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
    ]
  }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-dup",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has non-basename or invalid chars
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "../bad-path.webm", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
      { path: "bad-path.jank.json", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
    ]
  }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-path",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has unexpected file name
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "unexpected.webm", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
      { path: "bad-unexp.jank.json", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
    ]
  }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-unexp",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed/
    );

    // Manifest has file size mismatch
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "bad-size.webm", size: 999999, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
      { path: "bad-size.jank.json", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
    ]
  }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-size",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed for bad-size\.webm/
    );

    // Manifest sha256 mismatch
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "bad-hash.webm", size: 4, sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      { path: "bad-hash.jank.json", size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" },
    ]
  }));
} else {
  fs.writeFileSync(dest, "data");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "bad-hash",
          output_dir: out,
          overwrite: true,
        }),
      /manifest validation failed for bad-hash\.webm/
    );

    // Successful capture with absent consent in jank report -> defaults to consent: null
    const videoData = Buffer.from("video-bytes");
    const jankStr = JSON.stringify({ noConsentField: true });
    const jankData = Buffer.from(jankStr);
    await writeExecutable(
      bin,
      "scp",
      `
const fs = require("node:fs");
const crypto = require("node:crypto");
const dest = process.argv.at(-1);
const stageDir = require("node:path").dirname(dest);
const runId = stageDir.replace(/^.*\\.capture-/, "");
if (dest.endsWith("manifest.json")) {
  fs.writeFileSync(dest, JSON.stringify({
    runId,
    files: [
      { path: "no-consent.webm", size: ${videoData.length}, sha256: crypto.createHash("sha256").update(Buffer.from("video-bytes")).digest("hex") },
      { path: "no-consent.jank.json", size: ${jankData.length}, sha256: crypto.createHash("sha256").update(Buffer.from(${JSON.stringify(jankStr)})).digest("hex") },
    ]
  }));
} else if (dest.endsWith(".webm")) {
  fs.writeFileSync(dest, Buffer.from("video-bytes"));
} else if (dest.endsWith(".jank.json")) {
  fs.writeFileSync(dest, Buffer.from(${JSON.stringify(jankStr)}));
}
`
    );
    const resultNoConsent = await captureSiteMotion({
      url: "https://example.test",
      name: "no-consent",
      output_dir: out,
      overwrite: true,
      gpu: false,
      mobile: false,
      no_scroll: false,
      consent_preflight: false,
    });
    const parsedReport = JSON.parse(resultNoConsent.content[0].text);
    assert.equal(parsedReport.consent, null);
    assert.equal(parsedReport.cleanup, "confirmed");

    // Capture failure when remote rm cleanup in catch block fails -> cleanup stays pending
    await writeExecutable(
      bin,
      "ssh",
      `
const arg = process.argv.join(" ");
if (arg.includes("node ") && arg.includes("capture.mjs")) {
  process.exit(1);
} else if (arg.includes("rm -rf")) {
  process.exit(1);
} else {
  process.stdout.write("ok\\n");
}
`
    );
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "fail-cleanup-pending",
          output_dir: out,
          overwrite: true,
        }),
      /remote cleanup confirmed|exited with code 1/
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl; else delete process.env.SITE_MOTION_SSH_URL;
  }

  // Non-EEXIST error on lock mkdir (e.g. invalid permissions or existing file as directory)
  const lockedOut = await tempDir("locked-out-");
  const filePathAsDir = join(lockedOut, "regular-file");
  await writeFile(filePathAsDir, "not a dir");
  await assert.rejects(
    async () =>
      captureSiteMotion({
        url: "https://example.test",
        name: "test-non-eexist",
        output_dir: join(filePathAsDir, "nested"),
      }),
    /ENOTDIR|EEXIST/
    (err) => err.code !== "EEXIST"
  );

  // Non-ENOENT error on stat (e.g. EACCES on stat)
  const unreadableDir = await tempDir("unreadable-");
  const lockInUnreadable = join(unreadableDir, ".perm-test.capture.lock");
  await mkdir(lockInUnreadable); // create lock in advance so mkdir doesn't fail
  await chmod(unreadableDir, 0o000);
  try {
    await assert.rejects(
      async () =>
        captureSiteMotion({
          url: "https://example.test",
          name: "perm-test",
          output_dir: unreadableDir,
          overwrite: false,
        }),
      (err) => err.code !== "ENOENT"
    );
  } finally {
    await chmod(unreadableDir, 0o777);
  }
});

test("ensureRemoteEncoder(), checkCaptureGpu(), callTool() error cases", async () => {
  const bin = await shimBin();
  const prevPath = process.env.PATH;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SITE_MOTION_SSH_URL = "ssh://root@example.test:22";

  await writeExecutable(
    bin,
    "ssh",
    `
const arg = process.argv.join(" ");
if (arg.includes("nvidia-smi")) {
  process.stdout.write("NVIDIA RTX 4090, 24576 MiB, 550.54.14\\n");
} else if (arg.includes("check-gpu-renderer.mjs")) {
  process.stdout.write("WebGL 2.0 Renderer\\n");
} else {
  process.stdout.write("ok\\n");
}
`
  );

  try {
    // ensureRemoteEncoder
    const connection = { user: "root", host: "example.test", port: "22" };
    await ensureRemoteEncoder(connection);

    // checkCaptureGpu
    const gpuResult = await checkCaptureGpu();
    const gpuData = JSON.parse(gpuResult.content[0].text);
    assert.match(gpuData.gpu, /RTX 4090/);

    // callTool
    const callRes = await callTool("check_capture_gpu", {});
    assert.equal(callRes.content[0].type, "text");

    const unknownRes = await callTool("unknown_tool", {});
    assert.equal(unknownRes.isError, true);
    assert.match(unknownRes.content[0].text, /Unknown tool: unknown_tool/);
  } finally {
    process.env.PATH = prevPath;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl; else delete process.env.SITE_MOTION_SSH_URL;
  }
});

test("handleMessage() error formatting for Error instance vs non-Error values", async () => {
  const writes = [];
  const write = (message) => writes.push(`${JSON.stringify(message)}\n`);

  // 1. null / non-object message ignored
  await handleMessage(null, write);
  await handleMessage("string-message", write);
  assert.equal(writes.length, 0);

  // 2. message without id ignored
  await handleMessage({ jsonrpc: "2.0", method: "notification" }, write);
  assert.equal(writes.length, 0);

  // 3. initialize method
  await handleMessage({ jsonrpc: "2.0", id: 980, method: "initialize" }, write);
  assert.equal(writes.length, 1);
  const initReply = JSON.parse(writes[0]);
  assert.equal(initReply.result.serverInfo.name, SERVER_NAME);
  assert.equal(initReply.result.serverInfo.version, SERVER_VERSION);

  // 4. ping method
  await handleMessage({ jsonrpc: "2.0", id: 981, method: "ping" }, write);
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[1]).result, {});

  // 5. tools/list method
  await handleMessage({ jsonrpc: "2.0", id: 982, method: "tools/list" }, write);
  assert.equal(writes.length, 3);
  assert.equal(JSON.parse(writes[2]).result.tools.length, tools.length);

  // 6. tool call with params but missing arguments property
  await handleMessage({
    jsonrpc: "2.0",
    id: 983,
    method: "tools/call",
    params: { name: "unknown" },
  }, write);
  assert.equal(writes.length, 4);
  assert.equal(JSON.parse(writes[3]).result.isError, true);

  // 7. tool call without params
  await handleMessage({
    jsonrpc: "2.0",
    id: 984,
    method: "tools/call",
  }, write);
  assert.equal(writes.length, 5);
  assert.equal(JSON.parse(writes[4]).result.isError, true);

  // 8. unsupported method
  await handleMessage({
    jsonrpc: "2.0",
    id: 985,
    method: "unknown_rpc_method",
  }, write);
  assert.equal(writes.length, 6);
  assert.equal(JSON.parse(writes[5]).error.code, -32601);

  // 9. tool call throwing an Error
    await handleMessage({
      jsonrpc: "2.0",
      id: 991,
      method: "tools/call",
      params: { name: "capture_site_motion", arguments: { url: "invalid" } },
    }, write);
    assert.equal(writes.length, 7);
    const reply1 = JSON.parse(writes[6]);
    assert.equal(reply1.id, 991);
    assert.equal(reply1.result.isError, true);
    assert.match(reply1.result.content[0].text, /valid HTTP or HTTPS URL/);
  await handleMessage({
    jsonrpc: "2.0",
    id: 991,
    method: "tools/call",
    params: { name: "capture_site_motion", arguments: { url: "invalid" } },
  }, write);
  assert.equal(writes.length, 7);
  const reply1 = JSON.parse(writes[6]);
  assert.equal(reply1.id, 991);
  assert.equal(reply1.result.isError, true);
  assert.match(reply1.result.content[0].text, /valid HTTP or HTTPS URL/);

    // 10. non-Error thrown during message handling
    await handleMessage({
      jsonrpc: "2.0",
      id: 992,
      get method() {
        throw "primitive-string-error";
      },
    }, write);
    assert.equal(writes.length, 8);
    const reply2 = JSON.parse(writes[7]);
    assert.equal(reply2.id, 992);
    assert.equal(reply2.result.isError, true);
    assert.equal(reply2.result.content[0].text, "primitive-string-error");
  // 10. non-Error thrown during message handling
  await handleMessage({
    jsonrpc: "2.0",
    id: 992,
    get method() {
      throw "primitive-string-error";
    },
  }, write);
  assert.equal(writes.length, 8);
  const reply2 = JSON.parse(writes[7]);
  assert.equal(reply2.id, 992);
  assert.equal(reply2.result.isError, true);
  assert.equal(reply2.result.content[0].text, "primitive-string-error");

  // 11. writeMessage and errorResult
  const originalWrite = process.stdout.write;
  let directWrite;
  process.stdout.write = (chunk) => {
    directWrite = chunk;
    return true;
  };
  try {
    writeMessage({ test: 123 });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(directWrite, '{"test":123}\n');

    const errRes = errorResult("custom-err");
    assert.deepEqual(errRes, {
      content: [{ type: "text", text: "custom-err" }],
      isError: true,
    });
  const errRes = errorResult("custom-err");
  assert.deepEqual(errRes, {
    content: [{ type: "text", text: "custom-err" }],
    isError: true,
  });
});

test("additional branch coverage for input parameters and http urls", () => {
  const httpInput = validateCaptureInput({
    url: "http://example.test",
    consent_mode: "accept",
    consent_accept_approved: true,
    consent_settings_selector: ".settings",
    consent_optional_selector: ".optional",
    consent_save_selector: ".save",
    hover_selector: ".hover",
    click_selector: ".click",
    consent_selector: ".consent",
  });
  assert.equal(httpInput.url, "http://example.test/");
  assert.equal(httpInput.consentMode, "accept");
  assert.equal(httpInput.consentAcceptApproved, true);
  assert.equal(httpInput.consentSettingsSelector, ".settings");
  assert.equal(httpInput.consentOptionalSelector, ".optional");
  assert.equal(httpInput.consentSaveSelector, ".save");
  assert.equal(httpInput.hoverSelector, ".hover");
  assert.equal(httpInput.clickSelector, ".click");
  assert.equal(httpInput.consentSelector, ".consent");

  // Invalid protocol
  assert.throws(
    () => validateCaptureInput({ url: "ftp://example.test" }),
    /url must use http:\/\/ or https:\/\/\./
  );

  // Invalid consent_mode
  assert.throws(
    () => validateCaptureInput({ url: "https://example.test", consent_mode: "invalid-mode" }),
    /consent_mode must be reject, accept, none, or granular\./
  );

  // Granular consent with missing selector
  assert.throws(
    () => validateCaptureInput({ url: "https://example.test", consent_mode: "granular" }),
    /granular consent_mode requires consent_settings_selector, consent_optional_selector, and consent_save_selector\./
  );

  // Accept consent without explicit approval
  assert.throws(
    () => validateCaptureInput({ url: "https://example.test", consent_mode: "accept", consent_accept_approved: false }),
    /accept consent_mode requires explicit consent_accept_approved=true\./
  );
});

test("resolveConnection vastai error and missing endpoint branches", async () => {
  const bin = await shimBin();
  const prevPath = process.env.PATH;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  const prevHost = process.env.SITE_MOTION_SSH_HOST;
  const prevPort = process.env.SITE_MOTION_SSH_PORT;
  delete process.env.SITE_MOTION_SSH_URL;
  delete process.env.SITE_MOTION_SSH_HOST;
  delete process.env.SITE_MOTION_SSH_PORT;
  process.env.PATH = `${bin}:${process.env.PATH}`;

  try {
    await writeExecutable(bin, "vastai", "process.exit(1);");
    await assert.rejects(() => resolveConnection(), /Could not resolve the Vast SSH endpoint/);

    await writeExecutable(bin, "vastai", "process.stdout.write('invalid\\n');");
    await assert.rejects(() => resolveConnection(), /The Vast CLI did not return an SSH endpoint/);
  } finally {
    process.env.PATH = prevPath;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl;
    if (prevHost !== undefined) process.env.SITE_MOTION_SSH_HOST = prevHost;
    if (prevPort !== undefined) process.env.SITE_MOTION_SSH_PORT = prevPort;
  }
});

test("server startup initializes custom environment variables", async () => {
  const customOut = await tempDir("custom-env-out-");
  const rootDir = (await import("node:url")).fileURLToPath(new URL("..", import.meta.url));
  const proc = (await import("node:child_process")).spawn(
    process.execPath,
    [join(rootDir, "index.mjs")],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        VAST_INSTANCE_ID: "99999999",
        SITE_MOTION_REMOTE_ROOT: "/custom/remote/root",
        SITE_MOTION_REMOTE_OUTPUT: "/custom/remote/root/out",
        SITE_MOTION_OUTPUT_DIR: customOut,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const replies = await new Promise((resolve, reject) => {
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      } else {
        reject(new Error(`exit ${code}: ${output}`));
      }
    });
    proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  });
  assert.deepEqual(replies[0].result, {});
});
