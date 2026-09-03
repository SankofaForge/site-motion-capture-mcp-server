# site-motion-capture

This MCP server captures live website motion on the rented Vast.ai GPU VM. It
uses the existing Playwright recorder on that VM and copies the WebM video and
jank report to the local machine.

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
  artifact paths. The MCP keeps Playwright's WebM encoder at an 8 Mbps target
  so text and fine UI details remain readable. It rejects non-essential cookie
  consent by default and records the action in the jank report.
- `check_capture_gpu` checks both `nvidia-smi` and the Chromium WebGL renderer.

## Consent and interaction policy

Captures use `consent_mode: "reject"` by default. The public options are:

- `reject` rejects non-essential cookies and records the action.
- `accept` accepts all cookies only when `consent_accept_approved: true` is supplied explicitly. It fails closed otherwise.
- `none` leaves the page untouched and does not attempt consent handling.
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
files. It is not the remote run ID. Keep the local name stable when comparing
runs. Use the remote run ID for remote logs and cleanup. Use `overwrite: false`
when available so an existing local capture is preserved. Cleanup reports one
status per artifact: `removed`, `missing`, `skipped`, or `failed`. A cleanup
failure does not mean that the capture failed.

## Runtime

The server has no npm dependencies. The launcher sources `~/.zsh_secrets` for
the Vast API key and the Vast CLI environment. The API key does not appear in
the MCP configuration.

The launcher resolves the SSH endpoint for instance `48790763` with the Vast
CLI. Override it with `VAST_INSTANCE_ID` or `SITE_MOTION_SSH_URL` when the
capture VM changes.

The remote recorder must exist at `/workspace/site-motion-capture` and must
provide `capture.mjs` and `check-gpu-renderer.mjs`.
