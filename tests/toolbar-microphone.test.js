import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const turn = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(listener => listener(...args)) };
};
async function fixture({ preferences = { enabled: false, position: 'auto' }, graphs = [{ id: 'graph', name: 'Graph' }], libraryError = false } = {}) {
  const items = new Map(), errors = [], storage = event();
  let creating = false;
  const chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    contextMenus: { onClicked: event(), async removeAll() { assert.equal(creating, false); items.clear(); }, create(item, done) {
      assert.equal(creating, false);
      assert.equal(items.has(item.id), false);
      if (item.parentId) assert.equal(items.has(item.parentId), true, `${item.id} requires its parent first`);
      creating = true; items.set(item.id, item);
      queueMicrotask(() => { creating = false; done(); });
    },
      async update(id, props) { if (!items.has(id)) throw Error('Rebuilding'); Object.assign(items.get(id), props); } },
    action: { onClicked: event() }, storage: { onChanged: storage },
    windows: { create: async options => errors.push(options) },
    permissions: { request: () => assert.fail('Unexpected permission request') },
  };
  let onState, pending = false, failRead = false, failPosition = false, failChange = false;
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
  runInNewContext(source, {
    chrome, URLSearchParams, console,
    WEB_VOICE_KEY: 'voice', WEB_VOICE_POSITION_KEY: 'position', WEB_VOICE_ORIGINS: ['http://*/*', 'https://*/*'], WEB_VOICE_POSITIONS: ['auto', 'left', 'right'],
    requestLaunchLibrary: async () => { if (libraryError) throw Error('Library unavailable'); return { graphs, defaultId: graphs.at(-1)?.id }; },
    onWebVoiceStateChanged(listener) { onState = listener; },
    readWebVoiceState: async () => { if (failRead) throw Error('Read failed'); return { enabled: preferences.enabled, pending }; },
    readVoicePosition: async () => preferences.position,
    setVoicePosition: async value => { if (failPosition) throw Error('Position write failed'); preferences.position = value; storage.emit({ position: {} }, 'local'); },
    async changeWebVoiceEnabled(value, permission) {
      pending = true; onState();
      try { if (!value || await permission) { if (failChange) throw Error('Enable failed'); preferences.enabled = value; } }
      finally { pending = false; onState(); }
    },
  });
  await turn();
  return { chrome, items, errors, click(info) { chrome.contextMenus.onClicked.emit(info); },
    changed() { onState(); }, readFailure(value) { failRead = value; }, positionFailure(value) { failPosition = value; }, changeFailure(value) { failChange = value; },
    selectPosition: () => preferences.position };
}

function assertHierarchy(f) {
  const items = [...f.items.values()];
  assert.deepEqual(items.filter(item => !item.parentId).map(item => [item.id, item.title, item.type]), [['microphone', 'Microphone', undefined], ['live-graphs', 'Graphs', undefined]]);
  assert.deepEqual(items.filter(item => item.parentId === 'microphone').map(item => [item.id, item.title, item.type]), [['web-microphone', 'Enable', 'checkbox'], ['microphone-position', 'Icon position', undefined]]);
  assert.deepEqual(items.filter(item => item.parentId === 'microphone-position').map(item => [item.title, item.type]), [['Auto', 'radio'], ['Left', 'radio'], ['Right', 'radio']]);
  assert.equal(items.filter(item => item.parentId === 'microphone-position' && item.checked).length, 1);
  assert.deepEqual(items.filter(item => item.parentId === 'live-graphs').map(item => [item.id, item.title]), [['live-open', 'Open'], ['live-library', 'Graph Library']]);
  assert.ok(items.every(item => item.contexts.join() === 'action'));
}

