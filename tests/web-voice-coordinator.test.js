import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webVoiceChoices, webVoiceDefault } from '../extension/web-voice-graph.js';
import { graphNode, edge } from '../extension/graph.js';
import { randomUUID } from 'node:crypto';

const turn = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(listener => listener(...args)) };
};
async function fixture(t, { existingDocument = false } = {}) {
  const library = { assignments: { webVoice: 'voice' }, graphs: [{ id: 'voice', name: 'Dictation', graph: { version: 15,
    nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
    edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] } }] };
  const preferences = {};
  const timers = new Set(), created = [], removed = [], relays = [], setups = [];
  let contexts = existingDocument ? [{ documentUrl: 'chrome-extension://extension/extension/web-voice-runtime.html#old' }] : [], closed = 0;
  const makePort = (name, sender) => ({ name, sender: { id: 'extension', ...sender }, sent: [], onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      if (message.type === 'library-read') { this.onMessage.emit({ type: 'library', request: message.request, library }); return; }
      this.sent.push(message);
    }, disconnect() { if (this.disconnected) return; this.disconnected = true; this.onDisconnect.emit(); } });
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onConnect: event(), onMessage: event(), getContexts: async () => contexts },
    permissions: { contains: async () => true, onRemoved: event() }, storage: { onChanged: event(), local: { get: async key => ({ [key]: preferences[key] }), set: async value => Object.assign(preferences, value) } },
    scripting: { getRegisteredContentScripts: async () => [{}] },
    tabs: { query: async () => [], onRemoved: event(), onUpdated: event(),
      connect(tabId, options) { const port = makePort(options.name); relays.push({ tabId, ...options, port }); return port; },
      create: async options => { const tab = { id: 100 + setups.length, ...options }; setups.push(tab); return tab; },
      update: async () => {}, remove: async id => { removed.push(id); } },
    offscreen: {
      createDocument: async options => { created.push(options); contexts = [{ documentUrl: options.url }]; },
      closeDocument: async () => { contexts = []; closed++; },
    },
  };
  const source = (await readFile(new URL('../extension/web-voice-background.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
  runInNewContext(source, { chrome, structuredClone, webVoiceChoices, webVoiceDefault, crypto: { randomUUID },
    setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout: timer => timers.delete(timer),
    readVoiceEnabled: async () => true, setVoiceEnabled: async () => {}, voiceEnabled: value => value?.enabled === true,
    WEB_VOICE_KEY: 'voice', WEB_VOICE_ORIGINS: ['http://*/*', 'https://*/*'],
  });
  function connect(name, sender) { const port = makePort(name, sender); chrome.runtime.onConnect.emit(port); return port; }
  function control(tabId) { return connect('web-voice-control', { tab: { id: tabId }, documentId: `document-${tabId}`, frameId: 0, url: 'https://example.org/' }); }
  async function start(port) { port.onMessage.emit({ type: 'start', capability: randomUUID() }); await turn(); }
  async function host(url = created.at(-1)?.url) { const port = connect('web-voice-host', { url }); await turn(); return port; }
  function output(token, url = created.at(-1)?.url) { return connect(`web-voice-output:${token}`, { url }); }
  t.after(async () => { chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local'); await turn(); assert.equal(timers.size, 0); });
  await turn();
  return { chrome, library, preferences, control, start, host, output, connect, created, removed, timers, relays, setups, closed: () => closed };
}

test('one authenticated offscreen host multiplexes independent documents and rejects forged owners', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  b.onMessage.emit({ type: 'start', capability: randomUUID() });
  await turn(); assert.equal(f.created.length, 1);
  assert.deepEqual([...f.created[0].reasons], ['USER_MEDIA', 'WORKERS', 'LOCAL_STORAGE']);
  assert.equal((await f.host(f.created[0].url.replace('web-voice-runtime.html', 'recorder.html'))).disconnected, true);
  assert.equal((await f.host(f.created[0].url.replace(/#.*/, '#wrong'))).disconnected, true);
  const host = await f.host(), [sa, sb] = host.sent;
  assert.equal(sa.target.tabId, 1); assert.equal(sb.target.tabId, 2);
  assert.notEqual(sa.target.capability, sb.target.capability); assert.notEqual(sa.token, sb.token);
  assert.equal((await f.host()).disconnected, true);
  assert.equal(f.output('wrong').disconnected, true);
  assert.equal(f.output(sa.token, 'https://example.org/').disconnected, true);
  const output = f.output(sa.token);
  assert.equal(f.output(sa.token).disconnected, true);
  assert.equal(f.relays[0].tabId, 1); assert.equal(f.relays[0].documentId, 'document-1');
  output.onMessage.emit({ request: 1, action: 'append', capability: sa.target.capability, text: 'hello' });
  assert.equal(f.relays[0].port.sent[0].text, 'hello');
  f.relays[0].port.onMessage.emit({ request: 1, result: true }); assert.equal(output.sent[0].result, true);
  a.onMessage.emit({ type: 'stop' }); assert.equal(host.sent.at(-1).token, sa.token); assert.equal(host.sent.at(-1).type, 'stop');
  host.onMessage.emit({ type: 'ended', token: sa.token }); await turn();
  assert.equal(f.closed(), 0); assert.equal(output.disconnected, true);
  host.onMessage.emit({ type: 'state', token: sb.token, state: 'recording' }); assert.equal(b.sent.at(-1).state, 'recording');
  await f.start(a); const replacement = host.sent.at(-1);
  host.onMessage.emit({ type: 'ended', token: sa.token, error: 'late error' });
  assert.equal(host.sent.at(-1), replacement); assert.equal(replacement.type, 'initialize');
});

for (const reason of ['navigation', 'tab close', 'disconnect', 'worker failure', 'cancel', 'output disconnect']) test(`${reason} ends only its Web document`, async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  await f.start(a); await f.start(b); const host = await f.host(), [sa, sb] = host.sent;
  const output = f.output(sa.token);
  if (reason === 'navigation') f.chrome.tabs.onUpdated.emit(1, { status: 'loading' });
  if (reason === 'tab close') f.chrome.tabs.onRemoved.emit(1);
  if (reason === 'disconnect') a.onDisconnect.emit();
  if (reason === 'worker failure') host.onMessage.emit({ type: 'ended', token: sa.token, error: 'GPU memory exhausted' });
  if (reason === 'cancel') { a.onMessage.emit({ type: 'cancel' }); host.onMessage.emit({ type: 'ended', token: sa.token }); }
  if (reason === 'output disconnect') f.relays[0].port.disconnect();
  await turn(); assert.equal(f.closed(), 0); assert.equal(output.disconnected, true);
  assert.equal(host.sent.at(-1).type, 'abort'); assert.equal(host.sent.at(-1).token, sa.token);
  assert.equal(b.sent.at(-1).type, 'graphs');
  host.onMessage.emit({ type: 'state', token: sb.token, state: 'recording' }); assert.equal(b.sent.at(-1).state, 'recording');
});

for (const revoke of ['OFF', 'permission', 'host disconnect']) test(`${revoke} cancels every Web owner and closes offscreen capture`, async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  await f.start(a); await f.start(b); const host = await f.host();
  if (revoke === 'OFF') f.chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local');
  else if (revoke === 'permission') f.chrome.permissions.onRemoved.emit({ origins: ['https://*/*'] });
  else host.disconnect();
  await turn(); assert.equal(f.closed(), 1);
  assert.ok(a.sent.some(m => m.type === 'ended')); assert.ok(b.sent.some(m => m.type === 'ended'));
});

test('cancel while offscreen creation is pending cannot tear down a queued replacement', async t => {
  const f = await fixture(t);
  const create = f.chrome.offscreen.createDocument; let resolveCreation;
  f.chrome.offscreen.createDocument = options => new Promise(resolve => { resolveCreation = async () => { await create(options); resolve(); }; });
  const a = f.control(1);
  await f.start(a); const timeout = [...f.timers].at(-1); a.onMessage.emit({ type: 'cancel' });
  await f.start(a); await resolveCreation(); await turn(); const host = await f.host();
  assert.equal(host.sent.length, 1); assert.equal(f.created.length, 1); assert.equal(f.closed(), 0);
  timeout(); assert.equal(host.sent.length, 1);
});

test('permission setup completion is restricted to its session URL and tab; canceled results cannot resume capture', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(), session = host.sent[0]; host.onMessage.emit({ type: 'permission-needed', token: session.token }); await turn();
  assert.equal(f.setups.length, 1); const tab = f.setups[0];
  let response;
  f.chrome.runtime.onMessage.emit({ type: 'web-voice-permission-result' }, { id: 'extension', url: tab.url, tab: { id: tab.id + 1 } }, value => { response = value; });
  assert.match(response.error, /canceled/);
  a.onMessage.emit({ type: 'cancel' }); host.onMessage.emit({ type: 'ended', token: session.token });
  f.chrome.runtime.onMessage.emit({ type: 'web-voice-permission-result' }, { id: 'extension', url: tab.url, tab: { id: tab.id } }, value => { response = value; });
  assert.match(response.error, /canceled/); await turn(); assert.deepEqual(f.removed, [tab.id]); assert.equal(f.closed(), 1);
});


test('startup discards a previous offscreen generation before accepting capture', async t => {
  const f = await fixture(t, { existingDocument: true }); assert.equal(f.closed(), 1);
  const a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(); assert.equal(host.sent[0].type, 'initialize'); assert.equal(f.created.length, 1);
});

test('an immediate retry after host disconnect creates a fresh generation', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const previous = await f.host(), token = previous.sent[0].token; previous.disconnect();
  await f.start(a);
  const host = await f.host(); assert.equal(f.created.length, 2); assert.equal(host.sent.length, 1);
  assert.notEqual(host.sent[0].token, token);
  previous.onMessage.emit({ type: 'ended', token, error: 'late old owner' });
  assert.equal(host.sent.length, 1);
});


test('failed return to the target closes the permission setup and its capture owner', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(), session = host.sent[0]; host.onMessage.emit({ type: 'permission-needed', token: session.token }); await turn();
  const tab = f.setups[0]; f.chrome.tabs.update = async () => { throw Error('Target tab is gone'); };
  let response;
  f.chrome.runtime.onMessage.emit({ type: 'web-voice-permission-result' }, { id: 'extension', url: tab.url, tab: { id: tab.id } }, value => { response = value; });
  await turn(); assert.match(response.error, /Target tab/); assert.deepEqual(f.removed, [tab.id]); assert.equal(f.closed(), 1);
});

test('selection is storage-only; active and stopping controls cannot switch while another document can choose independently', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(), running = host.sent[0];
  f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id: 'other', name: 'Other voice' });
  assert.equal(running.graph.id, 'voice');
  for (const state of ['preparing', 'recording', 'stopping']) {
    host.onMessage.emit({ type: 'state', token: running.token, state });
    a.onMessage.emit({ type: 'select-graph', id: 'other' }); await turn();
    assert.equal(f.preferences['web-microphone-default-v1'], 'voice');
    await f.start(a); assert.equal(host.sent.filter(m => m.type === 'initialize').length, 1);
  }
  const peer = f.control(2); await turn();
  peer.onMessage.emit({ type: 'select-graph', id: 'other' }); await turn();
  assert.equal(f.preferences['web-microphone-default-v1'], 'other');
  assert.ok(peer.sent.some(m => m.type === 'selection-saved'));
  assert.equal(host.sent.filter(m => m.type === 'initialize').length, 1);
  assert.equal(running.graph.id, 'voice');
  a.onMessage.emit({ type: 'stop' });
  a.onMessage.emit({ type: 'select-graph', id: 'voice' }); await turn();
  assert.equal(f.preferences['web-microphone-default-v1'], 'other');
  host.onMessage.emit({ type: 'ended', token: running.token }); await turn();
  await f.start(a); const replacement = await f.host();
  assert.equal(replacement.sent[0].graph.id, 'other');
});
