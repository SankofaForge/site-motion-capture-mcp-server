# site-motion-capture

This MCP server captures live website motion on the rented Vast.ai GPU VM. It
uses the existing Playwright recorder on that VM and copies the WebM video and
jank report to the local machine. Each capture also leaves a persistent
`<name>.capture-cell.v2.json` contract record beside those two artifacts.

Use `design-inspiration` to find candidate sites. Use this server after a site
has been selected and its live behavior needs inspection.

In Antigravity, pass the returned local `.webm` path directly to native video
understanding for the motion analysis step. Do not start the standalone
`gemini-vision` MCP or upload the recording through the Gemini API for this
workflow. Ask the native analyzer for a concise description and at most eight
timestamped moments using the shape `{ description, moments: [{ timestamp_s,
why }] }`, then use those timestamps for frame extraction and implementation
planning.

## Tools

- `capture_site_motion` records page load, scroll, and optional hover or click
  behavior. Desktop captures default to 1920×1080. It returns local and remote
  artifact paths in both `content` and MCP `structuredContent`. The contract
  includes URL/final URL, viewport and modes, worker and recorder metadata,
  consent, artifact sizes and SHA-256 hashes, media/jank validation, cleanup,
  and a `complete`, `partial`, or `blocked` status. The MCP keeps Playwright's WebM encoder at an 8 Mbps target
  so text and fine UI details remain readable. It rejects non-essential cookie
  consent by default and records the action in the jank report.
- `check_capture_gpu` checks both `nvidia-smi` and the Chromium WebGL renderer.

## Consent and interaction policy

Captures use `consent_mode: "reject"` by default. The public options are:

- `reject` rejects non-essential cookies and records the action.
- `accept` accepts all cookies only when `consent_accept_approved: true` is supplied explicitly. It fails closed otherwise.
- `none` inspects consent state without waiting for or interacting with controls.
- `granular` applies the settings, optional-cookie, and save selectors in order.

The recorder uses an unrecorded preflight context, then carries its storage
state into the recorded context. It checks both contexts, including child
frames. For `reject`, `accept`, and `granular`, a result is `verified` only when
the consent surface is gone after the required action. `dismissed` is then
`true`. If no safe control was found, the outcome is `no-safe-action`. If a
surface remains or a blind spot prevents verification, the result is not
verified. In `none` mode, no dialog means `verified: true`, `dismissed: false`,
and outcome `no-consent-surface`. A present dialog means
`verified: false`, `dismissed: false`, and outcome `consent-surface-present`.
If a page blocks consent or scroll inspection, the recorder bounds that check
and reports `consent-check-timeout` with a blind-spot entry; the video can still
be published, but it must not be treated as consent-verified.
The report keeps the mode, action, selector, phase, frame, reason, attempts,
budget, and click count.

For an unusual control, pass `consent_selector`. It must be an explicit,
stable CSS selector for the intended control. The same rule applies to
`hover_selector` and `click_selector`. Selectors do not cross iframe
boundaries. Automatic detection can miss shadow-DOM controls and controls
hidden behind closed shadow roots.

`consent_wait_ms` sets how long the recorder waits for the dialog. Set
`consent_preflight: false` to skip the unrecorded pass. Localization guidance
must be written in English and include an explicit selector for each localized
control. Do not depend on translated visible text alone.

Keep each capture within the 8-second interaction budget. The default
discovery pass uses at most six clicks. Add explicit selectors for required
interactions outside that pass. Automatic discovery is best-effort and does
not prove that every interaction was captured.

The local `name` is a stable file stem for the copied `.webm` and `.jank.json`
files. The matching `<name>.capture-cell.v2.json` is retained after staging cleanup.
It is not the remote run ID. Keep the local name stable when comparing
runs. Use the remote run ID for remote logs and cleanup. Unless `output_dir` or
`SITE_MOTION_OUTPUT_DIR` is supplied, local artifacts are saved under
`artifacts/design-inspiration/site-motion-capture/` in the MCP client's current
workspace. Use `overwrite: false` when available so an existing local capture
is preserved. Cleanup reports one status per artifact: `removed`, `missing`,
`skipped`, or `failed`. A cleanup failure does not erase the staged artifacts or
the manifest. Set `reduced_motion: true` to propagate Playwright's
`prefers-reduced-motion: reduce` emulation to the recorded context.
Set `mobile: true` to use a 390×844 viewport with Playwright mobile and touch
emulation. Captures without scrolling are marked partial because the visual
workflow requires completed scroll evidence.

Transfer integrity requires non-zero files and matching size/SHA-256 values.
The jank report must match the requested viewport and contain the complete
`jank-report.v1` fields. Media validation requires `ffprobe` to identify WebM,
report a positive duration, and find at least one video stream. Missing or
invalid media, jank, consent, scroll, GPU, egress, or cleanup evidence cannot
produce a complete capture.

