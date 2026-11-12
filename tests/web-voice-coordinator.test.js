import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webVoiceChoices, webVoiceDefault } from '../extension/web-voice-graph.js';
import { graphNode, edge } from '../extension/graph.js';
import { installTabCaptureBridge } from '../extension/tab-capture-background.js';
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
    windows: { onRemoved: event() },
    permissions: { contains: async () => true, onRemoved: event(), onAdded: event() }, storage: { session: { get: async () => ({}), remove: async () => {} }, onChanged: event(), local: { get: async key => ({ [key]: preferences[key] }), set: async value => Object.assign(preferences, value) } },
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
  const source = (await readFile(new URL('../extension/web-voice-background.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replace(/export (async function|function|const)/g, '$1');
  const globals = { installTabCaptureBridge: options => installTabCaptureBridge(options, chrome), chrome, structuredClone, webVoiceChoices, webVoiceDefault, crypto: { randomUUID },
    setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout: timer => timers.delete(timer),
    readVoiceEnabled: async () => true, setVoiceEnabled: async () => {}, voiceEnabled: value => value?.enabled === true,
    WEB_VOICE_KEY: 'voice', WEB_VOICE_ORIGINS: ['http://*/*', 'https://*/*'],
  };
  runInNewContext(source, globals);
  function connect(name, sender) { const port = makePort(name, sender); chrome.runtime.onConnect.emit(port); return port; }
  function control(tabId) { return connect('web-voice-control', { tab: { id: tabId }, documentId: `document-${tabId}`, frameId: 0, url: 'https://example.org/' }); }
  async function start(port, graphId) { port.onMessage.emit({ type: 'start', capability: randomUUID(), graphId }); await turn(); }
  async function host(url = created.at(-1)?.url) { const port = connect('web-voice-host', { url }); await turn(); return port; }
  function output(token, url = created.at(-1)?.url) { return connect(`web-voice-output:${token}`, { url }); }
  t.after(async () => { chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local'); await turn(); assert.equal(timers.size, 0); });
  await turn();
  return { globals, requestLibrary: globals.requestLaunchLibrary, chrome, library, preferences, control, start, host, output, connect, created, removed, timers, relays, setups, closed: () => closed };
}

test('an earlier OFF reconciliation cannot clear a newly granted ON preference', async t => {
  const f = await fixture(t);
  let enabled = false, releaseInspection, registered = [];
  f.globals.readVoiceEnabled = async () => enabled;
  f.globals.setVoiceEnabled = async value => { enabled = value; };
  f.chrome.scripting.getRegisteredContentScripts = () => new Promise(resolve => { releaseInspection = () => resolve(registered); });
  const reconcile = () => new Promise(resolve => f.chrome.runtime.onMessage.emit({ type: 'web-voice-reconcile' },
    { id: 'extension', url: 'chrome-extension://extension/extension/web-voice-consent.html' }, resolve));
  const earlier = reconcile(); await turn();
  assert.equal(typeof releaseInspection, 'function');
  enabled = true; releaseInspection(); await earlier;
  assert.equal(enabled, true);
  f.chrome.scripting.getRegisteredContentScripts = async () => registered;
  f.chrome.scripting.registerContentScripts = async scripts => { registered = scripts; };
  f.chrome.scripting.unregisterContentScripts = async () => { registered = []; };
  assert.equal((await reconcile()).ok, true);
  assert.equal(registered.length, 1); assert.equal(enabled, true);
  f.chrome.permissions.contains = async () => false;
  assert.equal((await reconcile()).ok, true);
  assert.equal(enabled, false); assert.equal(registered.length, 0);
});

test('only the consent window can stop controls without saving OFF, even behind pending reconciliation', async t => {
  const f = await fixture(t), control = f.control(1); await turn();
  await f.start(control); const host = await f.host();
  let registered = true, finishInspection;
  f.chrome.scripting.getRegisteredContentScripts = () => new Promise(resolve => { finishInspection = () => resolve([{}]); });
  f.chrome.scripting.unregisterContentScripts = async () => { registered = false; };
  const sender = { id: 'extension', url: 'chrome-extension://extension/extension/web-voice-consent.html' };
  for (const untrusted of [{ ...sender, id: 'other' }, { ...sender, url: 'https://example.org/' }]) {
    f.chrome.runtime.onMessage.emit({ type: 'web-voice-reconcile', stop: true }, untrusted, () => assert.fail('Unauthorized stop replied'));
  }
  assert.equal(host.sent.some(message => message.type === 'abort'), false);
  const pending = new Promise(resolve => f.chrome.runtime.onMessage.emit({ type: 'web-voice-reconcile' }, sender, resolve));
  await turn();
  f.globals.readVoiceEnabled = async () => { throw Error('Storage unavailable'); };
  f.globals.setVoiceEnabled = async () => assert.fail('Temporary cleanup must not require storage');
  const stopped = new Promise(resolve => f.chrome.runtime.onMessage.emit({ type: 'web-voice-reconcile', stop: true }, sender, resolve));
  assert.equal(host.sent.at(-1).type, 'abort');
  assert.equal(control.sent.at(-1).type, 'disabled');
  f.chrome.scripting.getRegisteredContentScripts = async () => registered ? [{}] : [];
  finishInspection(); assert.equal((await pending).ok, true);
  assert.equal((await stopped).ok, true); assert.equal(registered, false);
  await turn(); assert.equal(f.closed(), 1);
});

test('one authenticated offscreen host multiplexes independent documents and rejects forged owners', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  a.onMessage.emit({ type: 'start', capability: randomUUID() });
  b.onMessage.emit({ type: 'start', capability: randomUUID() });
  await turn(); assert.equal(f.created.length, 1);
  assert.deepEqual([...f.created[0].reasons], ['WORKERS', 'LOCAL_STORAGE', 'USER_MEDIA']);
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

test('page PCM is authenticated, ordered and acknowledged only by its current host', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  await f.start(a); await f.start(b); const host = await f.host(), [sa, sb] = host.sent;
  host.onMessage.emit({ type: 'state', token: sa.token, state: 'recording' });
  host.onMessage.emit({ type: 'state', token: sb.token, state: 'recording' });
  const chunk = { type: 'pcm', sequence: 0, pcm: 'AAAAAA==', capability: sa.target.capability };
  b.onMessage.emit(chunk); assert.equal(host.sent.length, 2);
  a.onMessage.emit(chunk); assert.equal(host.sent.at(-1).type, 'pcm'); assert.equal(host.sent.at(-1).token, sa.token);
  host.onMessage.emit({ type: 'pcm-ack', token: sa.token, sequence: 0 });
  assert.equal(a.sent.at(-1).type, 'pcm-ack'); assert.equal(a.sent.at(-1).capability, sa.target.capability);
  // A replay cannot enter the graph a second time.
  a.onMessage.emit(chunk); assert.equal(host.sent.at(-1).type, 'abort');
  assert.equal(host.sent.at(-1).token, sa.token);
  host.onMessage.emit({ type: 'ended', token: sa.token });
  a.onMessage.emit({ ...chunk, sequence: 1 }); assert.equal(host.sent.at(-1).type, 'abort');
  assert.equal(f.setups.length, 0);
});

test('an unacknowledged relay stops at eight chunks and cannot overrun the host', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(), session = host.sent[0];
  host.onMessage.emit({ type: 'state', token: session.token, state: 'recording' });
  for (let sequence = 0; sequence < 9; sequence++) a.onMessage.emit({ type: 'pcm', sequence, pcm: 'AAAAAA==', capability: session.target.capability });
  assert.equal(host.sent.filter(m => m.type === 'pcm').length, 8);
  assert.equal(host.sent.at(-1).type, 'abort'); assert.equal(f.setups.length, 0);
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


test('graph selection starts that graph; active and stopping documents cannot switch, while peers stay independent', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); await f.start(a);
  const host = await f.host(), running = host.sent[0];
  f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id: 'other', name: 'Other voice' });
  assert.equal(running.graph.id, 'voice');
  for (const state of ['preparing', 'recording', 'stopping']) {
    host.onMessage.emit({ type: 'state', token: running.token, state });
    await f.start(a, 'other');
    assert.equal(f.preferences['web-microphone-default-v1'], 'voice');
    await f.start(a); assert.equal(host.sent.filter(m => m.type === 'initialize').length, 1);
  }
  const peer = f.control(2); await turn();
  await f.start(peer, 'other');
  assert.equal(f.preferences['web-microphone-default-v1'], 'other');
  assert.equal(host.sent.filter(m => m.type === 'initialize').length, 2);
  assert.equal(host.sent.filter(m => m.type === 'initialize').at(-1).graph.id, 'other');
  assert.equal(running.graph.id, 'voice');
  a.onMessage.emit({ type: 'stop' });
  await f.start(a, 'voice');
  assert.equal(f.preferences['web-microphone-default-v1'], 'other');
  host.onMessage.emit({ type: 'ended', token: running.token }); await turn();
  await f.start(a);
  assert.equal(host.sent.filter(m => m.type === 'initialize').at(-1).graph.id, 'other');
});

// Keep the real library host alive while tests hold selection reads/writes.
async function readyHost(f) {
  const keeper = f.control(99); await turn(); await f.start(keeper);
  const host = await f.host(); host.sent.length = 0; return host;
}

test('slow default writes serialize cross-document choices and reserve one exact graph per start', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); const host = await readyHost(f);
  for (const id of ['other', 'third']) f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id, name: id });
  const b = f.control(2); await turn();
  const write = f.chrome.storage.local.set, writes = []; let release;
  f.chrome.storage.local.set = async value => {
    writes.push(value['web-microphone-default-v1']);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    await write(value);
  };
  await f.start(a, 'other');
  await f.start(a, 'third'); // Cannot replace the pending graph or queue another write.
  await f.start(b, 'third');
  assert.deepEqual(writes, ['other']);
  assert.equal(host.sent.filter(m => m.type === 'initialize').length, 0);
  assert.match(a.sent.at(-1).error, /already active/);
  release(); await turn();
  const initialized = host.sent.filter(m => m.type === 'initialize');
  assert.deepEqual(initialized.map(m => m.graph.id), ['other', 'third']);
  assert.deepEqual(writes, ['other', 'third']);
  assert.equal(f.preferences['web-microphone-default-v1'], 'third');
  const c = f.control(3); await turn(); await f.start(c);
  assert.equal(host.sent.filter(m => m.type === 'initialize').at(-1).graph.id, 'third');
});

