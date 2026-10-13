# Translation display and canvas wiring validation (#93)

Validated locally on 2026-10-13 with Playwright 1.63.0.

## Behavior and compatibility

TranslationView adds `provisionalText` and `text` inputs for primitive TEXT.
At least one plain input, or paired `final` with optional paired `provisional`,
is required. Mixed representations are rejected. Plain interim/completed
strings use separate display state without source, IDs, status or index
metadata. Completed messages cannot clear an independent interim stream.
The paired result ports, version 4 persistence and default edges stay intact;
no schema migration or generic Pipeline change is needed.

Canvas wires have focusable selection controls, a visible selected stroke and
Delete/Backspace removal. Their hit strokes remain 16 screen pixels wide at
supported zoom levels. Connections list buttons remain keyboard accessible.
Click/drop reconnection replaces only the occupied input after validation;
identical connections are no-ops, fan-out survives, and invalid candidates
preserve the old edge.

## Automated coverage

- Unit checks cover both OPUS directions with completed-only, interim-only and
  combined plain inputs; separate stream state; repeat/cleanup; paired status
  behavior; unchanged saved version 4 descriptions; default graphs; empty/mixed
  mode rejection; and strict single-incoming-edge/type/cycle/required-input
  validation before runtime construction.
- Packaged MV3 checks exercise actual canvas hit targets at 50%, 100% and 150%
  zoom, precise Delete/Backspace removal without moving/removing Nodes,
  keyboard Connections removal, click/drag replacement, fan-out, repeated
  connections and invalid drops. Both translation directions render primitive
  interim/completed text without paired rows or fabricated status attributes.
  Saved paired mode renders pending, complete, error and canceled states.
- These new translation integration checks use production schedulers,
  graph/session/display code and fixture inference Workers under extension CSP.
  They establish composition/display behavior, not real-model accuracy.

## Commands and results

- `npm ci`: passed.
- `npm run prepare:assets`, `npm run prepare:translation-assets`,
  `npm run prepare:tts-assets`: passed with the existing pinned preparation scripts.
- `npm run build:extension`: passed.
- `npm test`: 264 passed, none skipped.
- `npm run test:browser -- --workers=2`: 218 passed, 18 opt-in checks skipped.
- `npm run test:extension`: 94 passed, 5 opt-in real-model checks skipped.

Opt-in real ASR/OPUS/TTS/correction inference and benchmarking were not run.
The extension's five opt-in checks cover real ASR field output, both real OPUS
directions and both real TTS models. Shared browser skips cover the corresponding
real-model and ASR fixture/benchmark checks. No post-merge verification is
required by this issue.
