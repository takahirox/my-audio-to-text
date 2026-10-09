# Issue #75 executable extension graph acceptance

Verified in the assigned worktree on **2026-10-09**, macOS arm64 (Apple M4 Max),
Chrome-for-Testing **153.0.8010.12**. The artifact is the unpacked extension from
`npm run build:extension`; nothing was pushed, published, merged or commented.
No post-merge deployment-only verification is required for this change.

## Automated results

- `npm test`: **202 passed**, no skips. Includes deterministic versioned schema,
  migration/storage errors, exact real Pipeline construction and production port
  identities, final text/chunk adapters and cache-only TTS eviction/no-refetch.
- `npm run test:browser -- --workers=2`: **186 passed, 16 opt-in cases skipped**
  across Chromium/WebKit. Existing page ASR/translation/TTS behavior remains covered.
- `npm run test:extension`: **44 passed, 4 opt-in real-inference cases skipped**.
  The two TTS and two OPUS cases were subsequently run explicitly below. After
  desktop window/wire changes, the affected capture/editor rerun had **23 passed**;
  the final expanded graph fixture run had
  **5 passed**. These additionally verify load cancellation, actual pending
  synthesis cancellation, graceful synthesis drain, cache eviction and invalid
  saved graph rejection before Worker construction.
- `python3 scripts/review-tts-assets.py`: pinned #73 file sizes/LFS hashes passed;
  committed manifests contain 1 MiB chunk hashes for all required files, including
  configurations and both voices. Build packages reviewed runtime/frontend/source
  files and no TTS weights. `git diff --check` passed.

MV3 graph fixtures use actual storage/profile restart, editor, named ports,
Pipeline, production ASR/TTS adapters and Worker entry/protocol code. Their heavy
model/runtime boundaries and tab source are simulated. They establish behavior
and ownership, **not real inference**. Existing translation fixtures likewise
simulate inference; their both-direction cache/pairing/drain/cancel behavior is
covered by the unchanged scheduler tests and MV3 fixture suite.

## Real TTS in the MV3 extension

Command:

```sh
EXTENSION_TTS_SMOKE=all npm run test:extension -- tests/extension/graph-tts-smoke.spec.js --output=.cache/issue-75-tts-results
```

**2 passed**. Both create and visually connect/save the final original text →
concrete TTS → separate audio output graph. ASR and capture are fixture inputs;
TTS Nodes, Workers, inference runtimes, Japanese/English frontends and model
weights are all real. Downloads use the production explicit preparation button,
verified canonical extension-cache keys, unchanged CSP and no host permissions.
Each generates Japanese, English and repeat English with fresh owned Workers.

| Concrete production TTS | Native WAV rate | Japanese duration / RMS | English duration / RMS | Repeat English duration / RMS |
| --- | --- | --- | --- | --- |
| Supertonic3TextToSpeechNode (F1) | 44,100 Hz | 2.856 s / 0.04760 | 2.995 s / 0.04087 | 2.995 s / 0.04856 |
| KokoroTextToSpeechNode (jf_alpha / af_heart) | 24,000 Hz | 2.825 s / 0.09476 | 2.775 s / 0.06831 | 2.775 s / 0.06831 |

All outputs were finite, nonempty, nonzero mono PCM. Native WAV decoding and
player progression passed. Decoder sample counts reflect Web Audio's device
resampling; native WAV header rates above are checked separately. Stop/drain
released every owned Worker and each repeat created fresh Nodes. No remote
request occurred during any Start/inference interval. Preparation traffic was
asset-only GET, without request bodies or input text. No page errors occurred.
Waveform metrics and playback establish executable text-to-audio integration;
this is not a speech-quality or physical-device performance benchmark.

Recorded raw evidence, with query-free asset traffic and timings:
[Supertonic 3](graph-75-tts-supertonic3.json), [Kokoro](graph-75-tts-kokoro.json).

## Real current-tab ASR and both OPUS-MT directions

```sh
python3 scripts/prepare-reazon-ja-en-fixtures.py
EXTENSION_OPUS_SMOKE=1 npm run test:extension -- tests/extension/translation-smoke.spec.js --output=.cache/issue-75-opus-ja-en
EXTENSION_OPUS_SMOKE=en-ja npm run test:extension -- tests/extension/translation-smoke.spec.js --output=.cache/issue-75-opus-en-ja
```

**Both selected real-inference tests passed**; each command skips the opposite
direction. They invoke the real toolbar, obtain the native tabCapture grant,
play verified Japanese/English WAVs and run actual ReazonSpeech/Silero and the
saved OPUS-MT graph. No ASR, translation runtime, inference or capture mocks.
Each completes matching provisional and ordered final original/translated rows,
Stop/drain, worker/capture release, recorder recreation and offline cache repeat.
English → Japanese additionally translates ten representative ordinary-English
inputs (normal and uppercase) through production Nodes and cache-only Workers.
No page errors; all cache preparation completed Ready.

Recorded outputs/fixture hashes/traffic:
[Japanese → English](graph-75-opus-ja-en.json),
[English → Japanese](graph-75-opus-en-ja.json).

## Scope and limitations

The editor intentionally supports one current-tab source, one ASR/original view,
one optional paired translation branch and typed final-text/TTS/audio branches.
It validates that supported layout and all required connections rather than
accepting arbitrary graphs whose output adapters cannot preserve paired rows.
There is no model switch inside processors, generic graph/model SDK or remote
execution. Actual production inference is separate from UI/adapters.

TranslateGemma remains the documented next step allowed by the Issue; its MV3
packaging/WebGPU/asset terms are unverified and it is not selectable. No website
or Web Store deployment occurs. Chrome restart persistence is fixture-tested;
real TTS proves Japanese/English and repeated session execution, with profile
cache reuse/eviction/failure/cancellation separately established in fixtures.
