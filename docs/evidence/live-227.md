# Simplified Live surface — Issue #227

Live now contains Start/Stop, graph-defined actions, Display input tabs, generated
audio controls and actionable errors. The target disclosure, target rows,
discovery/select controls, target status surface, TargetControls module and
selected-media target state are removed. Automatic same-tab focused-output
preparation belongs to TabSession; microphone permission still comes from Start.

Routine Node messages, including unknown future messages, are diagnostics by
default. Summary, condition, speech, TTS, translation, Hold, output and speaker
statuses live inside the closed-by-default Session details disclosure, without
live-region roles. The overall session pill and explicit permission/activation
instructions remain in the recording controls. Graph-action disabled reasons
remain available as accessible button descriptions and in diagnostics.

The error boundary accepts explicit `type: error` or `severity: error` events,
including Pipeline failures. Translation, prepared TTS, focused output and speaker
adapters preserve error metadata instead of classifying English strings. There
is one main alert, with one error per Node. Processor events retain useful
recovery instructions without duplicating Pipeline errors. Errors reset at a
fresh Start; callbacks from old sessions remain guarded. Models recovery uses
model-bearing Node metadata, with no message matching.

SelectedPageMediaAudio reports its temporary unavailability and suggests
ChromeTabAudio in Graph Editor. It cannot select/capture any element or silently
fall back to tab audio. The limitation is reported before dependent models load,
and the source fails through the existing Pipeline lifecycle. Independent
complete paths continue. A failed source does not prevent automatic Stop when
healthy capture sources end. Graph topology/storage are preserved. Selection on
the target Web page is explicitly deferred to a separate task.

## Layout evidence

- [Desktop MV3, 1440 × 1000](live-227-mv3-1440x1000.png)
- [Narrow MV3, 390 × 844](live-227-mv3-390x844.png)

Both screenshots were visually inspected. Automated layout checks also cover
800 × 844 and 390 × 520, equal Start/Stop columns, at least 44px controls,
no horizontal overflow, keyboard/touch Display tabs, independent scrolling,
copy-free reading content, graph actions and error rendering. The Button named
Cancel in these fixtures is user-defined and remains an ordinary graph action.

## Executed validation

Installed dependencies with `npm ci` and the pinned browsers with
`npx playwright install chromium webkit`. The initial MV3 attempt could not launch
before browser installation; subsequent executions used those installed browsers.

| Command / suite | Result |
| --- | --- |
| `npm test` | **788 passed** in the final run, including explicit severity vs ordinary/unknown events, multi-Node errors, deduplication, restart reset, selected-media failure/independent paths and ended-source cleanup |
| `npx playwright test tests/browser/live-ui.spec.js tests/browser/display-tabs.spec.js tests/browser/live-scroll.spec.js tests/browser/display-items.spec.js --workers=2` | **18 passed**, Chromium and WebKit |
| `npx playwright test --config playwright.extension.config.js tests/extension/live-ui.spec.js tests/extension/simple-layout.spec.js tests/extension/graph-model-failures.spec.js tests/extension/graph-actions.spec.js tests/extension/graph.spec.js tests/extension/graph-speaker.spec.js --grep-invert 'real pinned'` | Initial run: **27 passed, 1 failed** (stale expectation for a removed Display heading) |
| `npx playwright test --config playwright.extension.config.js tests/extension/live-ui.spec.js tests/extension/graph.spec.js tests/extension/graph-speaker.spec.js --output=test-results/live-227` | **15 passed**, including the corrected accessible Display-region assertion, TTS errors, speaker errors and layout screenshots |
| `npx playwright test --config playwright.extension.config.js tests/extension/targets.spec.js tests/extension/extension.spec.js tests/extension/graph-concurrent.spec.js tests/extension/graph-if-condition.spec.js tests/extension/simple-layout.spec.js tests/extension/translation.spec.js tests/extension/streaming-tts.spec.js --grep-invert 'real pinned\|completed translations flow directly\|toolbar-focused TEXT'` | **67 passed, 9 failed** before the affected assertions were updated |
| `npx playwright test --config playwright.extension.config.js tests/extension/graph-if-condition.spec.js tests/extension/translation.spec.js tests/extension/targets.spec.js --grep 'stops only the condition\|missing cache never\|network, quota\|utterance limit\|toolbar automatically\|completed translations flow directly' --output=test-results/live-227-errors` | **9 passed, 1 failed**; all nine prior failures passed. The additional translation/focused-output case exposed an obsolete separate Display selector |
| `npx playwright test --config playwright.extension.config.js tests/extension/targets.spec.js tests/extension/simple-layout.spec.js --grep 'selected media\|completed translations flow directly\|Live keeps all\|Live explains' --output=test-results/live-227-selected` | **4 passed**, including the corrected paired Display assertion, selected-media limitation and ordinary-vs-error/restart UI checks after the final session change |
| Syntax checks for changed JavaScript; `git diff --check` | Passed |
| `npm run build:extension` | Blocked: **Missing local models. Run npm run prepare:assets first.** |

Across these executions, **100 distinct MV3 cases passed**, excluding duplicate
runs. No observed test failure remains unresolved. Updated assertions now expect
condition/translation errors in the main alert; older tests had explicitly
expected that alert to remain empty. Existing stale heading/newline/separate
translated-Display assertions now follow current Display region and paired-text
contracts without changing production graph or text semantics.

MV3 coverage includes native toolbar/tab capture, real worklet/fallback audio,
microphone permission denial/retry and track cleanup, focused-field automatic
authorization and exact insertion, independent tab/microphone branches,
Stop/pagehide/navigation/close, held-model cancellation, optional model failures,
translation errors in both directions, TTS and speaker recovery, streaming
transport and stale-session suppression.

This worktree has no prepared heavyweight models/runtimes. Controlled MV3 tests
used production extension sources/manifest, the builder-listed shared Web modules
and licenses staged in `dist/chrome-extension`; existing fixtures supplied small
assets and controlled workers/runtimes. These checks establish UI, Chrome APIs,
routing and lifecycle behavior, not real model inference or a complete production
asset build. Real-model smoke tests and a fully prepared production build were
not performed. No post-merge publication verification applies to this local
extension UI change. Nothing was pushed, published or commented on GitHub.

Manual reproduction steps are in
[the extension guide](../chrome-extension.md#simplified-live-checks-227).
