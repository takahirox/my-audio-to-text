# Pages redeployment evidence for Issue #17

PR [#19](https://github.com/takahirox/my-audio-to-text/pull/19) was reviewed as intentional partial work and merged at `2026-10-01T21:54:25Z`. The review checked scope, whitespace, relative documentation links, the placeholder text, and historical evidence. Issue #17 stayed open because actual mobile-browser evidence was still missing.

- Deployed merge commit: `28f0badabb1834a1a8fe15dc248aaeebbb393412`.
- Automatic workflow: [run 36931736950](https://github.com/takahirox/my-audio-to-text/actions/runs/36931736950), event `push`, conclusion `success`, branch `main`.
- Canonical URL: https://takahirox.github.io/my-audio-to-text/.
- HTTPS check: HTTP 200 with normal TLS certificate verification at `2026-10-01T21:57:19.419968+00:00`.
- Desktop rendering: `Chrome/154.0.8037.58` on macOS, isolated headless desktop profile, viewport `1280x800`, checked at `2026-10-01T21:57:19.297Z`.
- Visible heading: `my-audio-to-text`.
- Visible changed text: `The Web playground is deployed. Placeholder revision 2.`.
- The DOM and [screenshot](pages-revision2.png) were inspected. No JavaScript exceptions were recorded.

This automatic deployment restored the static placeholder after the earlier manual ASR-branch deployment. That earlier branch deployment remains historical evidence; it does not replace the reviewed-main automatic redeployment check.

## Actual mobile browser

The user opened the canonical published URL on a physical **Pixel 7a** with **Chrome** and confirmed these displayed strings:

- `my-audio-to-text`
- `The Web playground is deployed. Placeholder revision 2.`

Report recorded at `2026-10-01T22:01:26.247000+00:00` (UTC; October 2, 2026 JST). The browser version and exact device-check timestamp were not supplied. This is user-reported physical-device evidence, separate from the automated headless desktop check; no mobile emulation is claimed.

Together with the initial deployment and desktop evidence linked from the README, all five Issue #17 acceptance checks now have evidence.
