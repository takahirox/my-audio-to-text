# my-audio-to-text

A local-first speech input system that turns natural speech into useful text and learns to recognize each individual user better over time.

## Motivation and current status

Speech input should work well for the person using it, including their language, vocabulary, pronunciation, and speaking conditions. Corrections should help improve future recognition while keeping the original speech and transcript available.

This repository is a minimal product and vision baseline, ready for a new design from first principles. The previous macOS prototype, experiments, evaluation harnesses, and implementation documents have been removed from the active tree. All previous work remains recoverable from Git history.

There is no application implementation in this baseline. Backward compatibility with the prototype's APIs, storage, configuration, architecture, or platform behavior is not a requirement. Web implementation will begin in separate follow-up issues.

## Web playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

[PR #16](https://github.com/takahirox/my-audio-to-text/pull/16) merged the
[Issue #15](https://github.com/takahirox/my-audio-to-text/issues/15) infrastructure
into `main` on October 2, 2026 (JST). The initial deployment succeeded and the
placeholder is publicly available. [Issue #17](https://github.com/takahirox/my-audio-to-text/issues/17)
remains **partially validated**: actual mobile access and a subsequent reviewed
change appearing after automatic redeployment are still unverified.

The playground currently contains only a static placeholder in `web/index.html`.
The [Pages workflow](.github/workflows/pages.yml) deploys the contents of `web/`
after every push or merge to `main`. It can also be run manually from the Actions
tab with `main` selected. No build step, framework, or ASR backend is required.

For repository setup, select **Settings → Pages → Build and deployment → Source →
GitHub Actions**. Deployment uses the `github-pages` environment and the built-in
`GITHUB_TOKEN`; no additional secret is needed. The deployment's environment URL
in Actions reports the canonical Pages URL.

Live validation recorded on October 2, 2026 (JST; check times below use UTC):

| Issue #17 acceptance check | Result and evidence |
| --- | --- |
| Initial Pages workflow on `main` | **Passed.** [Run 36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434), triggered by `push`, completed successfully at `2026-10-01T15:45:54Z`. Deployed commit: `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`. All deployment job steps succeeded. |
| Canonical public URL over HTTPS | **Passed.** The published URL above returned HTTP **200** with TLS certificate verification successful at `2026-10-01T15:53:40Z`. The response contained `my-audio-to-text` and `The Web playground is deployed.` |
| Published placeholder in a desktop browser | **Passed.** Google Chrome `154.0.8037.58` on macOS, in headless desktop mode with a fresh isolated profile and a 1280 × 800 viewport. The live URL rendered the heading and initial deployment text correctly; the DOM and [screenshot](docs/evidence/pages-desktop-initial.png) were inspected at `2026-10-01T15:55:59Z`. |
| Actual mobile browser | **Pending — requires physical-device evidence.** No device model, browser/version, check time, or rendering result at the canonical published URL has been recorded. This revision environment has no actual mobile-browser access; desktop viewport emulation cannot complete this check. |
| Subsequent reviewed change and automatic redeployment | **Pending — requires review and merge.** [PR #19](https://github.com/takahirox/my-audio-to-text/pull/19) proposes `The Web playground is deployed. Placeholder revision 2.` in `web/index.html`. The revision is not on `main`; its deployed commit, successful automatic Pages run URL, and browser result showing the changed text remain unrecorded. |

Follow-up checks at `2026-10-01T16:12:24Z` confirmed that the canonical URL
still returns HTTPS **200** with successful TLS certificate verification and
serves `The Web playground is deployed.` without the revision 2 text. GitHub
still reports `main` at `d3a600c76c8dc0bb11d91e440073ecec2e227bbb` and only
the initial successful `push` run linked above. PR #19 is open and unmerged;
Issue #17 is open and has no comments supplying the missing mobile evidence.
These checks do not complete either pending acceptance criterion.

Complete Issue #17 in two stages, following the
[partial-work rule](docs/development-flow.md#implement-and-propose-a-pull-request)
and [merge criteria](docs/review-guidelines.md#merge-criteria):

1. Review PR #19 as **intentional partial work**: it records the initial
   deployment and prepares the small placeholder revision needed for the
   subsequent deployment check. Use the [checked-in PR description](docs/evidence/pages-validation-pr.md)
   for publication updates; its issue reference must remain `Related to #17`
   without a closing keyword and identify the two pending live checks. Once this
   partial scope passes review, it can be marked ready and merged into `main` while
   Issue #17 stays open. The checks that require this merge are follow-up work,
   not prerequisites for taking this partial PR out of draft.
2. After that reviewed merge, record the resulting deployed commit SHA and
   successful automatic Pages run URL (`push` event).
3. Reload the same public URL in a browser and confirm the full revision 2 text
   above appears. Pages responses can be cached for ten minutes; recheck after
   cache expiry if the previous text is still served. Record the browser/version,
   check time, and changed text actually seen.
4. Open the published URL on an actual phone or tablet and record the device
   model, browser/version, check time with timezone, and rendered text/result.
   This check can also be recorded before the partial merge; it still requires
   access to the published URL on a real device.
5. Submit a follow-up evidence update to this README for review. Close Issue #17
   only after all five live checks have recorded evidence.

The initial screenshot records the previously published text. Local rendering
of revision 2 does not establish its publication. All five live checks are
required to complete Issue #17; automatic redeployment remains unverified.

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
