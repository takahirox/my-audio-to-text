# Page-owned Web microphone capture (#275)

The trusted original field mic click now calls `getUserMedia` in the isolated
content script on the current website. Site microphone permission is independent
of the optional extension host-access grant. No extension permission tab, visible
runtime page, popup, side panel or fallback permission workflow exists. The old
permission HTML/JS and setup handshake were removed.

The page owns its stream and mono 16 kHz AudioContext; native Web Audio handles
device resampling. A local AudioWorklet downmixes and emits 1280-sample / 80 ms
Float32 blocks, transferring them to the isolated content script. A native
ScriptProcessor fallback supports contexts where worklet setup is unavailable.
The content script base64-encodes float bytes for Chrome runtime Ports. The
coordinator authenticates the existing top-frame document/control Port and field
capability, validates sequence/size/window, and routes to its current offscreen
host generation. An extension PCM adapter feeds the existing MicrophoneAudio
source, TabSession, model preparation/cache, graph, VAD/ASR Workers and field output.
Multiple MicrophoneAudio consumers subscribe to the same document's source.
There is no graph schema change, model fork, network audio upload or inference in
the page/coordinator.

Only the existing page mic controls this lifetime. Preparing includes both native
permission and graph readiness. Physical capture may be held during preparation;
PCM starts when both are ready. Stop releases the track, flushes the final short
block, waits for ordered receipts, and then drains the graph. Cancel discards
pending audio and closes the context, including during graceful drain. A pending
native permission request cannot be programmatically dismissed; a late grant is
immediately stopped. Permission revocation, removed/invalid targets, pagehide,
navigation/tab close, Web OFF, connection loss, runtime loss and extension reload
release that page's resources. Other Web documents and Live retain their owners.

## Security and platform boundaries

No `window.postMessage`, MAIN-world capture script, DOM audio payload, web
accessible resource or transcript bridge was added. The widget uses its existing
closed shadow root and trusted event checks. Sites can change their own DOM and
observe inserted field text, but cannot inspect isolated variables/Ports or forge
trusted clicks. HTTPS/localhost and the site's microphone Permissions Policy are
required. Unsupported contexts, blocked consent and device errors give local
recovery feedback. A strict-CSP fixture exercises native capture without adding a
page script or bypassing policy. A site can always interfere with its own UI.
Native page microphone use can disqualify a document from Chrome's back-forward
cache; returning navigation still offers consent-checked idle controls.

