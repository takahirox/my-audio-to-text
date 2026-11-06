import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSession } from '../extension/session.js';

test('Live notices require explicit error metadata; message wording and unfamiliar Node event types cannot promote diagnostics', () => {
  const session = new TabSession(() => {});
  for (const type of ['waiting', 'ready', 'loading', 'generating', 'processing', 'completed', 'progress', 'future-event', undefined]) {
    session.nodeEvent({ type, message: 'Error unavailable failed: these words are ordinary diagnostic data.' }, 'future-node');
  }
  assert.equal(session.view.error, '');
  session.nodeEvent({ type: 'error', message: 'Opaque failure 42. Retry the operation.' }, 'future-node');
  session.nodeEvent({ severity: 'error', message: 'Opaque failure 42. Retry the operation.' }, 'future-node');
  assert.equal(session.view.error, 'future-node: Opaque failure 42. Retry the operation.');
  session.nodeEvent({ type: 'ready', message: 'Ready' }, 'peer');
  assert.equal(session.view.error.split('\n').length, 1);
  session.nodeEvent({ severity: 'error', message: 'Grant permission and retry.' }, 'peer');
  assert.equal(session.view.error.split('\n').length, 2, 'an unrelated branch cannot overwrite an existing error');
  session.fail('Pipeline failed. Start a new session.');
  assert.match(session.view.error, /Opaque failure 42/);
  assert.match(session.view.error, /Pipeline failed/);
});
