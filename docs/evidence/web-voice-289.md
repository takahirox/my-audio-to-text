# Direct Web microphone opt-in (#289)

The Library switch requests `WEB_VOICE_ORIGINS` directly in its trusted change
handler, before awaiting storage, permission inspection or worker messaging.
The extension confirmation dialog, its buttons and its CSS have been removed.
The compact header and adjacent help retain their existing placement.

The switch stays OFF, disabled and `aria-busy` while permission/setup is pending.
A confirmed grant precedes saving ON and requesting `web-voice-reconcile`.
Failures attempt to save OFF and stop active controls independently of storage,
with a live status message explaining how to retry. If OFF cannot be saved, the
switch reflects the saved preference and warns that ON may restart; unreadable
settings get explicit uncertainty feedback. Repeated changes cannot start a
second request. Completion restores switch focus when appropriate without taking
focus from another active control.

Storage OFF and permission removal cancel an older pending ON, including changes
during its final access check. Graph actions manage their own disabled controls
without restoring an obsolete switch state. The coordinator rechecks host access
before clearing opt-in so an older OFF reconciliation cannot erase a newly
authorized ON preference during startup or worker reconnection.

OFF retains Chrome host access and the saved page-mic graph. Page microphone
capture and site-specific `getUserMedia` permission still begin only on a page-mic
click. The manifest, origin patterns, graph selection, audio capture and ASR paths
are unchanged.

## Validation

- `npm test`: **946 passed**, including a deterministic coordinator regression
  that interleaves an earlier OFF reconciliation with a new ON write and verifies
  that actual host revocation still unregisters scripts and saves OFF.
- Regression coverage rejects OFF/rollback writes and settings reads, verifies
  recording/control cleanup and accurate saved-state feedback, then retries OFF.
  Coordinator coverage verifies that only Graph Library can request temporary
  cleanup, including while earlier registration work is pending.
- `npx playwright test --config playwright.extension.config.js tests/extension/graph-library.spec.js tests/extension/web-voice.spec.js`:
  **96 passed** in the final run.
- Browser coverage includes an actual already-granted Chrome permission request
  from the switch's trusted synchronous handler, pending grant, denial, thrown
  and rejected APIs, permission inspection/storage/reconciliation failures,
  cleanup and retry, rapid interactions, cross-page sync, revocation/restored
  grants, final-check cancellation, independent graph actions, keyboard/focus
  behavior, responsive header/help and existing recording/worker lifecycle cases.

Playwright/CDP cannot automate Chrome's native optional-permission bubble buttons.
The existing installed-extension fixture seeds real host grants and restores the
production optional-only manifest before feature interactions. Missing-access
denial and delayed permission decisions are controlled at the permission API
boundary; authorization, storage, registration and page injection use production
code. Site microphone permission tests remain separate from extension host grants.