The capture worker must run inside the dedicated Linux network namespace. Its
host-side proxy is the only egress path and applies the exact-host public
`capture-exact-host.v1` policy. Before launching Chromium, the recorder reads
the root-owned file at `CAPTURE_EGRESS_ATTESTATION_FILE`. The file must not be
group or world writable, must be fresh for at most 120 seconds, and must bind
the URL hostname, runner instance, recorder version, Chromium executable and
version, Browser Use pin, and network namespace inode. The recorder also
checks that its Chromium child has the same namespace inode and is its direct
child. The direct-egress control must be blocked and the approved proxy probe
must pass. If the runner cannot provide this proof, capture is blocked before
page navigation. Configure `VAST_INSTANCE_ID` and
`EXPECTED_BROWSER_USE_VERSION` in the remote runner as part of the boundary
setup; do not supply or synthesize attestation files from the MCP client. The
full `runner-egress-boundary.v1` object is retained under
`evidence.egressAttestation` in the local capture-cell manifest. Its namespace
inode and the concise `evidence.egress.networkNamespaceInode` summary are both
positive JSON integers so downstream validators can compare them directly.

The worker preserves its remote run directory when process exit or evidence
validation is uncertain. It removes that directory only after the capture
process exits and artifact validation finishes. A pending remote cleanup makes
the capture partial while preserving local artifacts.

## Performance acceptance

The comparison helper is offline. It never starts a capture. First collect a
rollback baseline by manually selecting the rollback server, then collect the
Browser Use candidate on the same runner and frozen fixture set. Record three
cold and five warm four-cell runs for each route. Use the same documented cold
and warm procedure for both routes. Each run must contain exactly one complete
capture for `desktop-full`, `desktop-reduced`, `mobile-full`, and
`mobile-reduced`.

For every cell, record elapsed milliseconds for the full capture stage,
including capture, conversion, transfer, and local evidence validation. Set
`timeoutMs` to that cell's existing workflow timeout and record whether it
timed out. Record peak memory in bytes from the same runner-side process or
cgroup measurement boundary for both routes. A cell that is incomplete, timed
out, or exceeds its timeout invalidates the dataset.

Save the measurements as JSON using `capture-performance.v1`. The top-level
`runner` contains non-empty `id`, `machineFingerprint`, and `fixtureSetId`;
the same values must appear in each route's `runner`. Declare the absolute
`workspaceRoot` containing the capture-cell manifests and their video/jank
artifacts. `machineFingerprint` must identify the same OS image, CPU/GPU and
driver, browser, Node, and FFmpeg. `fixtureSetId` identifies the frozen
animation and consent fixtures. Record the exact cold and warm procedures in
`measurementProtocol.cold` and `measurementProtocol.warm`. Each route has a
`runtime` object with its own `captureRuntime`, `captureRuntimeVersion`,
`browserExecutable`, `browserVersion`, `browserUseVersion`, and
`mediaToolVersion`. A run has a unique `id`, `temperature` (`cold` or `warm`),
and four `captures`, each containing `cellId`, `status`, `timedOut`,
`durationMs`, `timeoutMs`, `peakMemoryBytes`, `runId`, workspace-relative
`manifestPath`, and `manifestSha256`.

The comparator verifies each manifest hash and matching run/cell/complete
status. It also checks that the referenced WebM and jank files remain inside
the workspace and match their recorded sizes and hashes. The report retains
the two route-specific runtime objects. It does not run `ffprobe` or independently
revalidate WebM content; media validity comes from the already validated
capture-cell manifest. The Node tests use synthetic manifest and artifact bytes
to exercise the comparator only, not to claim live capture acceptance.

Run the comparison after collecting both datasets:

```sh
node scripts/compare-performance.mjs /path/to/capture-performance.v1.json
```

The helper rejects runner or fixture mismatches, missing or duplicate cells,
wrong cold/warm sample counts, incomplete captures, altered or escaping
artifacts, and timeout violations. It compares cold, warm, and combined
samples against the rollback baseline: each cell's p95 duration and the p95
of the sum of four recorded durations per matrix. It also compares peak
memory for every cell and matrix group. A pass requires every value to be at
most 20% above baseline. With three cold and five warm runs, nearest-rank
p95 is the slowest observation in each group. Keep the measurement file and
report with the acceptance evidence; do not add them to source control.

## Runtime

The server has no npm dependencies. The launcher sources `~/.zsh_secrets` for
the Vast API key and the Vast CLI environment. The API key does not appear in
the MCP configuration.

The launcher requires an explicit worker configuration. Set `VAST_INSTANCE_ID`
for Vast CLI resolution, or set `SITE_MOTION_SSH_URL` to an explicit
`ssh://user@host:port` endpoint. There is no default instance. If neither is
configured, tools return an `isError: true` blocked result with reason code
`capture-worker-unconfigured`. Stale or unavailable workers return
`capture-worker-unavailable`, and bounded preflight diagnostics never include
API keys, tokens, passwords, or SSH URL passwords.

Before capture, the launcher verifies SSH reachability, the remote recorder at
`/workspace/site-motion-capture`, `capture.mjs`, `check-gpu-renderer.mjs`,
Node/Playwright, and `ffprobe`. GPU capture also requires a fresh
`check_capture_gpu` result. Missing files, dependencies, GPU, WebGL, or a
bounded SSH/preflight timeout return structured blocked errors and do not
create local evidence artifacts.

The worker checks each HTTP or HTTPS request, including redirects and
subresources. It blocks requests whose DNS answers include private or reserved
addresses. For the starting host, the worker also requires a match with the
bridge's DNS answers when the bridge returns IP addresses. Chromium resolves
the host again when it connects, so a DNS change after the check can still
affect the connection.
