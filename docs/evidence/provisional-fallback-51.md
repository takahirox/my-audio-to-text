# Empty-final provisional fallback (#51)

Validated locally on October 6, 2026 for
[Issue #51](https://github.com/takahirox/my-audio-to-text/issues/51).

`LocalAsrCore` retains the latest nonempty accepted provisional text by utterance
ID within the current session. It emits that text as `final` only when the fresh
final decode is empty or whitespace-only. Nonempty finals remain unchanged.
Blank provisional updates keep their existing display semantics and do not erase
usable fallback text. State clears after a final, after Stop drains, on Start,
and on release/error. Existing session, worker, ID and decode-stage checks run
before fallback state is accessed.

| Verification | Result |
| --- | --- |
| Regression reproduction before the core change | Four new unit cases failed for empty/whitespace finals, Stop fallback, and stale-preview isolation. |
| `npm ci` | Passed. |
| `npm test` | 52 passed, no failures or skips. |
| `npm run test:browser -- --workers=2` | 88 passed in Chromium/WebKit; six opt-in real-model/benchmark tests skipped. |
| `git diff --check` | Passed. |

New unit cases cover final precedence (including unchanged surrounding
whitespace), latest nonempty updates, blank updates, no usable provisional,
utterance and session isolation, Stop suppression/draining, release during
recognition or Stop, stale worker callbacks, ASR/VAD errors, worker exceptions,
and invalid input. Browser cases cover silence and Stop endpoints through the
actual worker paths, committed fallback rendering, provisional clearing, and
repeat sessions without usable text. Tab cases verify both worklet and
ScriptProcessor capture with nonempty and blank final decodes. Existing capture,
resampling, configuration and utterance-policy tests pass.

The deterministic fixtures validate lifecycle and transcript selection; they do
not measure real-model accuracy or automate the native sharing picker. The model,
VAD, timing, configuration, source implementation and DOM rendering are unchanged.
No post-merge verification is required by Issue #51.
