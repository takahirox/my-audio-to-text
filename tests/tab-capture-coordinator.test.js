import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabCaptureCoordinator } from '../extension/tab-capture-coordinator.js';
import { ExtensionTab } from '../extension/tab-source.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ pending = false, maxInFlight = 8 } = {}) {
  const sources = [], messages = [];
  const coordinator = new TabCaptureCoordinator((tabId, audio, ended) => {
    const grant = deferred(), release = deferred();
    const source = { tabId, audio, ended, grant, release, stops: [],
      start: () => pending ? grant.promise : Promise.resolve(),
      async drain() { return { audio: new Float32Array() }; },
      async stop(flush) { this.stops.push(flush); if (flush) audio(Float32Array.of(0.125)); await release.promise; },
    };
    release.resolve(); sources.push(source); return source;
  }, (id, message) => messages.push({ id, ...message }), { maxInFlight });
  return { coordinator, sources, messages, pcm: id => messages.filter(m => m.id === id && m.type === 'pcm') };
}

test('simultaneous starts coalesce, preserve startup frames and isolate buffers, tabs and late subscribers', async () => {
  const f = fixture({ pending: true }), c = f.coordinator;
  const starts = [c.subscribe('a', 42), c.subscribe('b', 42), c.subscribe('other', 99)];
  assert.equal(f.sources.length, 2);
  f.sources[0].audio(Float32Array.of(1));
  f.pcm('a')[0].pcm[0] = 999;
  assert.deepEqual(f.pcm('b')[0].pcm, [1]); assert.equal(f.pcm('other').length, 0);
  f.sources.forEach(source => source.grant.resolve()); await Promise.all(starts);
  await c.subscribe('late', 42); assert.equal(f.pcm('late').length, 0);
  f.sources[0].audio(Float32Array.of(2));
  assert.deepEqual(f.pcm('b').map(m => m.sequence), [0, 1]);
  assert.deepEqual(f.pcm('late').map(m => m.pcm), [[2]]);
  await c.unsubscribe('a'); assert.deepEqual(f.sources[0].stops, []);
  await c.unsubscribe('b', false); assert.deepEqual(f.sources[0].stops, []);
  await c.unsubscribe('late'); assert.deepEqual(f.sources[0].stops, [true]);
  assert.deepEqual(f.pcm('late').map(m => m.pcm), [[2], [0.125]]);
  assert.equal(c.tabs.has(99), true); await c.unsubscribe('other', false);
  assert.equal(c.tabs.size, 0); assert.equal(c.subscribers.size, 0);
});

test('last unsubscribe and reacquire wait for pending grant and release; canceled startup never revives', async () => {
  const f = fixture({ pending: true }), c = f.coordinator;
  const start = c.subscribe('old', 42); await tick();
  const stop = c.unsubscribe('old', false);
  const restart = c.subscribe('new', 42); await tick();
  assert.equal(f.sources.length, 1); assert.deepEqual(f.sources[0].stops, [false]);
  f.sources[0].grant.resolve(); await start; await stop; await tick();
  assert.equal(f.sources.length, 2);
  assert.equal(f.messages.some(m => m.id === 'old' && m.type === 'ready'), false);
  f.sources[1].grant.resolve(); await restart;
  assert.equal(f.pcm('new').length, 0); await c.unsubscribe('new', false);
});

test('cancel while waiting on an old teardown never creates a new capture', async () => {
  const f = fixture({ pending: true }), c = f.coordinator;
  const a = c.subscribe('a', 1); const stop = c.unsubscribe('a', false);
  const b = c.subscribe('b', 1); await c.unsubscribe('b', false);
  f.sources[0].grant.resolve(); await Promise.all([a, b, stop]);
  assert.equal(f.sources.length, 1); assert.equal(c.subscribers.size, 0);
});