test('slow authorization cannot reorder choices from different documents', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn(); const host = await readyHost(f);
  for (const id of ['other', 'third']) f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id });
  let release, reads = 0;
  f.globals.readVoiceEnabled = () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true);
  await f.start(a, 'other'); await f.start(b, 'third');
  assert.equal(reads, 1);
  release(true); await turn();
  assert.deepEqual(host.sent.filter(m => m.type === 'initialize').map(m => m.graph.id), ['other', 'third']);
  assert.equal(f.preferences['web-microphone-default-v1'], 'third');
});

for (const graphId of ['deleted', 'incompatible', null, '']) test(`explicit graph ${JSON.stringify(graphId)} never falls back to the saved default`, async t => {
  const f = await fixture(t), a = f.control(1); await turn(); const host = await readyHost(f);
  f.library.graphs.push({ id: 'incompatible', name: 'No microphone', graph: { version: 15, nodes: [], edges: [] } });
  await f.start(a, graphId);
  assert.match(a.sent.at(-1).error, /graph/i);
  assert.equal(typeof a.sent.at(-1).capability, 'string');
  assert.equal(f.preferences['web-microphone-default-v1'], 'voice');
  assert.equal(host.sent.some(m => m.type === 'initialize'), false);
});

test('a failed default save ends the selected attempt without executing any graph', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); const host = await readyHost(f);
  f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id: 'other' });
  f.chrome.storage.local.set = async () => { throw Error('Could not save default. Retry the graph choice.'); };
  await f.start(a, 'other');
  assert.match(a.sent.at(-1).error, /Could not save default/);
  assert.equal(f.preferences['web-microphone-default-v1'], 'voice');
  assert.equal(host.sent.some(m => m.type === 'initialize'), false);
});

