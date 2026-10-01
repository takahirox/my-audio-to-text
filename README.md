# my-audio-to-text

A local-first speech input system that turns natural speech into useful text and learns to recognize each individual user better over time.

## Motivation and current status

Speech input should work well for the person using it, including their language, vocabulary, pronunciation, and speaking conditions. Corrections should help improve future recognition while keeping the original speech and transcript available.

This repository is a minimal product and vision baseline, ready for a new design from first principles. The previous macOS prototype, experiments, evaluation harnesses, and implementation documents have been removed from the active tree. All previous work remains recoverable from Git history.

There is no application implementation in this baseline. Backward compatibility with the prototype's APIs, storage, configuration, architecture, or platform behavior is not a requirement. Web implementation will begin in separate follow-up issues.

## Web playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

[PR #16](https://github.com/takahirox/my-audio-to-text/pull/16) supplied the Pages infrastructure. The initial deployment succeeded on `main`. After a temporary manual deployment of the ASR branch, reviewed [PR #19](https://github.com/takahirox/my-audio-to-text/pull/19) merged the small placeholder revision and its automatic deployment restored the static page.

The public page now shows `The Web playground is deployed. Placeholder revision 2.` as verified on October 2, 2026 (JST). [Issue #17](https://github.com/takahirox/my-audio-to-text/issues/17) has evidence for **all five acceptance checks**, including the user’s physical-device confirmation on Pixel 7a with Chrome.

The repository contains a static placeholder in `web/index.html`. The [Pages workflow](.github/workflows/pages.yml) deploys `web/` after every push or merge to `main`; it can also be dispatched with `main` selected. There is no build step, framework, or ASR backend in this baseline.

For repository setup, select **Settings → Pages → Build and deployment → Source → GitHub Actions**. Deployment uses the `github-pages` environment and built-in `GITHUB_TOKEN`; no additional secret is needed. Actions reports the canonical Pages URL.

Validation evidence recorded on October 2, 2026 (JST; evidence timestamps use UTC):

| Issue #17 acceptance check | Result and evidence |
| --- | --- |
| Initial Pages workflow on `main` | **Passed.** [Run 36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434), event `push`, succeeded at `2026-10-01T15:45:54Z` for commit `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`. |
| Canonical public URL over HTTPS | **Passed.** HTTP 200 with normal TLS certificate verification. The initial check was at `2026-10-01T15:53:40Z`; [post-merge evidence](docs/evidence/pages-redeployment.md) confirms revision 2 at the same URL. |
| Published placeholder in a desktop browser | **Passed.** Chrome `154.0.8037.58` on macOS rendered the initial page at `2026-10-01T15:55:59Z` ([historical screenshot](docs/evidence/pages-desktop-initial.png)). A fresh isolated headless desktop check also rendered revision 2 ([evidence and screenshot](docs/evidence/pages-redeployment.md)). Neither check claims physical-mobile validation. |
| Actual mobile browser | **Passed — user-reported physical-device check.** Pixel 7a with Chrome rendered `my-audio-to-text` and `The Web playground is deployed. Placeholder revision 2.` at the canonical URL. The report was recorded at `2026-10-01T22:01:26.247000+00:00` (UTC; October 2, 2026 JST). Browser version was not supplied. See [mobile evidence](docs/evidence/pages-redeployment.md#actual-mobile-browser). |
| Subsequent reviewed change and automatic redeployment | **Passed.** PR #19 merged as `28f0badabb1834a1a8fe15dc248aaeebbb393412`. Automatic [push run 36931736950](https://github.com/takahirox/my-audio-to-text/actions/runs/36931736950) succeeded. The canonical URL rendered `The Web playground is deployed. Placeholder revision 2.`; see [the recorded browser check](docs/evidence/pages-redeployment.md). |

The [original PR description](docs/evidence/pages-validation-pr.md) preserves historical checks and the earlier manual [ASR deployment](https://github.com/takahirox/my-audio-to-text/actions/runs/36894283644). Its pending statements describe the pre-merge state; the table above and [redeployment evidence](docs/evidence/pages-redeployment.md) record the subsequent reviewed-main result.

All five checks now have recorded evidence. The physical-device result was supplied by the user; the automated headless desktop check does not substitute for it. This documentation update completes the evidence required by Issue #17 and follows the [development flow](docs/development-flow.md) and [merge criteria](docs/review-guidelines.md#merge-criteria).

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
- Browser microphone and audio pipeline.
- Web ASR technology evaluation, including sherpa-onnx/WASM and alternatives.
- Personalized ASR data and feedback loop.
- Cross-platform product contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.
