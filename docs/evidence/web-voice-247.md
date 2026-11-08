# Web voice typing #247 validation

Implementation uses the existing TabSession/prepared graph runtime in a compact
extension-owned recording window. The service worker coordinates opt-in,
permission-gated top-frame injection and one document-bound session. The Content
Script owns only the isolated field control, saved selection and insertion bridge.
No full Live UI or inference runs in the page. The runtime graph is a snapshot of
the assigned field-output ancestors; other sinks are inactive. See
[workflow, supported graphs and limitations](../chrome-extension.md#opt-in-web-voice-typing-247).

Validation performed in this worktree:

- `npm test`: 863 passed, including preference validation, typed executable graph
  connectivity, all existing ASRs and compatible intermediate processors.
- `npm run build:extension`: passed with verified pinned packaged assets.
- Affected installed-extension suite: Graph Library, prepared Live lifecycle,
  existing toolbar targets and `web-voice.spec.js`: 43 passed (56.9 seconds).
- `WEB_VOICE_REAL=1 npx playwright test --config playwright.extension.config.js tests/extension/web-voice.spec.js -g 'native input'`:
  passed with actual packaged ReazonSpeech/Silero, native getUserMedia and a fake
  microphone carrying the pinned English speech fixture. Three final utterances
  per native input/textarea, exactly-once final-event/text equality, correct saved
  caret, manual submit untouched, graceful Stop and no remote requests or page
  errors. [Machine-readable evidence](web-voice-247-real.json).
- `git diff --check`: passed.

The affected browser tests include OFF with a pre-existing assignment, fresh
installation without hosts or scripts, controlled host-denial decision, cross-page
preference sync, sensitive fields, input/textarea/basic contenteditable selection,
manual editing, final drain, no submit, replay suppression, wrong-sender rejection,
multi-tab busy state, fixed output target after focus/graph changes, Live resource
ownership, cancellation during preparation, missing verified model cache, Worker
failure, field removal, navigation, native host-permission removal, controlled
microphone-ended event, OFF and actual extension reload. Regular inference replies
are controlled Workers; the separate real-model run is not mocked inference.

Limitations of this evidence:

- Playwright/CDP cannot click Chrome's native optional-host permission bubble.
  Main tests seed a native host grant using a disposable installation/upgrade
  fixture, then restore and reload the production optional-only manifest before
  exercising the feature. They do not modify the production manifest or bypass
  Chrome injection enforcement. The fresh-install denial test controls only the
  Library's permission decision and verifies no Chrome host grant or injection.
- Native microphone grant/denial is set through Browser.setPermission. Physical
  microphone hardware and native host/microphone permission-bubble button clicks
  were not exercised. Manual instructions are in the feature documentation; no
  manual permission-prompt result is claimed.
- Rich editors, Shadow DOM, frames and universal native undo integration are not
  supported. Automated basic contenteditable coverage is not a claim of universal
  website compatibility. Actual microphone-setting revocation and GPU-device loss
  are not established by controlled device/Worker failure checks.
- No push, PR, merge, Issue comment, deployment or post-merge verification was
  performed. No usage allowance/reset/model switch was used.

Under the [current Issue completion scope](https://github.com/takahirox/my-audio-to-text/issues/247),
manual permission prompts, real microphone trials and settings revocation checks
are optional later notes. They are not acceptance criteria or required post-merge
verification and do not block review, merge, Issue closure or Project Done. No
manual result is claimed; the recorded automated evidence above is unchanged.