for (const interrupt of ['cancel', 'disconnect', 'OFF', 'permission', 'unauthorized']) test(`${interrupt} during graph resolution prevents stale preference writes and initialization`, async t => {
  const f = await fixture(t), a = f.control(1); await turn(); const host = await readyHost(f);
  f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id: 'other' });
  const read = f.chrome.storage.local.get; let release;
  f.chrome.storage.local.get = key => new Promise(resolve => { release = async () => resolve(await read(key)); });
  await f.start(a, 'other'); assert.equal(typeof release, 'function');
  if (interrupt === 'cancel') a.onMessage.emit({ type: 'cancel' });
  if (interrupt === 'disconnect') a.disconnect();
  if (interrupt === 'OFF') f.chrome.storage.onChanged.emit({ voice: { newValue: { enabled: false } } }, 'local');
  if (interrupt === 'permission') f.chrome.permissions.onRemoved.emit({ origins: ['https://*/*'] });
  if (interrupt === 'unauthorized') f.globals.readVoiceEnabled = async () => false;
  f.chrome.storage.local.get = read; await release(); await turn();
  assert.equal(f.preferences['web-microphone-default-v1'], 'voice');
  assert.equal(host.sent.some(m => m.type === 'initialize'), false);
});

test('canceling an in-flight save cannot initialize its stale graph or reorder a replacement choice', async t => {
  const f = await fixture(t), a = f.control(1); await turn(); const host = await readyHost(f);
  for (const id of ['other', 'third']) f.library.graphs.push({ ...structuredClone(f.library.graphs[0]), id });
  const write = f.chrome.storage.local.set; let release;
  f.chrome.storage.local.set = async value => { await new Promise(resolve => { release = resolve; }); await write(value); };
  await f.start(a, 'other'); assert.equal(typeof release, 'function');
  a.onMessage.emit({ type: 'cancel' });
  const ended = a.sent.findLast(m => m.type === 'ended');
  await f.start(a, 'third');
  f.chrome.storage.local.set = write; release(); await turn();
  const initialized = host.sent.filter(m => m.type === 'initialize');
  assert.deepEqual(initialized.map(m => m.graph.id), ['third']);
  assert.equal(f.preferences['web-microphone-default-v1'], 'third');
  assert.notEqual(initialized[0].target.capability, ended.capability);
  host.onMessage.emit({ type: 'state', token: initialized[0].token, state: 'recording' });
  assert.equal(a.sent.at(-1).capability, initialized[0].target.capability);
});

