import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat, chmod, symlink } from "node:fs/promises";
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
  assertPublicResolution,
  resolvePublicAddresses,
  isPrivateAddress,
  captureSiteMotion as rawCaptureSiteMotion,
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
  resolveOutputDirectory,
  resolveExistingAncestor,
  acquireCaptureLock,
  releaseCaptureLock,
  verifyRemoteWorker,
  workerPreflightError,
} from "../index.mjs";
import { tempDir, shimBin, writeExecutable } from "./fixtures.mjs";

function captureSiteMotion(input) {
  return rawCaptureSiteMotion({ gpu: false, ...input });
}

test("run() handles timeouts, stderr data, error events, signals, and exit codes", async () => {
  // Timeout
  const timeoutResult = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 50,
  });
  assert.equal(timeoutResult.code, 124);
  assert.match(timeoutResult.error.message, /timed out after 50 ms/);

  // Timeout with escalated SIGKILL when process ignores SIGTERM
  const sigkillResult = await run(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    {
      timeoutMs: 50,
      killDelayMs: 20,
    }
  );
  assert.equal(sigkillResult.code, 124);
  assert.match(sigkillResult.error.message, /timed out after 50 ms/);
  await new Promise((resolve) => setTimeout(resolve, 60));

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

test("run() bounds process output and falls back when process-group signaling fails", async () => {
  const boundedResult = await run(process.execPath, [
    "-e",
    "process.stdout.write('a'.repeat(16384)); setTimeout(() => process.stdout.write('b'), 25);",
  ]);
  assert.equal(boundedResult.stdout.length, 16 * 1024);
  assert.equal(boundedResult.stdout.includes("b"), false);

  const controller = new AbortController();
  controller.abort();
  const cancelledResult = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
  });
  assert.equal(cancelledResult.code, 124);
  assert.match(cancelledResult.error.message, /was cancelled/);

  const originalKill = process.kill;
  const attemptedSignals = [];
  process.kill = (_pid, signal) => {
    attemptedSignals.push(signal);
    throw new Error("process group is unavailable");
  };
  try {
    const fallbackResult = await run(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 40, killDelayMs: 20 },
    );
    assert.equal(fallbackResult.code, 124);
    assert.deepEqual(attemptedSignals, ["SIGTERM", "SIGKILL"]);
  } finally {
    process.kill = originalKill;
  }
});

test("run() keeps the first cancellation when the timeout fires during shutdown", async () => {
  const readyFile = join(await tempDir("run-shutdown-"), "ready");
  const controller = new AbortController();
  const running = run(
    process.execPath,
    ["-e", `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`],
    { timeoutMs: 500, killDelayMs: 750, signal: controller.signal },
  );

  let childReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(readyFile);
      childReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(childReady, true);
  controller.abort();

  const result = await running;
  assert.equal(result.code, 124);
  assert.match(result.error.message, /was cancelled/);
});

test("trimOutput() trims and truncates diagnostics to a bounded size", () => {
  assert.equal(trimOutput("  hello world  "), "hello world");
  const longText = "a".repeat(4500);
  const trimmed = trimOutput(longText);
  assert.equal(trimmed.length, 1201); // 1200 slice + '…'
  assert.ok(trimmed.endsWith("…"));
});

test("public-resolution guards cover literal and DNS safety paths", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("203.0.113.10"), false);
  for (const address of [
    "0.0.0.1",
    "10.0.0.1",
    "169.254.1.1",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.254",
    "100.127.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.19.255.254",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:192.168.1.1",
    "100::1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "2001:db8::1",
    "2001:10::1",
    "ff00::1",
    "2001:2::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("100.128.0.1"), false);
  assert.equal(isPrivateAddress("172.32.0.1"), false);
  assert.equal(isPrivateAddress("192.0.3.1"), false);
  assert.equal(isPrivateAddress("192.88.98.1"), false);
  assert.equal(isPrivateAddress("198.20.0.1"), false);
  assert.equal(isPrivateAddress("172.15.0.1"), false);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.deepEqual(await resolvePublicAddresses("https://8.8.8.8/"), ["8.8.8.8"]);
  await assert.rejects(
    () => resolvePublicAddresses("https://192.0.2.1/"),
    /url must resolve only to public IP addresses/
  );
  await assert.rejects(() => assertPublicResolution("https://[::1]/"), /public IP/);
  await assert.rejects(
    () => assertPublicResolution("https://localhost/"),
    /url must resolve only to public IP addresses/
  );
  await assert.rejects(
    () => assertPublicResolution("https://does-not-exist.invalid/"),
    /url host could not be resolved safely/
  );
});

