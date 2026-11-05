# Issue #219 execution evidence

Validated 2026-11-05 in the assigned Git worktree, on macOS ARM64 with Node
26.12.1, Playwright 1.63.0 and its Chromium/Chrome for Testing 153.0.8010.12.

- `npm ci --ignore-scripts --no-audit --no-fund`: installed the lockfile dependencies.
- `npm test`: **785 tests passed**, zero failed/skipped, including existing Hold
  feedback, typed graph, Pipeline async provenance, model failure and session tests.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-actions.spec.js tests/extension/graph-hold-feedback.spec.js`:
  **3 passed**. The two new tests package the actual MV3 manifest, extension and
  shared web modules. Real extension pages/Workers run with controlled capture,
  ASR and summary implementations. The existing sampled feedback test passed too.
- `ASR_BASE_URL=http://127.0.0.1:18749 npx playwright test tests/browser/hold-feedback.spec.js --project chromium`:
  **2 passed**, served from this worktree's web directory on an isolated local
  port. The normal test server's port 8000 was occupied; the unrelated server was
  left alone. Tests cover async feedback FIFO, owned work, Stop and Cancel/restart.
- `git diff --check`: passed.
- `npm run build:extension`: stopped with **“Missing local models. Run npm run
  prepare:assets first.”** No full-distribution build or real-model smoke result
  is claimed. The package allowlist includes the new shared Button module.

The new unit cases exercise sink-only ANY compatibility for all existing concrete
contracts; strict TEXT/NUMBER/ITEM boundaries; rejection of ANY outputs; grouped
input-before-trigger order; missing initial state versus explicit empty strings;
repeated/falsy triggers; lightweight payload retention and typed sibling snapshots;
connection-dependent cycle detection and execution selection; and sampled outputs
remaining silent when wired to ANY. They check direct typed Button emissions,
multiple independent buttons/Holds with equal labels, bounded UI admission,
external-trigger FIFO and backlog overflow, snapshots while inference is pending,
loading/generation errors, honest oversized-input rejection before lazy allocation,
Stop draining, cancellation during lazy load/inference, and idle/stale callbacks
across session restart. A concurrent-source regression also verifies that Button
paths remain live when one capture ends, while startup-only Number configuration
does not keep the ended ASR branch open.

The new MV3 tests exercise the production Sources palette and caption inspector;
Save/Load/Import/Export persistence; active-node-only button rendering ordered by
Node ID; duplicate-caption independence; fan-out; audio-free Start; and the
manual-summary example's actual recorder/session/Pipeline/Display wiring. ASR final
events keep accumulating/displaying during delayed inference. Only accepted
button activations generate requests; busy activations are unavailable. Results
appear in the Summary input tab while Transcript remains a separate selectable tab.
The browser test uses Enter, Space and touch activation at 390×844, checks 44px
minimum action height and no horizontal document overflow, and reports no page
errors or CSP violations. [390px fixture screenshot](graph-actions-219-390.png)
shows a completed controlled summary and an enabled Graph Action.

TextSummary downstream of a triggered Hold allocates no Worker/model at Start;
the first valid TEXT request performs cache-only initialization. The first click
therefore pays model loading latency. Ordinary ungated summaries retain startup
preflight behavior. The full 32,768 UTF-16 input limit and explicit overflow
errors remain unchanged; there is no hidden truncation.

Not run: real microphone/tab permission prompts, live capture/ASR, real WebGPU model
initialization/inference, full model-bearing distribution build, real throughput,
RAM/GPU measurements, mobile-device qualification or WebKit extension tests.
Controlled-Worker tests establish composition/lifecycle, not model accuracy or
hardware performance. Model asset preparation and the repository's opt-in real
smoke tests remain required for those claims.
