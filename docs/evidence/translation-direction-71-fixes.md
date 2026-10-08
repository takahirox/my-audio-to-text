# Issue #71 review fixes

Validation on **2026-10-08**, macOS, Chrome-for-Testing **153.0.8010.12**.
This report supersedes the original English → Japanese evidence. The rejected
Bible-domain checkpoint and its Japanese-character-only assertions are not
acceptance evidence for this revision.

## Model and inference correction

The separate production `EnglishToJapaneseOpusMtTranslationNode` and its Worker
now use **`Kadonox/opus-tatoeba-en-ja-onnx`** at immutable revision
`225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e`, `q8`, single-thread WASM.
The Japanese → English model and Worker are unchanged.

- [Pinned conversion card](https://huggingface.co/Kadonox/opus-tatoeba-en-ja-onnx/blob/225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e/README.md)
  identifies the Optimum ONNX export of Helsinki-NLP's OPUS Tatoeba model and
  Transformers.js compatibility; declares Apache 2.0.
- [Pinned base card](https://huggingface.co/Helsinki-NLP/opus-tatoeba-en-ja/blob/3a282648cb991174f3c423e376aff3a13e5edaaf/README.md)
  declares English (`eng`) → Japanese (`jpn`), OPUS+backtranslation training,
  Tatoeba evaluation and Apache 2.0. Public delivery is ungated and anonymous.
  Attribution, Apache terms and distribution notices are retained in the product
  and guides. No model weights are bundled or committed.
- Before selection, the candidate's seven assets were downloaded to `.cache`,
  checked against immutable Hugging Face metadata sizes and LFS SHA-256s, and
  tested in an isolated real browser with this project's unchanged pinned
  Transformers.js 4.0.0-next.3 / ONNX Runtime Web
  1.25.0-dev.20260212-1a71a5f46e. Greeting, meeting time, report, station and
  project-deadline examples preserved their meanings.
- The independent manifest records sizes, whole-file SHA-256s and every 1 MiB
  chunk hash: **252,634,769 bytes** (about 253 MB). The new model ID/revision
  produces different immutable cache keys; old en-jap bytes cannot satisfy it.
  `python3 scripts/review-opus-mt-en-ja-assets.py` passed all metadata/byte/hash
  checks. Cache preparation remains explicit and only downloads the selection.
- Real extension inference exposed the checkpoint's sensitivity to uppercase
  ASR text. The English → Japanese Worker now recases wholly uppercase Latin
  input to sentence case, restoring the pronoun I and weekday names. Mixed-case
  input and the visible/copyable original remain intact. The token limit is
  checked against the actual prepared input. This adds no language detection,
  model selector, runtime change or server inference.

## Meaning-based real inference

[Production-page evidence](translation-direction-71-fixes-browser.json) records
**20** real translations: five ordinary sentences, each in normal and uppercase
ASR forms, on two fresh Workers. Semantic assertions check these meanings:

| Source | Normal and uppercase output |
| --- | --- |
| Hello. | こんにちは |
| The meeting starts at ten. | 集会は10時から開始する. |
| Please send me the report. | 報告書を寄越して |
| Where is the train station? | 駅はどこだ? |
| We need to finish this project by Friday. | 金曜までにこのプロジェクトを完了しなければならない. |

The meeting checks require a meeting, ten, and starting; the other sentences
similarly require their key meaning. The review's unrelated greeting/meeting
outputs cannot pass these assertions. Requests were GET asset delivery only,
with immutable model URLs and no input in URLs/bodies. No runtime/model mocks.

The [extension evidence](translation-direction-71-fixes-extension.json) uses the
[committed synthetic speech fixture](../../tests/fixtures/ordinary-english.md),
played through a real tab and native tab capture. Production ReazonSpeech emits
uppercase English, then the production Node/Worker translates provisional and
ordered paired final outputs. Actual final rows must preserve the meeting time,
report request and project deadline. The same five normal/uppercase typed-text
meanings are additionally checked through a production Pipeline and extension
cache-only Node, both online and after recreating the recorder offline.
Synthetic speech is identified as such; this is real ASR/translation inference,
not a human recording, human evaluation, or model-runtime mock.

Investigation also tested the previous long technical upstream ASR fixture.
The new checkpoint still makes omissions/artifacts on some malformed technical
transcripts; case preparation improves it but does not guarantee every sentence.
An earlier concurrent browser run crashed during offline window recreation;
that failed attempt is not reported as passing. The committed ordinary-speech
fixture makes the acceptance test reproducible and checks the requested behavior
through the full capture/ASR/translation path. Incomplete ASR partial words can
still yield incomplete translations; the source always remains visible.

## Checks

- `npm test`: **163 passed**.
- `npm run test:browser -- tests/browser/translation.spec.js --workers=2`:
  **36 passed**, Chromium and WebKit, after the case preparation change.
  Includes both owned Workers, preserved input, recased inference input,
  repository-prefix navigation, token limit, cancellation/errors and repeats.
- `npm run test:extension`: **40 passed, 2 opt-in smokes skipped** after the
  checkpoint replacement. After the Worker case preparation change,
  `npm run test:extension -- tests/extension/translation.spec.js`: **13 passed**,
  both-direction scheduling, cache-only loading, failures/cancellation,
  preferences, retained labels, offline/profile reuse and transcription-only use.
  These suites use deterministic model fixtures, not real translation.
- `TRANSLATION_SMOKE=opus-en-ja npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1`:
  **1 real smoke passed**, 2 unselected-model smokes skipped; **20** meaning-based
  translations through the real production page/Node/Worker, with no mocks.
- `EXTENSION_OPUS_SMOKE=en-ja npm run test:extension -- tests/extension/translation-smoke.spec.js`:
  **1 real smoke passed**, the unselected Japanese smoke skipped. Both online and
  recreated-window offline runs passed. Each includes three meaningful native
  capture/ASR final pairs, a completed provisional translation, and **10**
  normal/uppercase ordinary-text translations through the production cache-only
  Pipeline. No remote requests during inference or offline repeat.
- `python3 scripts/review-opus-mt-en-ja-assets.py`: all seven immutable asset
  metadata/size/whole-file/chunk checks passed.
- `npm run build:extension` and `git diff --check`: passed.

The existing Japanese → English real smoke was not rerun; its model, Worker and
runtime are unchanged. Both-direction unit and deterministic browser/MV3
regression tests passed; prior Japanese real-model evidence remains historical.

## PR and post-merge state

PR #72 uses **Refs #71**, with no closing keyword or reopen-after-merge workaround.
This fix node does not push or merge. Required Pages verification remains
**pending**: after merge, record the successful Pages run URL, merged/deployed
SHA, UTC time, canonical repository-prefixed new page/index link and valid
script/Worker/runtime/model URLs. Keep Issue #71 open until it is recorded.

### PR closure correction readback

At **2026-10-08T10:42:32.772270+00:00**, PR #72's live description was changed to `Refs #71`
and verified to match [the publication artifact](translation-direction-71-pr-description.json)
exactly. GitHub returned an empty `closingIssuesReferences` list. PR #72 was open
and unmerged; Issue #71 was open; the published head remained
`18a9ee1dc0024ec089f7214bf5149e3f9c154db1`. The artifact now instructs publication
to preserve this non-closing reference while Pages verification is pending.

Local JSON/body/template checks and `git diff --check` passed. Runtime and
real-model tests were not rerun for this metadata-only fix; the implementation
and inference evidence above are unchanged. No push, merge or post-merge
verification was performed.
