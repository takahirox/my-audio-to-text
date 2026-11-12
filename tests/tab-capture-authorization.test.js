import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTabCaptureBridge } from '../extension/tab-capture-background.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
function fixture() {
  const values = {}, sent = [], idle = []; let started = 0;
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onConnect: event() },
    storage: { session: {
      async get(key) { return key === null ? { ...values } : { [key]: values[key] }; },
      async set(entries) { Object.assign(values, entries); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    } },
    tabs: { onRemoved: event(), onUpdated: event() }, windows: { onRemoved: event() },
  };
  const bridge = installTabCaptureBridge({ ensureHost: async () => { started++; }, hostPost: message => sent.push(message), idleCleanup: () => idle.push(true) }, chrome);
  function connect({ session = 'a', tabId = 42, url = `chrome-extension://extension/extension/recorder.html?session=${session}&tab=${tabId}`, senderId = 'extension' } = {}) {
    const port = { name: 'live-tab-audio', sender: { id: senderId, url }, messages: [], onMessage: event(), onDisconnect: event(),
      postMessage(message) { this.messages.push(message); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
    chrome.runtime.onConnect.emit(port); return port;
  }
  const grant = (session = 'a', tabId = 42, windowId = 10) => bridge.authorize(session, tabId, async () => ({ id: windowId }));
  return { bridge, chrome, connect, grant, values, sent, idle, started: () => started };
}

test('only toolbar capabilities for the original tab and exact extension Live URL can subscribe', async () => {
  const f = fixture(); await f.grant();
  assert.equal(f.started(), 0, 'toolbar launch and Ready are capture-free');
  const good = f.connect(); good.onMessage.emit({ type: 'subscribe', session: 'a', tabId: 42 }); await tick();
  assert.equal(f.started(), 1); assert.equal(f.sent[0].type, 'tab-subscribe'); assert.equal(f.sent[0].tabId, 42);
  for (const options of [{ session:'unknown' }, { tabId:99 }]) {
    const port = f.connect(options); port.onMessage.emit({ type:'subscribe', session:options.session || 'a', tabId:options.tabId || 42 }); await tick();
    assert.match(port.messages[0].error, /not authorized/);
  }
  for (const options of [{ url:'https://example.org/extension/recorder.html?session=a&tab=42' }, { senderId:'other' }, { url:'chrome-extension://extension/extension/graph-library.html?session=a&tab=42' }]) {
    assert.equal(f.connect(options).disconnected, true);
  }
  assert.equal(f.started(), 1);
});

test('only the selected authorized client may provide a one-use stream ID; PCM and ACK stay session scoped', async () => {
  const f = fixture(); await f.grant('a'); await f.grant('b');
  const a = f.connect(), b = f.connect({ session:'b' });
  a.onMessage.emit({ type:'subscribe', session:'a', tabId:42 }); b.onMessage.emit({ type:'subscribe', session:'b', tabId:42 }); await tick();
  const [sa,sb] = f.sent.filter(message => message.type === 'tab-subscribe');
  f.bridge.message({ type:'tab-stream-id', tabId:42, request:'request' });
  assert.equal(a.messages[0].type, 'acquire'); assert.equal(b.messages.length, 0);
  b.onMessage.emit({ type:'stream-id', request:'request', streamId:'forged' });
  assert.equal(f.sent.some(message=>message.streamId==='forged'), false);
  a.onMessage.emit({ type:'stream-id', request:'request', streamId:'one-use' });
  assert.equal(f.sent.at(-1).streamId,'one-use');
  f.bridge.message({ type:'tab-pcm', id:sa.id, sequence:0, pcm:[0.5] });
  assert.equal(a.messages.at(-1).type,'pcm'); assert.equal(b.messages.length,0);
  b.onMessage.emit({ type:'ack', sequence:0 }); assert.equal(f.sent.at(-1).id,sb.id);
  a.disconnect(); assert.equal(f.sent.at(-1).type,'tab-unsubscribe'); assert.equal(f.sent.at(-1).id,sa.id);
  assert.equal(f.bridge.clients.size,2,'retain DOM until offscreen acknowledges teardown');
  f.bridge.message({ type:'tab-ended', id:sa.id }); assert.equal(f.bridge.clients.size,1);
  f.bridge.disconnected(); assert.match(b.messages.at(-1).error,/host disconnected/); assert.equal(f.bridge.clients.size,0);
});

test('closing an ID issuer before its reply reassigns authorization to its subscribed same-tab peer', async () => {
  const f = fixture(); await f.grant('a'); await f.grant('b');
  const a=f.connect(),b=f.connect({session:'b'});
  a.onMessage.emit({type:'subscribe',session:'a',tabId:42}); b.onMessage.emit({type:'subscribe',session:'b',tabId:42}); await tick();
  f.bridge.message({type:'tab-stream-id',tabId:42,request:'r'}); a.disconnect();
  assert.equal(b.messages[0].type,'acquire');
  a.onMessage.emit({type:'stream-id',request:'r',streamId:'stale'});
  assert.equal(f.sent.some(message=>message.streamId==='stale'),false);
  b.onMessage.emit({type:'stream-id',request:'r',streamId:'current'}); assert.equal(f.sent.at(-1).streamId,'current');
});

test('navigation revokes existing grants without authorizing old windows again when another tab is invoked', async () => {
  const f=fixture(); await f.grant('a',42); await f.grant('b',99);
  f.chrome.tabs.onUpdated.emit(42,{status:'loading'}); await tick();
  await f.grant('c',99);
  const old=f.connect(); old.onMessage.emit({type:'subscribe',session:'a',tabId:42}); await tick();
  assert.match(old.messages[0].error,/not authorized/);
  assert.ok(f.values['live-tab-grant:b']); assert.ok(f.values['live-tab-grant:c']);
});

test('navigation during asynchronous toolbar launch cannot resurrect a revoked capability', async () => {
  const f=fixture(); let finish;
  const launch=f.bridge.authorize('a',42,()=>new Promise(resolve=>{finish=resolve;})); await tick();
  f.chrome.tabs.onUpdated.emit(42,{status:'loading'}); await tick();
  finish({id:10}); await launch;
  assert.equal(f.values['live-tab-grant:a'],undefined);
  // A genuinely later invocation for the navigated tab can authorize a new window.
  await f.grant('new',42); assert.ok(f.values['live-tab-grant:new']);
});

test('closing a Live window removes only its stored grant; late disconnect cannot release a replacement', async () => {
  const f=fixture(); await f.grant('a',42,10); await f.grant('b',42,11);
  f.chrome.windows.onRemoved.emit(10); await tick();
  assert.equal(f.values['live-tab-grant:a'],undefined); assert.ok(f.values['live-tab-grant:b']);
});

test('navigation rejects stale grants even while persistent revocation is still pending', async () => {
  const f=fixture(); await f.grant();
  const get=f.chrome.storage.session.get; let finish;
  f.chrome.storage.session.get=async key => key===null ? new Promise(resolve=>{finish=resolve;}) : get(key);
  f.chrome.tabs.onUpdated.emit(42,{status:'loading'});
  const old=f.connect(); old.onMessage.emit({type:'subscribe',session:'a',tabId:42}); await tick();
  assert.match(old.messages[0].error,/not authorized/); assert.equal(f.started(),0);
  finish({...f.values}); await tick();
});