test('toolbar library reads/default writes share the DOM host without closing independent Web captures', async t => {
  const f = await fixture(t), a = f.control(1), b = f.control(2); await turn();
  await f.start(a); await f.start(b); const host = await f.host();
  const read = f.requestLibrary('live-list'); await turn();
  const request = host.sent.at(-1);
  assert.equal(request.type, 'launch-library'); assert.equal(request.operation, 'live-list');
  host.onMessage.emit({ type: 'launch-library-result', request: request.request, result: { defaultId: 'saved' } });
  assert.equal((await read).defaultId, 'saved'); await turn();
  assert.equal(f.closed(), 0); assert.equal(f.created.length, 1);
  const write = f.requestLibrary('live-default', 'other'); await turn();
  const next = host.sent.at(-1);
  host.onMessage.emit({ type: 'launch-library-result', request: next.request, error: 'Storage quota exceeded' });
  await assert.rejects(write, /quota/);
  assert.equal(f.closed(), 0);
  assert.ok(!a.sent.some(message => message.type === 'ended'));
  assert.ok(!b.sent.some(message => message.type === 'ended'));
});

test('library request pending during host startup is dispatched once and keeps the host until its reply', async t => {
  const f = await fixture(t);
  const read = f.requestLibrary('live-list'); await turn();
  const host = await f.host(); await turn();
  const requests = host.sent.filter(message => message.type === 'launch-library');
  assert.equal(requests.length, 1); assert.equal(f.closed(), 0);
  host.onMessage.emit({ type: 'launch-library-result', request: requests[0].request, result: { graphs: [] } });
  await read; await turn(); assert.equal(f.closed(), 1);
});

