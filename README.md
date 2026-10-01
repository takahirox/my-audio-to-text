# my-audio-to-text

A local-first speech input system that turns natural speech into useful text and learns to recognize each individual user better over time.

## Motivation and current status

Speech input should work well for the person using it, including their language, vocabulary, pronunciation, and speaking conditions. Corrections should help improve future recognition while keeping the original speech and transcript available.

This repository is a minimal product and vision baseline, ready for a new design from first principles. The previous macOS prototype, experiments, evaluation harnesses, and implementation documents have been removed from the active tree. All previous work remains recoverable from Git history.

There is no application implementation in this baseline. Backward compatibility with the prototype's APIs, storage, configuration, architecture, or platform behavior is not a requirement. Web implementation will begin in separate follow-up issues.

## Vision

Build a speech input system that:

1. Turns natural speech into useful text.
2. Becomes better at recognizing the individual user over time.
3. Preserves source audio and original transcripts separately from derived or corrected output; derived output never overwrites its source.
4. Can eventually work across Web, desktop, and mobile, without being tied to macOS.

## Near-term priorities

### 1. Speech-to-Text

- Realtime, low-latency recognition.
- Good Japanese recognition.
- Usable from mobile and desktop browsers.

### 2. Personalized ASR

Personalized automatic speech recognition (ASR) should:

- Learn from user corrections.
- Improve recognition of personal vocabulary, pronunciation, recurring mistakes, and quiet speech, eventually extending to whisper speech.
- Demonstrate improvement on held-out real audio that was not used for personalization.

## Deferred priority

**Speech → Thought / synthesis** remains part of the broader vision. It comes after robust Web Speech-to-Text and Personalized ASR, rather than being the next implementation priority.

## Design principles

- Local-first where practical.
- Web-first for the next development cycle, with a path to desktop and mobile beyond the Web.
- Keep models and runtimes replaceable; the vision does not depend on Whisper, llama.cpp, Swift, or any specific model or runtime.
- Measure accuracy, latency, memory, CPU/GPU usage, battery impact, and personalization learning curves.
- Prefer a small, understandable baseline over historical implementation complexity.

## Follow-up work

Separate issues should define and implement:

- Web/PWA foundation.
- GitHub Pages automatic deployment.
- Browser microphone and audio pipeline.
- Web ASR technology evaluation, including sherpa-onnx/WASM and alternatives.
- Personalized ASR data and feedback loop.
- Cross-platform product contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.

## Pages publication validation

Canonical public URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).
Publication and automatic redeployment are **unverified**. This is a partial
validation record for [Issue #17](https://github.com/takahirox/my-audio-to-text/issues/17),
which remains incomplete until all five live checks pass.

Review follow-up checks on October 2, 2026 (JST) confirmed that the prerequisite
[PR #16](https://github.com/takahirox/my-audio-to-text/pull/16) is still an open,
unmerged draft. Its inspected head is
`6d442b917ac72800bf65966bdb841995c1ed69a8`; it proposes
`.github/workflows/pages.yml` and the static placeholder in `web/index.html`.
Neither file is present on the inspected `main` commit,
`271e7f9b16d3865d8914767954a9d590831a80f4`.
GitHub's Pages API reports `build_type: workflow`, `https_enforced: true`,
and the canonical URL above. These settings alone do not establish publication.

| Required live check | Observed result / outstanding evidence |
| --- | --- |
| Pages workflow succeeds on `main` | Blocked by PR #16. The Actions runs API returned zero runs for `main`, and the workflows API listed only `CI`, with no Pages workflow. No successful run URL or deployed commit SHA is available. |
| Canonical URL returns HTTP 200 over HTTPS | Failed again: an HTTPS GET returned **HTTP 404** at **2026-10-01T15:39:12Z** (October 2, 00:39:12 JST). TLS certificate verification succeeded; the URL did not redirect. |
| Published placeholder renders in a desktop browser | Unverified. The Chrome DevTools connector again could not connect because Chrome's DevTools port was unavailable. No successful desktop rendering is claimed. |
| Same URL renders in an actual mobile browser | Unverified. No physical mobile device/browser result is available. Viewport emulation does not satisfy this check. |
| Subsequent reviewed change automatically redeploys and appears at the same URL | Blocked by the initial publication. No subsequent reviewed/merged commit, deployment run URL, changed text, or browser result is available. |

[PR #19](https://github.com/takahirox/my-audio-to-text/pull/19) tracks this partial
validation record and must remain a draft until all five live checks have
recorded evidence. The live acceptance findings remain unresolved; this
documentation update does not establish successful publication or redeployment.

Continue validation after PR #16 is reviewed and merged:

1. Inspect the Pages run triggered on `main`. If it fails, inspect the failed
   job and correct the deployment failure. If necessary, manually dispatch the
   existing `pages.yml` workflow with `main` selected. Record the successful run
   URL and deployed commit SHA.
2. Repeat the HTTPS GET to the canonical URL and record HTTP 200 with the check
   time. Open that URL in a desktop browser and record its name/version and the
   visible placeholder text: `The Web playground is deployed.`
3. Open the same URL on a physical mobile device. Record the device, browser,
   check time, and rendered text.
4. Make a small plain HTML text change in `web/index.html`, have it reviewed
   and merged into `main`, and inspect the automatic deployment triggered by
   that merge. Record the subsequent commit SHA, successful run URL, exact
   changed text, and the browser result showing it at the same canonical URL.
5. Update this validation record and the README publication status with the
   observed evidence. Keep Issue #17 open until all five live checks pass.