test("GPU capture fails before resolving the worker and omitted scroll stays auto-measured", async () => {
  await assert.rejects(
    async () => captureSiteMotion({ url: "https://example.test", output_dir: await tempDir("gpu-required-"), gpu: true }),
    /fresh GPU check/
  );
  assert.equal(validateCaptureInput({ url: "https://example.test" }).scrollDistance, null);
});

test("output roots are checked after symlink resolution", async () => {
  const root = await tempDir("approved-output-");
  const outside = "/etc";
  const link = join(root, "linked");
  await symlink(outside, link);
  const previous = process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT;
  process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT = root;
  try {
    await assert.rejects(() => resolveOutputDirectory(link), /approved workspace output root/);
  } finally {
    if (previous === undefined) delete process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT;
    else process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT = previous;
  }
});

test("output root checks cover missing paths, unresolved links, and post-create changes", async () => {
  const root = await tempDir("approved-output-paths-");
  const previous = process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT;
  process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT = root;
  try {
    const nested = join(root, "missing", "output");
    const originalRealpath = (await import("node:fs/promises")).realpath;
    assert.equal(await resolveOutputDirectory(nested), await originalRealpath(nested));

    const dangling = join(root, "dangling");
    await symlink(join(root, "missing-target"), dangling);
    await assert.rejects(
      () => resolveOutputDirectory(join(dangling, "child")),
      /unresolved symbolic link/
    );

    const fileParent = join(root, "file-parent");
    await writeFile(fileParent, "not a directory");
    await assert.rejects(() => resolveOutputDirectory(join(fileParent, "child")), { code: "ENOTDIR" });

    let requestedPathChecks = 0;
    const pathRealpath = async (path) => {
      if (path === nested && requestedPathChecks++ === 1) return "/etc";
      return originalRealpath(path);
    };
    await assert.rejects(
      () => resolveOutputDirectory(nested, { pathRealpath }),
      /approved workspace output root/
    );

    const missing = Object.assign(new Error("missing ancestor"), { code: "ENOENT" });
    await assert.rejects(
      () => resolveExistingAncestor("/virtual/root", {
        pathRealpath: async () => { throw missing; },
        pathLstat: async () => { throw missing; },
        pathDirname: (path) => path,
      }),
      (error) => error === missing
    );
    await assert.rejects(
      () => resolveExistingAncestor("/virtual/file", {
        pathRealpath: async () => { throw missing; },
        pathLstat: async () => ({ isSymbolicLink: () => false }),
        pathDirname: (path) => path,
      }),
      (error) => error === missing
    );
  } finally {
    if (previous === undefined) delete process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT;
    else process.env.SITE_MOTION_APPROVED_OUTPUT_ROOT = previous;
  }
});

