import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const turn = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(listener => listener(...args)) };
};
async function fixture(t) {
  const timers = new Set(), windows = [], removed = [];
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onConnect: event(), onMessage: event() },
    permissions: { contains: async () => true, onRemoved: event() },
    storage: { onChanged: event() },
    scripting: { getRegisteredContentScripts: async () => [{}] },
    tabs: { query: async () => [], onRemoved: event(), onUpdated: event() },
    windows: { onRemoved: event(), create: async options => { const window = { id: windows.length + 1, ...options }; windows.push(window); return window; },
      remove: async id => { removed.push(id); } },
  };
  const source = (await readFile(new URL('../extension/web-voice-background.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
  runInNewContext(source, { chrome, crypto: { randomUUID },
    setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout: timer => timers.delete(timer),
    readVoiceEnabled: async () => true, setVoiceEnabled: async () => {}, voiceEnabled: value => value?.enabled === true,
    WEB_VOICE_KEY: 'voice', WEB_VOICE_ORIGINS: ['http://*/*', 'https://*/*'],
  });
  function connect(name, sender) {
    const port = { name, sender: { id: 'extension', ...sender }, sent: [], onMessage: event(), onDisconnect: event(),
      postMessage(message) { this.sent.push(message); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
    chrome.runtime.onConnect.emit(port);
    return port;
  }
  function control(tabId) { return connect('web-voice-control', { tab: { id: tabId }, documentId: `document-${tabId}`, frameId: 0, url: 'https://example.org/' }); }
  async function start(port) { port.onMessage.emit({ type: 'start', capability: randomUUID() }); await turn(); return windows.at(-1); }
  function runtime(window) { return connect('web-voice-runtime', { url: window.url }); }
  t.after(() => { chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local'); assert.equal(timers.size, 0); });
  await turn();
  return { chrome, control, start, runtime, windows, removed, timers };
}

test('independent documents prepare concurrently; duplicate Start and forged runtime cannot replace an owner', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  b.onMessage.emit({ type: 'start', capability: randomUUID() });
  await turn(); assert.equal(f.windows.length, 2);
  const wa = f.windows[0], wb = f.windows[1];
  const forged = f.runtime({ url: wa.url.replace('web-voice-runtime.html', 'recorder.html') });
  assert.equal(forged.disconnected, true);
  const ra = f.runtime(wa), rb = f.runtime(wb);
  assert.equal(ra.sent[0].target.tabId, 1); assert.equal(rb.sent[0].target.tabId, 2);
  assert.notEqual(ra.sent[0].target.capability, rb.sent[0].target.capability);
  assert.equal(f.runtime(wa).disconnected, true);
  a.onMessage.emit({ type: 'stop' });
  assert.equal(ra.sent.at(-1).type, 'stop'); assert.equal(rb.sent.at(-1).type, 'initialize');
  ra.onMessage.emit({ type: 'ended' });
  assert.deepEqual(f.removed, [wa.id]); assert.equal(rb.sent.length, 1);
  rb.onMessage.emit({ type: 'state', state: 'recording' });
  assert.equal(b.sent.at(-1).state, 'recording');
  // Late callbacks from the old owner must not affect its replacement.
  const replacement = f.runtime(await f.start(a));
  ra.onDisconnect.emit(); ra.onMessage.emit({ type: 'ended', error: 'late failure' });
  assert.equal(replacement.sent.length, 1); assert.deepEqual(f.removed, [wa.id]);
});

for (const reason of ['navigation', 'tab close', 'window close', 'disconnect', 'worker failure', 'cancel']) test(`${reason} ends only its Web document`, async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  const wa = await f.start(a), ra = f.runtime(wa), rb = f.runtime(await f.start(b));
  if (reason === 'navigation') f.chrome.tabs.onUpdated.emit(1, { status: 'loading' });
  if (reason === 'tab close') f.chrome.tabs.onRemoved.emit(1);
  if (reason === 'window close') f.chrome.windows.onRemoved.emit(wa.id);
  if (reason === 'disconnect') a.onDisconnect.emit();
  if (reason === 'worker failure') ra.onMessage.emit({ type: 'ended', error: 'GPU memory exhausted' });
  if (reason === 'cancel') a.onMessage.emit({ type: 'cancel' });
  assert.equal(ra.sent.at(-1).type, 'abort'); assert.equal(rb.sent.length, 1);
  assert.equal(b.sent.at(-1).type, 'enabled'); assert.deepEqual(f.removed, [wa.id]);
});

for (const revoke of ['OFF', 'permission']) test(`${revoke} cancels every Web owner`, async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  const ra = f.runtime(await f.start(a)), rb = f.runtime(await f.start(b));
  if (revoke === 'OFF') f.chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local');
  else f.chrome.permissions.onRemoved.emit({ origins: ['https://*/*'] });
  assert.equal(ra.sent.at(-1).type, 'abort'); assert.equal(rb.sent.at(-1).type, 'abort');
  assert.deepEqual(f.removed, [1, 2]);
});

test('canceled window creation and its timeout cannot tear down a replacement or another tab', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  const rb = f.runtime(await f.start(b));
  const create = f.chrome.windows.create; let resolveWindow;
  f.chrome.windows.create = () => new Promise(resolve => { resolveWindow = resolve; });
  await f.start(a); const oldTimeout = [...f.timers][0];
  a.onMessage.emit({ type: 'cancel' });
  f.chrome.windows.create = create;
  const replacement = f.runtime(await f.start(a));
  resolveWindow({ id: 100 }); await turn(); oldTimeout();
  assert.deepEqual(f.removed, [100]); assert.equal(replacement.sent.length, 1); assert.equal(rb.sent.length, 1);
});