async function settingsFixture(t) {
  const f = await fixture(t);
  let registered = [], granted = true;
  f.preferences.voice = { version: 1, enabled: false };
  f.globals.readVoiceEnabled = async () => f.preferences.voice?.enabled === true;
  f.globals.setVoiceEnabled = async (enabled, operationId) => {
    f.preferences.voice = { version: 1, enabled, operationId };
    f.chrome.storage.onChanged.emit({ voice: { newValue: f.preferences.voice } }, 'local');
  };
  f.chrome.permissions.contains = async () => granted;
  f.chrome.scripting.getRegisteredContentScripts = async () => registered;
  f.chrome.scripting.registerContentScripts = async scripts => { registered = scripts; };
  f.chrome.scripting.unregisterContentScripts = async () => { registered = []; };
  f.chrome.scripting.executeScript = async () => {};
  return { ...f, change: f.globals.changeWebVoiceEnabled, state: f.globals.readWebVoiceState,
    grant(value) { granted = value; }, registered: () => registered };
}

test('toolbar first ON waits for consent and registers only after grant without creating capture', async t => {
  const f = await settingsFixture(t);
  let grant;
  const enabling = f.change(true, new Promise(resolve => { grant = resolve; }));
  await turn();
  assert.equal((await f.state()).enabled, false); assert.equal((await f.state()).pending, true);
  assert.equal(f.preferences.voice.enabled, false); assert.equal(f.registered().length, 0);
  await f.change(true, Promise.resolve(true)); // repeated clicks do not spawn an operation
  grant(true); await enabling;
  assert.equal((await f.state()).enabled, true); assert.equal(f.registered().length, 1);
  assert.equal(f.created.length, 0, 'enabling controls must never start capture or inference');
  await f.change(false);
  assert.equal(f.preferences.voice.enabled, false); assert.equal(f.registered().length, 0);
  assert.equal((await f.state()).enabled, false);
});

for (const failure of ['denied', 'permission rejection', 'permission inspection', 'ON write', 'registration']) test(`toolbar ${failure} cannot display enabled and a retry succeeds`, async t => {
  const f = await settingsFixture(t);
  const save = f.globals.setVoiceEnabled, contains = f.chrome.permissions.contains, register = f.chrome.scripting.registerContentScripts;
  if (failure === 'permission inspection') f.chrome.permissions.contains = async () => { throw Error('Permission inspection failed'); };
  if (failure === 'ON write') f.globals.setVoiceEnabled = async (enabled, id) => { if (enabled) throw Error('Write failed'); await save(enabled, id); };
  if (failure === 'registration') f.chrome.scripting.registerContentScripts = async () => { throw Error('Registration failed'); };
  const permission = failure === 'permission rejection' ? Promise.reject(Error('Gesture required')) : Promise.resolve(failure !== 'denied');
  const operation = f.change(true, permission);
  if (failure === 'denied') await operation; else await assert.rejects(operation);
  assert.equal((await f.state().catch(() => ({ enabled: false }))).enabled, false);
  assert.equal(f.preferences.voice.enabled, false); assert.equal(f.registered().length, 0);
  f.globals.setVoiceEnabled = save; f.chrome.permissions.contains = contains; f.chrome.scripting.registerContentScripts = register;
  await f.change(true, Promise.resolve(true)); assert.equal((await f.state()).enabled, true);
});