test("stale lock owners can be reclaimed but live or malformed locks remain busy", async () => {
  const out = await tempDir("lock-owner-");
  const stale = join(out, ".stale.capture.lock");
  await mkdir(stale);
  await writeFile(join(stale, "owner.json"), JSON.stringify({ pid: 1, createdAt: Date.now() - 31 * 60 * 1000, token: "old" }));
  const owner = await acquireCaptureLock(stale);
  assert.equal(typeof owner.token, "string");
  const live = join(out, ".live.capture.lock");
  await mkdir(live);
  await writeFile(join(live, "owner.json"), JSON.stringify({ pid: 1, createdAt: Date.now(), token: "live" }));
  await assert.rejects(() => acquireCaptureLock(live), /capture_target_busy/);

  const missingTimestamp = join(out, ".missing-timestamp.capture.lock");
  await mkdir(missingTimestamp);
  await writeFile(join(missingTimestamp, "owner.json"), JSON.stringify({ pid: 1, token: "old" }));
  await assert.rejects(() => acquireCaptureLock(missingTimestamp), /capture_target_busy/);

  const malformed = join(out, ".malformed.capture.lock");
  await mkdir(malformed);
  await writeFile(join(malformed, "owner.json"), "{");
  await assert.rejects(() => acquireCaptureLock(malformed), /capture_target_busy/);

  const reclaimBusy = join(out, ".reclaim-busy.capture.lock");
  await mkdir(reclaimBusy);
  await mkdir(`${reclaimBusy}.reclaim`);
  await assert.rejects(() => acquireCaptureLock(reclaimBusy), /capture_target_busy/);

  let makeDirectoryCalls = 0;
  const reclaimError = Object.assign(new Error("reclaim directory unavailable"), { code: "EACCES" });
  await assert.rejects(
    () => acquireCaptureLock(join(out, ".reclaim-failure.capture.lock"), {
      makeDirectory: async () => {
        makeDirectoryCalls += 1;
        if (makeDirectoryCalls === 1) throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
        throw reclaimError;
      },
    }),
    (error) => error === reclaimError
  );
  assert.equal(makeDirectoryCalls, 2);

  await assert.rejects(() => acquireCaptureLock(join(out, "missing-parent", "lock")), { code: "ENOENT" });
});

test("capture lock cleanup removes failed owner writes and preserves other owners", async () => {
  const out = await tempDir("lock-cleanup-");
  const failed = join(out, "failed.capture.lock");
  const writeError = Object.assign(new Error("owner write failed"), { code: "EIO" });
  await assert.rejects(
    () => acquireCaptureLock(failed, { writeOwner: async () => { throw writeError; } }),
    /owner write failed/
  );
  await assert.rejects(() => stat(failed), { code: "ENOENT" });

  const missingOwner = join(out, "missing-owner.capture.lock");
  await mkdir(missingOwner);
  await releaseCaptureLock(missingOwner, { token: "mine" });

  const otherOwner = join(out, "other-owner.capture.lock");
  await mkdir(otherOwner);
  await writeFile(join(otherOwner, "owner.json"), JSON.stringify({ token: "theirs" }));
  await releaseCaptureLock(otherOwner, { token: "mine" });
  assert.equal((await stat(join(otherOwner, "owner.json"))).isFile(), true);

  const malformedOwner = join(out, "malformed-owner.capture.lock");
  await mkdir(malformedOwner);
  await writeFile(join(malformedOwner, "owner.json"), "{");
  await assert.rejects(() => releaseCaptureLock(malformedOwner, { token: "mine" }), SyntaxError);
});

test("public DNS resolution sorts records and rejects empty or failed lookups", async () => {
  const dns = async () => [{ address: "8.8.8.8" }, { address: "1.1.1.1" }];
  assert.deepEqual(
    await resolvePublicAddresses("https://resolver.fixture.test", dns),
    ["1.1.1.1", "8.8.8.8"]
  );
  await assert.rejects(
    () => resolvePublicAddresses("https://resolver.fixture.test", async () => { throw new Error("dns error"); }),
    /url host could not be resolved safely/
  );
  await assert.rejects(
    () => resolvePublicAddresses("https://resolver.fixture.test", async () => []),
    /url must resolve only to public IP addresses/
  );
  await assert.rejects(
    () => resolvePublicAddresses("https://resolver.fixture.test", async () => [{ address: "127.0.0.1" }]),
    /url must resolve only to public IP addresses/
  );
  await assert.rejects(
    () => assertPublicResolution("https://empty.fixture.test", async () => []),
    /url must resolve only to public IP addresses/
  );
});