test('slow consumer has a bounded queue and fails independently; ordered acknowledgments keep peers live', async () => {
  const f = fixture({ maxInFlight: 2 }), c = f.coordinator;
  await Promise.all([c.subscribe('slow', 42), c.subscribe('fast', 42)]);
  for (let i = 0; i < 6; i++) {
    f.sources[0].audio(Float32Array.of(i)); c.acknowledge('fast', i);
  }
  assert.equal(f.pcm('slow').length, 2); assert.equal(f.pcm('fast').length, 6);
  assert.match(f.messages.find(m => m.id === 'slow' && m.type === 'ended').error, /too slow/);
  assert.deepEqual(f.sources[0].stops, []); await c.unsubscribe('fast', false);
});

for (const mode of ['denial', 'ended', 'navigation', 'disconnect']) test(`${mode} notifies affected subscribers once and frees capture for retry`, async () => {
  const f = fixture({ pending: mode === 'denial' }), c = f.coordinator;
  const a = c.subscribe('a', 1), b = c.subscribe('b', 1);
  if (mode === 'denial') f.sources[0].grant.reject(Error('Permission denied'));
  else {
    await Promise.all([a, b]);
    if (mode === 'ended') f.sources[0].ended();
    if (mode === 'navigation') c.endTab(1, 'Source tab navigated');
    if (mode === 'disconnect') c.dispose();
  }
  await Promise.all([a, b]); await tick();
  assert.equal(c.tabs.size, 0); assert.equal(c.subscribers.size, 0);
  for (const id of ['a', 'b']) {
    const ends = f.messages.filter(m => m.id === id && m.type === 'ended');
    assert.equal(ends.length, 1); assert.ok(ends[0].error);
  }
  assert.deepEqual(f.sources[0].stops, [false]);
});

test('ending one captured tab leaves another tab running', async () => {
  const f = fixture(), c = f.coordinator;
  await Promise.all([c.subscribe('a', 1), c.subscribe('b', 2)]);
  c.endTab(1, 'closed'); await tick(); f.sources[1].audio(Float32Array.of(0.5));
  assert.equal(f.pcm('b').length, 1); assert.deepEqual(f.sources[1].stops, []);
  await c.unsubscribe('b', false);
});