for (const interruption of ['external OFF', 'permission removal']) test(`${interruption} cancels a pending toolbar grant`, async t => {
  const f = await settingsFixture(t); let finish;
  const enabling = f.change(true, new Promise(resolve => { finish = resolve; }));
  if (interruption === 'external OFF') await f.globals.setVoiceEnabled(false, 'external');
  else { f.grant(false); f.chrome.permissions.onRemoved.emit({ origins: ['https://*/*'] }); }
  finish(true); await enabling;
  assert.equal(f.preferences.voice.enabled, false); assert.equal(f.registered().length, 0);
  assert.equal((await f.state()).enabled, false);
});

test('OFF aborts capture immediately even when persistence fails, unregisters, and permits retry', async t => {
  const f = await settingsFixture(t); await f.change(true, Promise.resolve(true));
  const control = f.control(1); await turn(); await f.start(control); const host = await f.host();
  const save = f.globals.setVoiceEnabled;
  f.globals.setVoiceEnabled = async () => { throw Error('Storage unavailable'); };
  const disabling = f.change(false);
  assert.equal(host.sent.at(-1).type, 'abort'); assert.equal(control.sent.at(-1).type, 'disabled');
  await assert.rejects(disabling, /Could not save OFF/); await turn();
  assert.equal(f.registered().length, 0); assert.equal((await f.state()).enabled, false);
  assert.equal(f.preferences.voice.enabled, true, 'a failed write must not be claimed as persisted OFF');
  f.globals.setVoiceEnabled = save; await f.change(false);
  assert.equal(f.preferences.voice.enabled, false); assert.equal((await f.state()).pending, false);
});

test('a newer opt-in is preserved when an older toolbar permission request fails', async t => {
  const f = await settingsFixture(t); let reject;
  const enabling = f.change(true, new Promise((_, fail) => { reject = fail; }));
  await f.globals.setVoiceEnabled(true, 'newer-owner');
  reject(Error('Old request failed')); await assert.rejects(enabling, /Old request failed/);
  assert.equal(f.preferences.voice.enabled, true); assert.equal(f.preferences.voice.operationId, 'newer-owner');
});

test('consent fallback rejects forged, stale and worker-restart tokens', async t => {
  const f = await settingsFixture(t);
  const sender = { id: 'extension', url: 'chrome-extension://extension/extension/web-voice-consent.html' };
  const message = (message, from = sender) => new Promise(resolve => f.chrome.runtime.onMessage.emit(message, from, resolve));
  assert.match((await message({ type: 'web-voice-set-enabled', enabled: true, granted: true, token: 'old-worker' })).error, /setting changed/);
  const { token } = await message({ type: 'web-voice-consent-begin' });
  await f.globals.setVoiceEnabled(false, 'newer-off');
  assert.match((await message({ type: 'web-voice-set-enabled', enabled: true, granted: true, token })).error, /setting changed/);
  const fresh = await message({ type: 'web-voice-consent-begin' });
  assert.equal((await message({ type: 'web-voice-set-enabled', enabled: true, granted: true, token: fresh.token })).ok, true);
  assert.equal((await f.state()).enabled, true);
});

for (const unreadable of [false, true]) test(`a newer ON survives an older failed OFF with ${unreadable ? 'unreadable' : 'readable'} storage`, async t => {
  const f = await settingsFixture(t); await f.change(true, Promise.resolve(true));
  const save = f.globals.setVoiceEnabled, get = f.chrome.storage.local.get;
  let failOFF;
  f.globals.setVoiceEnabled = () => new Promise((_, reject) => { failOFF = reject; });
  const disabling = f.change(false); await turn();
  await save(true, 'newer-on');
  if (unreadable) f.chrome.storage.local.get = async () => { throw Error('Read unavailable'); };
  failOFF(Error('Older OFF failed')); await assert.rejects(disabling, /Older OFF failed/);
  f.chrome.storage.local.get = get; f.globals.setVoiceEnabled = save;
  assert.equal(f.preferences.voice.operationId, 'newer-on'); assert.equal(f.preferences.voice.enabled, true);
  assert.equal((await f.state()).enabled, true);
});
