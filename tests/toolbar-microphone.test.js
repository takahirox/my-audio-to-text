import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const turn = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(listener => listener(...args)) };
};
async function fixture() {
  const items = new Map(), errors = [], storage = event();
  const chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    contextMenus: { onClicked: event(), async removeAll() { items.clear(); }, create(item, done) { assert.equal(items.has(item.id), false); items.set(item.id, item); done(); },
      async update(id, props) { if (!items.has(id)) throw Error('Rebuilding'); Object.assign(items.get(id), props); } },
    action: { onClicked: event() }, storage: { onChanged: storage },
    windows: { create: async options => errors.push(options) },
    permissions: { request: () => assert.fail('Unexpected permission request') },
  };
  let onState, enabled = false, pending = false, position = 'auto', failRead = false, failPosition = false;
  const graphs = [{ id: 'graph', name: 'Graph' }];
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
  runInNewContext(source, {
    chrome, URLSearchParams, console,
    WEB_VOICE_KEY: 'voice', WEB_VOICE_POSITION_KEY: 'position', WEB_VOICE_ORIGINS: ['http://*/*', 'https://*/*'], WEB_VOICE_POSITIONS: ['auto', 'left', 'right'],
    requestLaunchLibrary: async () => ({ graphs, defaultId: 'graph' }),
    onWebVoiceStateChanged(listener) { onState = listener; },
    readWebVoiceState: async () => { if (failRead) throw Error('Read failed'); return { enabled, pending }; },
    readVoicePosition: async () => position,
    setVoicePosition: async value => { if (failPosition) throw Error('Position write failed'); position = value; storage.emit({ position: {} }, 'local'); },
    async changeWebVoiceEnabled(value, permission) {
      pending = true; onState();
      try { if (!value || await permission) enabled = value; }
      finally { pending = false; onState(); }
    },
  });
  await turn();
  return { chrome, items, errors, click(info) { chrome.contextMenus.onClicked.emit(info); },
    changed() { onState(); }, readFailure(value) { failRead = value; }, positionFailure(value) { failPosition = value; },
    selectPosition: () => position };
}

test('native checkbox requests permission inside the click gesture before async work and never commits optimistic ON', async () => {
  const f = await fixture();
  assert.equal(f.items.get('web-microphone').type, 'checkbox');
  assert.equal(f.items.get('web-microphone').checked, false);
  assert.deepEqual([...f.items.values()].filter(item => !item.parentId).map(item => item.title), ['Web microphone', 'Microphone position', 'Graphs']);
  assert.deepEqual([...f.items.values()].filter(item => item.parentId === 'microphone-position').map(item => [item.title, item.type, item.checked]), [['Auto', 'radio', true], ['Left', 'radio', false], ['Right', 'radio', false]]);
  let gesture = false, calls = 0, grant;
  f.chrome.permissions.request = options => {
    assert.equal(gesture, true); assert.equal(options.origins.join(), 'http://*/*,https://*/*'); calls++;
    return new Promise(resolve => { grant = resolve; });
  };
  gesture = true; f.click({ menuItemId: 'web-microphone', checked: true }); gesture = false;
  assert.equal(calls, 1); assert.equal(f.items.get('web-microphone').checked, false);
  f.click({ menuItemId: 'web-microphone', checked: true }); assert.equal(calls, 1);
  await turn(); assert.equal(f.items.get('web-microphone').enabled, false);
  // Graph refreshes must reconstruct the busy checkbox and radio state.
  f.chrome.runtime.onStartup.emit(); await turn();
  assert.equal(f.items.get('web-microphone').checked, false); assert.equal(f.items.get('web-microphone').enabled, false);
  grant(true); await turn();
  assert.equal(f.items.get('web-microphone').checked, true); assert.equal(f.items.get('web-microphone').enabled, true);
  assert.equal(f.errors.length, 0);
  f.click({ menuItemId: 'web-microphone', checked: false }); await turn();
  assert.equal(calls, 1, 'OFF never requests permissions'); assert.equal(f.items.get('web-microphone').checked, false);
});

test('radios persist while OFF, refresh restores the chosen side, and failed writes restore saved state', async () => {
  const f = await fixture();
  f.click({ menuItemId: 'microphone-position:left', checked: true });
  f.click({ menuItemId: 'microphone-position:right', checked: true });
  await turn(); assert.equal(f.selectPosition(), 'right');
  f.chrome.runtime.onStartup.emit(); await turn();
  assert.equal(f.items.get('microphone-position:right').checked, true);
  assert.equal(f.items.get('web-microphone').checked, false);
  f.positionFailure(true);
  f.items.get('microphone-position:left').checked = true; // Chrome's native optimistic radio toggle
  f.items.get('microphone-position:right').checked = false;
  f.click({ menuItemId: 'microphone-position:left', checked: true }); await turn();
  assert.equal(f.items.get('microphone-position:right').checked, true); assert.equal(f.items.get('microphone-position:left').checked, false);
  assert.equal(f.items.get('live-run:graph').checked, true); assert.equal(f.items.get('live-library').parentId, 'live-graphs');
});

test('unreadable canonical settings fail closed and leave the menu available to retry', async () => {
  const f = await fixture();
  f.chrome.permissions.request = async () => true;
  f.click({ menuItemId: 'web-microphone', checked: true }); await turn();
  assert.equal(f.items.get('web-microphone').checked, true);
  f.readFailure(true); f.changed(); await turn();
  assert.equal(f.items.get('web-microphone').checked, false); assert.equal(f.items.get('web-microphone').enabled, true);
  f.readFailure(false); f.changed(); await turn();
  assert.equal(f.items.get('web-microphone').checked, true);
});
