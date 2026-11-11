import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const code = await readFile(new URL('../extension/web-voice-capture.js', import.meta.url), 'utf8');
function fixture({ secure = true, policy = true, getMedia } = {}) {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const contexts = [], sent = [], failures = []; let requests = 0;
  class Context {
    constructor() { this.state = 'suspended'; contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const globals = { AudioContext: Context, isSecureContext: secure, document: { featurePolicy: { allowsFeature: () => policy } },
    navigator: { mediaDevices: { getUserMedia: options => { requests++; return getMedia ? getMedia(options) : Promise.resolve(stream); } } },
    setTimeout, clearTimeout, setInterval, clearInterval, DOMException, Uint8Array, Float32Array, performance, btoa };
  runInNewContext(code, globals);
  const capture = new globals.WebVoiceCapture(message => sent.push(message), message => { failures.push(message); void capture.stop(false); });
  return { capture, sent, failures, contexts, track, stream, requests: () => requests };
}
test('site microphone API is invoked synchronously and Cancel closes a late native grant', async () => {
  let grant; const f = fixture({ getMedia: () => new Promise(resolve => { grant = resolve; }) });
  const pending = f.capture.acquire(); assert.equal(f.requests(), 1);
  await f.capture.stop(false); assert.equal(f.contexts[0].state, 'closed');
  grant(f.stream); await pending; assert.equal(f.track.readyState, 'ended'); assert.equal(f.sent.length, 0);
});
for (const options of [{ secure: false }, { policy: false }]) test(`unsupported page fails locally before requesting microphone: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); await f.capture.acquire();
  assert.equal(f.requests(), 0); assert.match(f.failures[0], /HTTPS|Permissions Policy/); assert.equal(f.sent.length, 0);
});
for (const [name, recovery] of [['NotAllowedError', /website/], ['SecurityError', /Policy/], ['NotFoundError', /Connect/], ['NotReadableError', /device/], ['OverconstrainedError', /available/]]) test(`${name} reports page-specific recovery and closes its context`, async () => {
  const f = fixture({ getMedia: () => Promise.reject(new DOMException('Controlled failure', name)) });
  await f.capture.acquire(); assert.match(f.failures[0], recovery); assert.equal(f.contexts[0].state, 'closed');
});
test('long acknowledged transport retains no chunks; overload stops at the fixed bound', async () => {
  const f = fixture(); await f.capture.acquire();
  for (let i = 0; i < 10000; i++) { f.capture.chunk(new Float32Array([.25])); f.capture.ack(i); }
  assert.equal(f.capture.pending.size, 0); assert.equal(f.sent.at(-1).sequence, 9999);
  // A late duplicate acknowledgment cannot grant new credits.
  f.capture.ack(9999); assert.equal(f.capture.pending.size, 0);
  for (let i = 0; i < 9; i++) f.capture.chunk(new Float32Array([.25]));
  assert.equal(f.capture.pending.size, 8); assert.equal(f.sent.length, 10008);
  assert.match(f.failures[0], /too slow/); assert.equal(f.track.readyState, 'ended');
});

test('worklet downmixes stereo, flushes its exact tail and bounds a blocked main-thread queue', () => {
  let Worklet;
  const sent = [];
  class Processor { constructor() { this.port = { postMessage: data => sent.push(data) }; } }
  runInNewContext(code.match(/const worklet = `([\s\S]*?)`;/)[1], {
    AudioWorkletProcessor: Processor, Float32Array, currentTime: 0,
    registerProcessor: (_name, Class) => { Worklet = Class; },
  });
  const w = new Worklet(), stereo = [[new Float32Array(128).fill(.75), new Float32Array(128).fill(-.25)]];
  for (let i = 0; i < 11; i++) w.process(stereo);
  assert.equal(sent.length, 1); assert.equal(sent[0].audio.length, 1280); assert.ok(sent[0].audio.every(x => x === .25));
  w.port.onmessage({ data: 'ack' }); w.port.onmessage({ data: 'flush' });
  assert.equal(sent[1].audio.length, 128); assert.equal(sent[2], 'flushed');
  w.process(stereo); assert.equal(sent.length, 3);
  sent.length = 0; const blocked = new Worklet();
  for (let i = 0; i < 1000; i++) blocked.process(stereo);
  assert.equal(sent.filter(x => x.audio).length, 8); assert.equal(sent.at(-1), 'overflow'); assert.equal(blocked.pending, 8);
});