test("worker preflight errors classify diagnostics and cover remote failures", async () => {
  const cases = [
    [new Error("request timed out"), "capture-worker-timeout"],
    [new Error("missing capture.mjs"), "capture-worker-files-missing"],
    [new Error("missing check-gpu-renderer.mjs"), "capture-worker-files-missing"],
    [new Error("missing node"), "capture-worker-dependency-missing"],
    [new Error("missing ffprobe"), "capture-worker-dependency-missing"],
    [new Error("missing playwright"), "capture-worker-dependency-missing"],
    [new Error("Cannot find package 'playwright'"), "capture-worker-dependency-missing"],
    [new Error("connection refused"), "capture-worker-unavailable"],
    [new Error("could not resolve hostname"), "capture-worker-unavailable"],
    [new Error("no route to host"), "capture-worker-unavailable"],
    [new Error("permission denied"), "capture-worker-unavailable"],
    [new Error("host key verification failed"), "capture-worker-unavailable"],
    [new Error("name or service not known"), "capture-worker-unavailable"],
    [new Error("unknown preflight failure"), "capture-worker-preflight-failed"],
    ["unknown non-error preflight failure", "capture-worker-preflight-failed"],
  ];
  for (const [diagnostic, reasonCode] of cases) {
    assert.equal(workerPreflightError(diagnostic).reasonCode, reasonCode);
  }

  const bin = await shimBin();
  const previousPath = process.env.PATH;
  const previousUrl = process.env.SITE_MOTION_SSH_URL;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.SITE_MOTION_SSH_URL = "ssh://root@fixture.test:22";
  await writeExecutable(bin, "ssh", "process.stderr.write('connection refused'); process.exit(255);");
  try {
    await assert.rejects(
      () => verifyRemoteWorker({ user: "root", host: "fixture.test", port: "22" }),
      /capture worker is unavailable/
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousUrl === undefined) delete process.env.SITE_MOTION_SSH_URL;
    else process.env.SITE_MOTION_SSH_URL = previousUrl;
  }
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

  // Credentials and URL suffixes can change how an SSH endpoint is interpreted.
  assert.throws(() => parseSshUrl("ssh://alice:secret@remote.host:2222"), /without credentials or query parameters/);
  assert.throws(() => parseSshUrl("ssh://alice@remote.host:2222?command=whoami"), /without credentials or query parameters/);
  assert.throws(() => parseSshUrl("ssh://alice@remote.host:2222#fragment"), /without credentials or query parameters/);
});

