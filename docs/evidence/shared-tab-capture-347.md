# Shared Live tab capture — Issue #347

Validated on macOS with Chrome for Testing 153.0.8010.12, November 12, 2026.

The native MV3 smoke in `tests/extension/shared-tab-capture.spec.js` passes with:

- Two toolbar-launched Live windows using different saved graphs and two dedicated
  model Workers per window; both produce nonempty PCM-derived display output.
- Simultaneous Start acquires one stream ID, one native MediaStream, one capture
  AudioContext and one audible source-to-destination connection for their tab.
- Stopping and restarting one graph joins the existing stream without replay or
  another acquisition. Closing the window that minted the stream ID leaves the
  peer running. Last Stop ends native capture; a subsequent Start captures afresh.
- Two different source tabs have two streams and two playback connections.
  Navigation stops/revokes only the matching target; invoking another tab never
  authorizes the old window again.
- Explicit offscreen host loss releases native capture and reports an actionable
  error. An explicit Start recovers; reloading Live releases its subscription and
  reaching Ready does not restart capture.

The smoke uses actual Chrome toolbar grants, offscreen getUserMedia, Web Audio,
worklet/resampling, runtime ports, graph execution and Live pages. A synthetic
440 Hz tone and controlled ASR Worker replies isolate capture/ownership from
model accuracy. Speaker restoration is checked by connection count and teardown,
not physical listening, volume or echo measurement. No third-party meeting or
real-model accuracy test was performed for this change.

The process boundary was verified experimentally: minting a stream ID in the
service worker failed when the isolated offscreen document tried to consume it;
a same-extension-tab control succeeded. Minting the one-use ID in an authorized
isolated Live page lets the isolated offscreen owner consume it successfully.
COOP/COEP and manifest permissions remain unchanged. The issuing Live page owns
no native media resources, and the smoke explicitly closes that issuer first.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 1,013 passed, no failures/skips. |
| Affected extension selection: extension, toolbar-launch, shared-tab-capture, live-model-preparation, web-voice specs | 116 cases validated: 110 passed the broad run; six fixture-related failures passed targeted rechecks after correction. Final expanded native smoke also passed. |
| `npx playwright test tests/browser/tab-audio.spec.js --workers=1` | 50 passed across Chromium and WebKit. |
| `npm run build:extension` | 269 packaged files verified; no model weights. |
| `git diff --check` | Passed. |

The fixture corrections move legacy window-local audio tests to the native source
now owned by offscreen, provide tiny verified model assets for lifecycle tests,
explicitly request cache-only behavior in the no-download check, and use native
worklet timestamps in the Web microphone latency probe. They do not change model
or microphone behavior. Deterministic tests additionally cover pending grants,
last-unsubscribe/reacquire barriers, denial/stream end, independent bounded queues,
invalid acknowledgments, buffer copies, fractional resampler timestamps and
trimming pre-join samples from queued/partial blocks. Authorization tests cover
forged tab/session/page combinations and navigation during an asynchronous launch.

See the [concurrent capture guide](../chrome-extension.md#concurrent-live-windows-capturing-the-same-tab-347)
for the architecture, recovery behavior and exact native-smoke command.
