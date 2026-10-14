# Minimal default graph and stable Live append rendering (#101)

Local verification on 2026-10-14, macOS, Node v24.12.0, Playwright 1.63.0,
Chromium 153.0.8010.12 and WebKit 26.6. The extension was built in the assigned
worktree with the repository's pinned ASR, translation and TTS assets.

## Append investigation

No committed-item state loss was observed in the deterministic unit, browser or
packaged MV3 cases. Every append adds a distinct item, including consecutive
identical strings and empty strings. Replace changes only the preview; it does
not mutate committed items. Whitespace and HTML-looking strings remain verbatim.

The original renderer from upstream checkpoint `bc832d8` was also exercised in
Chromium with committed items `['committed', 'committed', '']` and a selected
committed text node. A subsequent preview update left the committed text exactly
unchanged, but replaced all three `<li>` nodes and changed the selected text from
`'committed'` to `''`. This reproduces DOM/selection instability, not state loss.
The incremental renderer preserves the unchanged committed prefix and only
creates appended items; shorter/replaced histories remove stale tails. It also
avoids moving regions that are already in the correct order.

Packaged tests verify unchanged committed DOM identities, selection and reader
scroll position across repeated preview updates and appends. They independently
check replacement/truncation/reset, absent display state, sink removal/recreation,
region ordering, safe text, active versus saved labels/routes, Stop/Cancel and
fresh sessions. Start intentionally clears history; Stop/Cancel retain committed
items and never promote the mixed display's preview to a duplicate item.

Two upstream behaviors remain distinct from append rendering: SpeechToText
suppresses duplicate/stale final IDs before fan-out (tested in MV3), while
identical finals without IDs are independent emissions. PairedTextFormatter
intentionally emits whole-history replacements into a replace-only display;
that is a producer-chosen current value, not a replacement of appended history.
The tested paths establish sink/runtime/UI behavior, not all possible real-model
emissions or speech-recognition accuracy.

## Defaults and compatibility

Fresh setup and explicit Reset use exactly ChromeTabAudio, SpeechToText and one
LiveTextDisplay labeled Text, with the three audio/provisional/final named-port
edges required by the Issue. Reset remains draft-only until Save. Both OPUS-MT
Nodes remain in the palette. A packaged test manually adds English-to-Japanese
translation and a generic display, connects named ports, and runs repeated finals.

Current custom/translation graphs reload without rewriting their stored JSON,
including conflicting old preferences. Versions 1–5 retain their existing
explicit migrations and translation routes/settings. Without a saved graph,
only a legacy boolean `enabled: true` creates a translation configuration;
missing/corrupt preferences use the minimal default. Unit checks cover both
legacy directions and choices. Chrome reload/profile-restart checks retain
custom labels, user-chosen edges and translation Nodes.

## Checks

| Command | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run prepare:assets` | Passed |
| `npm run prepare:translation-assets` | Passed |
| `npm run prepare:tts-assets` | Passed |
| `npm run build:extension` | Passed |
| `npm test` | 273 passed, no skips |
| `npm run test:browser -- --workers=2 --output=test-results/browser` | 221 passed, 1 WebKit cleanup timeout failure, 18 optional skips; isolated retry passed |
| `npm run test:browser -- tests/browser/tab-audio.spec.js --project=webkit --workers=1 --grep 'switch during the tab picker' --output=test-results/browser-retry` | 1 passed |
| `npm run test:extension -- --output=test-results/extension-final` | 113 passed, 5 optional real-model checks skipped |
| `git diff --check` | Passed |

The browser run's WebKit tab-picker test timed out waiting for an AudioContext
to close; its isolated rerun passed. Both Chromium and WebKit shared display
state tests passed in the full run. The initial MV3 run exposed a missing
English-to-Japanese Worker stub in the newly added palette test; after supplying
the same fixture for both translation directions, that test passed in isolation.
The final complete MV3 rerun passed with this corrected fixture.

## Optional checks and limits

The 18 browser skips are opt-in real correction, Silero/ASR, bilingual ASR,
thread benchmark, OPUS-MT/TranslateGemma and TTS checks across both engines.
The five packaged skips are real Supertonic3/Kokoro, real ASR-to-focused-field,
and real ASR/OPUS-MT in both directions. Their flags were not enabled and their
real inference was not run. Graph fixtures simulate inference while using the
packaged graph, Pipeline, UI and MV3 CSP; existing capture/target/playback tests
exercise native browser APIs. No physical-device or external-site checks were
performed. No post-merge verification, push or publication is required here.