test('native checkbox requests permission inside the click gesture before async work and never commits optimistic ON', async () => {
  const f = await fixture();
  assert.equal(f.items.get('web-microphone').type, 'checkbox');
  assert.equal(f.items.get('web-microphone').checked, false);
  assertHierarchy(f);
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
  assertHierarchy(f);
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
  assertHierarchy(f);
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

test('denied permission and failed enable restore the nested checkbox to canonical OFF', async () => {
  const f = await fixture();
  f.chrome.permissions.request = async () => false;
  f.items.get('web-microphone').checked = true; // Chrome's optimistic check
  f.click({ menuItemId: 'web-microphone', checked: true }); await turn();
  assert.equal(f.items.get('web-microphone').checked, false);
  assert.equal(f.items.get('web-microphone').enabled, true);
  assert.equal(f.errors.length, 0);
  f.chrome.permissions.request = async () => true;
  f.changeFailure(true);
  f.click({ menuItemId: 'web-microphone', checked: true }); await turn();
  assert.equal(f.items.get('web-microphone').checked, false);
  assert.equal(f.items.get('web-microphone').enabled, true);
  assert.match(f.errors[0].url, /web-voice-consent.html/);
  assertHierarchy(f);
});

test('saved checks survive worker recreation and track external storage and permission state', async () => {
  const preferences = { enabled: true, position: 'left' };
  const f = await fixture({ preferences });
  assertHierarchy(f);
  assert.equal(f.items.get('web-microphone').checked, true);
  assert.equal(f.items.get('microphone-position:left').checked, true);
  f.click({ menuItemId: 'microphone-position:right', checked: true }); await turn();
  assert.equal(preferences.enabled, true);
  assert.equal(preferences.position, 'right');
  const restarted = await fixture({ preferences });
  assertHierarchy(restarted);
  assert.equal(restarted.items.get('web-microphone').checked, true);
  assert.equal(restarted.items.get('microphone-position:right').checked, true);
  preferences.position = 'auto';
  restarted.chrome.storage.onChanged.emit({ position: {} }, 'local'); await turn();
  assert.equal(restarted.items.get('microphone-position:auto').checked, true);
  preferences.enabled = false;
  restarted.changed(); await turn(); // Coordinator notification after permission revocation.
  assert.equal(restarted.items.get('web-microphone').checked, false);
  preferences.enabled = true;
  restarted.chrome.storage.onChanged.emit({ voice: {} }, 'local'); await turn();
  assert.equal(restarted.items.get('web-microphone').checked, true);
});

for (const count of [0, 1, 12]) test(`nested microphone menus survive graph refreshes with ${count} graphs`, async () => {
  const graphs = Array.from({ length: count }, (_, i) => ({ id: `graph-${i}`, name: `Graph ${i}` }));
  const f = await fixture({ graphs, preferences: { enabled: true, position: 'right' } });
  const before = structuredClone([...f.items.values()]);
  f.chrome.runtime.onMessage.emit({ type: 'graph-library-changed' }, { id: 'test', url: f.chrome.runtime.getURL('extension/graph-library.html') }); await turn();
  assertHierarchy(f);
  assert.deepEqual(structuredClone([...f.items.values()]), before);
  assert.equal(f.items.get('web-microphone').checked, true);
  assert.equal(f.items.get('microphone-position:right').checked, true);
  const radios = [...f.items.values()].filter(item => item.parentId === 'live-open' && item.type === 'radio');
  assert.equal(radios.length, count);
  assert.deepEqual(radios.filter(item => item.checked).map(item => item.id), count ? [`live-run:graph-${count - 1}`] : []);
  if (!count) assert.equal(f.items.get('live-empty').enabled, false);
});

test('unavailable graph library still creates both groups and usable microphone controls', async () => {
  const f = await fixture({ libraryError: true });
  assertHierarchy(f);
  assert.equal(f.items.get('live-empty').title, 'Library unavailable');
  f.click({ menuItemId: 'microphone-position:left', checked: true }); await turn();
  assert.equal(f.selectPosition(), 'left');
  assert.equal(f.items.get('web-microphone').checked, false);
});