function client() {
  const sent = [], listeners = {}, ended = [], audio = [];
  const port = { onMessage: { addListener(fn) { listeners.message = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage: message => sent.push(message), disconnect() { this.disconnected = true; } };
  const source = new ExtensionTab(42, pcm => audio.push(pcm), error => ended.push(error), {
    connect: () => port, url: 'chrome-extension://id/extension/recorder.html?session=capability&tab=42',
  });
  return { source, port, sent, ended, audio, receive: message => listeners.message(message), disconnect: () => listeners.disconnect() };
}

test('Live source is inert until Start, uses its original capability, accepts startup PCM and drains before Stop resolves', async () => {
  const f = client(); assert.deepEqual(f.sent, []);
  const start = f.source.start();
  assert.deepEqual(f.sent, [{ type: 'subscribe', session: 'capability', tabId: 42 }]);
  f.receive({ type: 'pcm', sequence: 0, pcm: [0.5] });
  f.receive({ type: 'ready' }); await start;
  assert.ok(f.audio[0] instanceof Float32Array);
  const stop = f.source.stop();
  f.receive({ type: 'pcm', sequence: 1, pcm: [0.25] });
  f.receive({ type: 'ended' }); await stop;
  assert.equal(f.audio.length, 2); assert.equal(f.ended.length, 0); assert.equal(f.port.disconnected, true);
});

test('Stop before Ready settles startup, discards canceled PCM, and disconnects without stale handlers', async () => {
  const f = client(), start = f.source.start();
  const rejection = assert.rejects(start, { name: 'AbortError' });
  const stop = f.source.stop(false);
  f.receive({ type: 'pcm', sequence: 0, pcm: [1] }); f.receive({ type: 'ended' });
  await stop; await rejection; assert.equal(f.audio.length, 0);
  f.receive({ type: 'ready' }); assert.equal(f.ended.length, 0);
});

test('host disconnect reports an actionable session-scoped error', async () => {
  const f = client(), start = f.source.start(); f.receive({ type: 'ready' }); await start;
  f.disconnect(); assert.match(f.ended[0].message, /connection lost/);
  await f.source.stop();
});

test('late subscribers trim pre-join samples from queued and partially buffered worklet frames', async () => {
  const sources = [], messages = [];
  const c = new TabCaptureCoordinator((tabId,audio) => {
    const source = { context:{currentTime:1}, start:async()=>{}, stop:async()=>{}, audio };
    sources.push(source); return source;
  }, (id,message)=>messages.push({id,...message}));
  await c.subscribe('first',42);
  sources[0].context.currentTime = 1.00025; // four 16 kHz samples later
  await c.subscribe('late',42);
  sources[0].audio(Float32Array.of(0,1),{capturedAt:1}); // queued before joining
  sources[0].audio(Float32Array.of(2,3,4,5,6,7),{capturedAt:1.000125});
  assert.deepEqual(messages.filter(m=>m.id==='first'&&m.type==='pcm').map(m=>m.pcm),[[0,1],[2,3,4,5,6,7]]);
  assert.deepEqual(messages.filter(m=>m.id==='late'&&m.type==='pcm').map(m=>m.pcm),[[4,5,6,7]]);
  await c.unsubscribe('first',false); await c.unsubscribe('late',false);
});

test('invalid acknowledgments fail only that subscriber without stopping a healthy peer', async () => {
  const f=fixture(),c=f.coordinator;
  await Promise.all([c.subscribe('bad',42),c.subscribe('healthy',42)]);
  f.sources[0].audio(Float32Array.of(1)); c.acknowledge('bad',8);
  assert.match(f.messages.find(m=>m.id==='bad'&&m.type==='ended').error,/Invalid tab audio acknowledgment/);
  c.acknowledge('healthy',0); f.sources[0].audio(Float32Array.of(2));
  assert.equal(f.pcm('healthy').length,2); assert.deepEqual(f.sources[0].stops,[]);
  await c.unsubscribe('healthy',false);
});

test('shared graceful Stop waits for a drain; Cancel removes only its subscriber immediately', async () => {
  const f = fixture(), c = f.coordinator, drain = deferred();
  await Promise.all([c.subscribe('a', 42), c.subscribe('b', 42)]);
  f.sources[0].drain = () => drain.promise;
  const stop = c.unsubscribe('a'); await tick();
  assert.equal(c.subscribers.has('a'), true);
  await c.unsubscribe('a', false);
  drain.resolve({ audio: Float32Array.of(0.25) }); await stop;
  assert.equal(f.pcm('a').length, 0);
  f.sources[0].audio(Float32Array.of(0.5));
  assert.deepEqual(f.pcm('b').map(m => m.pcm), [[0.5]]);
  assert.deepEqual(f.sources[0].stops, []);
  assert.equal(f.messages.filter(m => m.id === 'a' && m.type === 'ended').length, 1);
  await c.unsubscribe('b', false);
});

test('shared drain failures are reported only to the departing graph', async () => {
  const f = fixture(), c = f.coordinator;
  await Promise.all([c.subscribe('a', 42), c.subscribe('b', 42)]);
  f.sources[0].drain = async () => { throw Error('flush timed out'); };
  await c.unsubscribe('a');
  assert.match(f.messages.find(m => m.id === 'a' && m.type === 'ended').error, /flush timed out/);
  f.sources[0].audio(Float32Array.of(0.5));
  assert.deepEqual(f.pcm('b').map(m => m.pcm), [[0.5]]);
  assert.deepEqual(f.sources[0].stops, []);
  await c.unsubscribe('b', false);
});