The design follows the capture/PCM separation in this repository's
[earlier selected-media relay](../../extension/page-agent.js) (#81 / PR #82),
[Say, Pi's page capture path](https://github.com/Pedal-Intelligence/saypi-userscript),
and [Voice Message Transcriber's content → SW → offscreen flow](https://github.com/RobertoReale/Voice-Message-Transcriber).
It does not copy their whole-clip conversions, exposed page bridges or speech
providers. Chrome documents [JSON message serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
and [isolated content-script worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
This implementation makes no zero-copy claim for runtime Ports.

## Automated checks

Environment: macOS arm64, headless Chromium 153.0.8010.12, Playwright 1.63.0,
real unpacked MV3 installation and native capture/AudioContext/AudioWorklet APIs.
The production optional-only manifest is restored after a disposable host-grant
installation fixture. Only ASR/VAD inference Worker responses are controlled.
Tests inspect isolated-world capture through privileged test-only scripting and
the offscreen target through CDP, without opening a visible runtime tab.

- `npm test`: **932 passed**. Capture gesture timing, secure context/policy and hardware failures,
  delayed native acquisition cleanup, downmix/tail flush, 10,000 acknowledged
  transport cycles, fixed queue bounds, PCM validation/fan-out, authenticated
  coordinator routing, replay/gap/late-owner rejection and existing graph/session
  regressions.
- Full `tests/extension/web-voice.spec.js`: **55 passed**. First-use native capture with Chrome's
  fake permission UI, site-scoped CDP grant/denial and revocation, zero new pages,
  pending acquisition cancellation/navigation, input/textarea/basic editable
  finalized insertion, caret/manual edits/focus/no submit, Stop/Cancel and drain,
  independent Web + Live owners, models/Worker failures, device end/failure,
  field removal, OFF/host-access removal, runtime loss, actual service-worker
  stop/restart, extension reload, returning navigation, graph selection/storage
  recovery and existing mic layout/keyboard behavior. Also real Worklet and native
  fallback PCM integration, a stalled receipt fixture, restrictive Permissions
  Policy and strict CSP/page-world spoof attempts.
- Additional targeted run: **20 passed**, including the updated direct-capture
  timing comparator. Graph concurrency, model-failure and toolbar-launch checks
  exercise unchanged Live capture/model preparation and shared host lifecycle.
- Final targeted checks: **2 passed** for model-failure capture release and
  back-forward navigation with the browser cache enabled.
- `git diff --check` and JavaScript syntax checks.

The delayed-acquisition test wraps a real granted native stream's promise for one
second; headless Chrome dismisses an uncontrolled pending native prompt. CDP site
decisions and fake UI do **not** establish that native permission bubble buttons
were clicked. No physical microphone, specific external site, real ASR inference,
GPU inference or installed-owner manual check is claimed for this change.
`npm run build:extension` stops at its existing missing-local-models prerequisite;
this checkout has no prepared vendor/model bundles. MV3 checks assemble current
sources directly and do not require downloading those unrelated large bundles.

## Transport measurements

The reproducible `page PCM transport measurements` cases record the raw results in
[web-voice-275-transport.json](web-voice-275-transport.json). Each fixture measures
eight seconds with a concurrent Live microphone using the existing capture path
as its baseline. The busy fixture runs 35 ms of page-main-thread work every
100 ms. The baseline uses the original 2048-sample capture worklet and resampler;
a test-only render-clock marker is filtered out before the normal PCM path.

Measurements below are render-clock estimates from chunk emission to runtime
receipt, **excluding** device/ADC delay and the chunk's collection time (up to
80 ms for Web, about 42.7 ms for the existing Live source). Clock mapping and
browser audio scheduling contribute to the estimates. These are local fixture
comparisons, not physical end-to-end speech latency guarantees.

| Measurement | Ordinary | Busy |
| --- | ---: | ---: |
| Web emission → runtime mean / p95 (ms) | 50.60 / 51.78 | 54.19 / 75.60 |
| Direct capture mean / p95 (ms) | 6.63 / 6.86 | 11.40 / 11.47 |
| Web interarrival mean / p95 (ms) | 80.11 / 81.51 | 80.10 / 104.52 |
| Absolute 80 ms cadence jitter mean / p95 (ms) | 1.29 / 1.90 | 9.06 / 26.05 |
| Existing Live interarrival mean / p95 (ms) | 42.67 / 43.09 | 42.67 / 42.77 |
| Emitted / received blocks; peak pending | 103 / 103; 1 | 103 / 103; 1 |
| Sender encoding + send total / per block (ms) | 16.20 / 0.157 | 6.10 / 0.059 |
| Receiver decode + graph delivery total / block (ms) | 51.96 / 0.504 | 21.17 / 0.206 |
| Page task seconds in measured eight seconds | 0.079 | 2.793 |
| Page JS heap before → after (MB) | 3.40 → 4.64 | 3.40 → 4.76 |

The wire payload is 5120 raw bytes / 6828 base64 characters per full block:
12.5 blocks/s, about 85.35 kB/s base64 per hop. Two data deliveries and two receipt
deliveries give 50 audio-protocol Port deliveries/s, plus existing state/heartbeat
traffic. There are at most eight unacknowledged chunks per transport window
(40 KiB raw / about 54 KiB base64), separately bounded in the worklet, content
script and coordinator. The normal fixtures have no sequence gaps, overload or
accepted late chunks; the deliberately stalled acknowledgment case reaches eight
and cancels visibly, closing the track and AudioContext. Node tests independently
reject replay/gaps, old owners and audio after source shutdown.

Sender timing includes base64 construction and the synchronous send; receiver
timing includes base64 decode/validation and graph delivery. These JS elapsed
measurements exclude service-worker/native serialization CPU. Page TaskDuration
and JS heap include fixture/test instrumentation; heap growth is not retained
PCM size or proof of a leak. The unit transport loop and explicit queue bounds
check lifetime-independent storage; these eight-second native captures do not
claim hours-long physical-device validation. Both fixtures must remain below
120 ms p95 receipt delay and below 100 ms additional p95 delay versus direct
capture. The measured fixtures maintain real-time sample throughput and pass
those thresholds. They introduce bounded chunk/relay latency relative to direct
capture; this is not evidence of identical latency on every website or device.
The ScriptProcessor fallback depends on page-main-thread scheduling and can be
less resilient on severely blocked pages.

## Optional owner verification

After merge, the owner may verify native site permission bubbles, physical-device
transcription and external websites. As explicitly approved in #275 this is
non-blocking for implementation review, approval, merge, Issue closure and Project
Done. No manual results or additional blocking verification Issue are requested.