test("resolveConnection() requires an approved endpoint and supports Vast instance resolution", async () => {
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  const prevInstance = process.env.VAST_INSTANCE_ID;
  const prevPath = process.env.PATH;

  try {
    delete process.env.SITE_MOTION_SSH_URL;
    delete process.env.VAST_INSTANCE_ID;
    await assert.rejects(() => resolveConnection(), /Capture worker is not configured/);

    process.env.SITE_MOTION_SSH_URL = "   ";
    await assert.rejects(() => resolveConnection(), /Capture worker is not configured/);
    delete process.env.SITE_MOTION_SSH_URL;

    process.env.SITE_MOTION_SSH_URL = "ssh://alice@remote.host:2222";
    assert.deepEqual(await resolveConnection(), { user: "alice", host: "remote.host", port: "2222" });

    delete process.env.SITE_MOTION_SSH_URL;
    process.env.VAST_INSTANCE_ID = "configured-instance";
    const bin = await shimBin();
    await writeExecutable(bin, "vastai", `process.stdout.write("ssh://vastuser@vast.host.test:33333\\n");`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    assert.deepEqual(await resolveConnection(), { user: "vastuser", host: "vast.host.test", port: "33333" });
  } finally {
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl; else delete process.env.SITE_MOTION_SSH_URL;
    if (prevInstance !== undefined) process.env.VAST_INSTANCE_ID = prevInstance; else delete process.env.VAST_INSTANCE_ID;
    process.env.PATH = prevPath;
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
  await writeExecutable(bin, "ffprobe", `process.stdout.write(JSON.stringify({ format: { format_name: "matroska,webm", duration: "1.0" } }));`);
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
    const jankStr = JSON.stringify({ noConsentField: true, status: "valid" });
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

    // Successful capture covering mobile, no-scroll, selectors, and consent accept approved
    const gpuCheck = await checkCaptureGpu();
    const gpuCheckId = JSON.parse(gpuCheck.content[0].text).checkId;
    const resultFullOptions = await captureSiteMotion({
      url: "https://example.test",
      name: "no-consent",
      output_dir: out,
      overwrite: true,
      gpu: true,
      gpu_check_id: gpuCheckId,
      mobile: true,
      reduced_motion: true,
      no_scroll: true,
      consent_preflight: true,
      consent_selector: "#consent-btn",
      consent_settings_selector: "#settings-btn",
      consent_optional_selector: "#opt-btn",
      consent_save_selector: "#save-btn",
      hover_selector: "#hover-target",
      click_selector: "#click-target",
      consent_accept_approved: true,
    });
    const parsedFullReport = JSON.parse(resultFullOptions.content[0].text);
    assert.equal(parsedFullReport.cleanup, "confirmed");

    const mismatchedCheck = await checkCaptureGpu();
    const mismatchedCheckId = JSON.parse(mismatchedCheck.content[0].text).checkId;
    const configuredUrl = process.env.SITE_MOTION_SSH_URL;
    process.env.SITE_MOTION_SSH_URL = "ssh://root@different.example:22";
    try {
      await assert.rejects(() => captureSiteMotion({
        url: "https://example.test",
        name: "mismatched-gpu-check",
        output_dir: out,
        overwrite: true,
        gpu: true,
        gpu_check_id: mismatchedCheckId,
      }), /must match the configured capture worker/);
    } finally {
      process.env.SITE_MOTION_SSH_URL = configuredUrl;
    }

    await assert.rejects(() => captureSiteMotion({
      url: "https://example.test",
      name: "no-consent",
      output_dir: out,
      overwrite: true,
      gpu: true,
      gpu_check_id: "stale-gpu-check",
    }), /fresh GPU check/);

    // A valid capture can still be partial when the recorder reports degraded status.
    const partialJank = JSON.stringify({ status: "partial", finalUrl: "https://final.example", interactionFailures: [] });
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
  const video = Buffer.from("partial-video");
  const jank = Buffer.from(${JSON.stringify(partialJank)});
  fs.writeFileSync(dest, JSON.stringify({ runId, files: [
    { path: "partial.webm", size: video.length, sha256: crypto.createHash("sha256").update(video).digest("hex") },
    { path: "partial.jank.json", size: jank.length, sha256: crypto.createHash("sha256").update(jank).digest("hex") },
  ] }));
} else if (dest.endsWith(".webm")) {
  fs.writeFileSync(dest, "partial-video");
} else {
  fs.writeFileSync(dest, ${JSON.stringify(partialJank)});
}
`
    );
    const partialResult = await captureSiteMotion({
      url: "https://example.test",
      name: "partial",
      output_dir: out,
      overwrite: true,
    });
    const partialReport = JSON.parse(partialResult.content[0].text);
    assert.equal(partialReport.status, "partial");
    assert.equal(partialReport.finalUrl, "https://final.example");
    assert.deepEqual(partialReport.viewport, { width: 1920, height: 1080, mobile: false, reducedMotion: false });

    await assert.rejects(() => captureSiteMotion({
      url: "https://example.test",
      name: "partial",
      output_dir: out,
      overwrite: true,
      gpu: true,
      gpu_check_id: "stale-gpu-check",
      reduced_motion: true,
    }), /fresh GPU check/);

    // A transferred but unverified video is rejected before local promotion.
    await writeExecutable(bin, "ffprobe", "process.exit(1);");
    await assert.rejects(
      async () => captureSiteMotion({ url: "https://example.test", name: "partial", output_dir: out, overwrite: true }),
      /media validation failed/
    );

    // A transfer failure followed by a cleanup failure preserves the original error.
    await writeExecutable(bin, "ssh", `
const arg = process.argv.join(" ");
if (arg.includes("rm -rf")) process.exit(1);
process.stdout.write("ok\\n");
`);
    await writeExecutable(bin, "scp", "process.exit(1);");
    await assert.rejects(
      async () => captureSiteMotion({ url: "https://example.test", name: "transfer-failure", output_dir: out, overwrite: true }),
      /exited with code 1/
    );

    // Capture failure when remote rm cleanup in catch block fails -> cleanup stays pending
    await writeExecutable(
      bin,
      "ssh",
      `
const arg = process.argv.join(" ");
    if (arg.includes("--url") && arg.includes("capture.mjs")) {
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

test("checkCaptureGpu reports NVIDIA and Chromium renderer failures", async () => {
  const bin = await shimBin();
  const previousPath = process.env.PATH;
  const previousUrl = process.env.SITE_MOTION_SSH_URL;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.SITE_MOTION_SSH_URL = "ssh://root@fixture.test:22";
  try {
    await writeExecutable(bin, "ssh", `
const arg = process.argv.join(" ");
if (arg.includes("nvidia-smi")) process.exit(1);
process.stdout.write("worker ready\\n");
`);
    await assert.rejects(() => checkCaptureGpu(), /capture worker GPU check failed/);

    await writeExecutable(bin, "ssh", `
const arg = process.argv.join(" ");
if (arg.includes("'node' '") && arg.includes("/check-gpu-renderer.mjs'")) process.exit(1);
if (arg.includes("nvidia-smi")) process.stdout.write("NVIDIA RTX fixture\\n");
else process.stdout.write("worker ready\\n");
`);
    await assert.rejects(() => checkCaptureGpu(), /capture worker WebGL check failed/);

    const connection = { user: "root", host: "fixture.test", port: "22" };
    const verifyWorker = async () => {};
    const previousInstance = process.env.VAST_INSTANCE_ID;
    delete process.env.SITE_MOTION_SSH_URL;
    delete process.env.VAST_INSTANCE_ID;
    const configuredWorker = await checkCaptureGpu({
      resolveWorker: async () => connection,
      verifyWorker,
      remoteRunner: async (_connection, command) => ({
        stdout: command === "nvidia-smi" ? "NVIDIA RTX fixture" : "Chromium WebGL fixture",
      }),
    });
    const configuredWorkerData = JSON.parse(configuredWorker.content[0].text);
    assert.equal(configuredWorkerData.source, "unconfigured");
    assert.equal(configuredWorkerData.instanceId, null);
    if (previousInstance !== undefined) process.env.VAST_INSTANCE_ID = previousInstance;

    await assert.rejects(
      () => checkCaptureGpu({
        resolveWorker: async () => connection,
        verifyWorker,
        remoteRunner: async () => ({ stdout: "" }),
      }),
      /returned no GPU details/
    );
    let emptyRendererCall = 0;
    await assert.rejects(
      () => checkCaptureGpu({
        resolveWorker: async () => connection,
        verifyWorker,
        remoteRunner: async () => {
          emptyRendererCall += 1;
          return { stdout: emptyRendererCall === 1 ? "NVIDIA RTX fixture" : "" };
        },
      }),
      /returned no Chromium WebGL renderer/
    );
    await assert.rejects(
      () => checkCaptureGpu({
        resolveWorker: async () => connection,
        verifyWorker,
        remoteRunner: async () => { throw "GPU failure"; },
      }),
      (error) => error.reasonCode === "capture-gpu-unavailable" && error.diagnostic === "GPU failure"
    );

    let remoteCall = 0;
    await assert.rejects(
      () => checkCaptureGpu({
        resolveWorker: async () => connection,
        verifyWorker,
        remoteRunner: async () => {
          remoteCall += 1;
          if (remoteCall === 1) return { stdout: "NVIDIA RTX fixture" };
          throw "renderer failure";
        },
      }),
      (error) => error.reasonCode === "capture-gpu-webgl-unavailable" && error.diagnostic === "renderer failure"
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousUrl === undefined) delete process.env.SITE_MOTION_SSH_URL;
    else process.env.SITE_MOTION_SSH_URL = previousUrl;
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
  assert.match(reply2.result.content[0].text, /capture-error: primitive-string-error/);

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
  assert.equal(errRes.isError, true);
  assert.equal(errRes.structuredContent.reasonCode, "capture-error");
  assert.match(errRes.content[0].text, /custom-err/);

  const diagnosticResult = errorResult("custom-err", "request failed", "remote diagnostic output");
  assert.equal(diagnosticResult.structuredContent.diagnostic, "remote diagnostic output");
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

  for (const url of [
    "http://localhost/admin",
    "https://foo.localhost/admin",
    "https://foo.local/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.1/admin",
    "http://169.254.169.254/admin",
    "http://172.16.0.1/admin",
    "http://172.31.0.1/admin",
    "http://[::1]/admin",
    "http://[fc00::1]/admin",
    "http://[fd00::1]/admin",
    "http://[fe80::1]/admin",
    "https://user:pass@example.test/",
    "https://:pass@example.test/",
    "https://192.168.1.1/",
  ]) {
    assert.throws(() => validateCaptureInput({ url }), /public HTTP\(S\) host without credentials/);
  }
  assert.doesNotThrow(() => validateCaptureInput({ url: "http://172.15.0.1/" }));
  assert.throws(
    () => validateCaptureInput({ url: "https://example.test", output_dir: "/etc/site-motion-capture" }),
    /approved workspace output root/
  );
});

test("resolveConnection vastai error and missing endpoint branches", async () => {
  const bin = await shimBin();
  const prevPath = process.env.PATH;
  const prevUrl = process.env.SITE_MOTION_SSH_URL;
  const prevInstance = process.env.VAST_INSTANCE_ID;
  delete process.env.SITE_MOTION_SSH_URL;
  process.env.VAST_INSTANCE_ID = "stale-instance";
  process.env.PATH = `${bin}:${process.env.PATH}`;

  try {
    await writeExecutable(bin, "vastai", "process.exit(1);");
    await assert.rejects(() => resolveConnection(), /configured capture worker is unavailable/);

    await writeExecutable(bin, "vastai", "process.stdout.write('invalid\\n');");
    await assert.rejects(() => resolveConnection(), /configured Vast instance did not provide an SSH endpoint/);

    await writeExecutable(bin, "vastai", "process.stdout.write('ssh://invalid-host\\n');");
    await assert.rejects(() => resolveConnection(), /configured Vast instance returned an invalid SSH endpoint/);
  } finally {
    process.env.PATH = prevPath;
    if (prevUrl !== undefined) process.env.SITE_MOTION_SSH_URL = prevUrl;
    if (prevInstance !== undefined) process.env.VAST_INSTANCE_ID = prevInstance; else delete process.env.VAST_INSTANCE_ID;
  }
});

test("resolveConnection maps Vast CLI timeouts to the timeout reason", async () => {
  const previousUrl = process.env.SITE_MOTION_SSH_URL;
  const previousInstance = process.env.VAST_INSTANCE_ID;
  delete process.env.SITE_MOTION_SSH_URL;
  process.env.VAST_INSTANCE_ID = "timeout-instance";
  try {
    await assert.rejects(
      () => resolveConnection(undefined, async () => ({ error: new Error("vastai timed out") })),
      (error) => error.reasonCode === "capture-worker-timeout"
    );
  } finally {
    if (previousUrl === undefined) delete process.env.SITE_MOTION_SSH_URL;
    else process.env.SITE_MOTION_SSH_URL = previousUrl;
    if (previousInstance === undefined) delete process.env.VAST_INSTANCE_ID;
    else process.env.VAST_INSTANCE_ID = previousInstance;
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
