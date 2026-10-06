import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAsrCore } from '../web/local-asr-core.js';
import { ASR_CONFIG, SILERO_CONFIG } from '../web/local-asr-config.js';
import { PRE_ROLL, PREVIEW_INTERVAL, TRAILING_SILENCE, MAX_SPEECH, BUFFER_LIMIT } from '../web/reazon-simulation.js';

// Worker fixtures use the real transferable-message semantics. Replies are
// controlled independently to model slow inference and concurrent VAD work.
function fixture() {
  const events = [], workers = [];
  const core = new LocalAsrCore(event => events.push(event), { workerFactory(path) {
    const worker = {
      path, messages: [], terminated: false,
      postMessage(message, transfer = []) { this.messages.push(structuredClone(message, { transfer })); },
      terminate() { this.terminated = true; },
      reply(data) { this.onmessage({ data }); },
    };
    workers.push(worker); return worker;
  } });
  core.load();
  const [asr, vad] = workers;
  const ready = () => { asr.reply({ type: 'ready' }); vad.reply({ type: 'ready' }); };
  const replies = (type) => events.filter(e => e.type === type);
  const decodes = () => asr.messages.filter(m => m.type === 'decode');
  function classify() {
    const message = vad.messages.filter(m => m.type === 'vad-audio').at(-1);
    vad.reply({ type: 'vad', session: message.session,
      frames: [{ audio: message.audio, speaking: message.audio.some(sample => sample !== 0) }] });
  }
  function feed(length, value = 0.05) { core.push(new Float32Array(length).fill(value)); classify(); }
  function finish(index = decodes().length - 1, text = 'recognized') {
    const message = decodes()[index];
    asr.reply({ type: message.final ? 'final' : 'partial', id: message.id, session: message.session, text });
    asr.reply({ type: 'decoded', session: message.session });
  }
  function stopped() {
    const message = vad.messages.filter(m => m.type === 'vad-stop').at(-1);
    vad.reply({ type: 'vad-stopped', session: message.session });
  }
  return { core, events, workers, asr, vad, ready, replies, decodes, classify, feed, finish, stopped };
}

test('core loads both isolated workers and exposes only retained configuration/status', () => {
  const f = fixture();
  assert.deepEqual(f.workers.map(w => w.path), ['./sherpa-worker.js', './silero-worker.js']);
  assert.throws(() => f.core.start(), /ready/);
  f.asr.reply({ type: 'configuration', model: 'ja-en', modelName: 'ReazonSpeech ja-en', numThreads: 1 });
  f.vad.reply({ type: 'progress', message: 'loading Silero' });
  f.asr.reply({ type: 'ready' }); assert.equal(f.replies('ready').length, 0);
  f.vad.reply({ type: 'ready' }); assert.equal(f.replies('ready').length, 1);
  assert.equal(f.replies('configuration')[0].model, ASR_CONFIG.model);
  assert.equal(f.replies('progress')[0].message, 'loading Silero');
  assert.deepEqual([PRE_ROLL, PREVIEW_INTERVAL, TRAILING_SILENCE, MAX_SPEECH, BUFFER_LIMIT], [12800, 8000, 5600, 192000, 480000]);
  assert.equal(SILERO_CONFIG.sileroVad.threshold, 0.5);
  assert.equal(SILERO_CONFIG.sileroVad.windowSize, 512);
  f.core.release(); assert.ok(f.workers.every(w => w.terminated));
});

test('deterministic PCM preserves caller ownership, pre-roll, provisional and final lifecycle', () => {
  const f = fixture(); f.ready(); f.core.start();
  f.feed(3 * 16000, 0); assert.equal(f.decodes().length, 0);
  const source = new Float32Array(8002).fill(0.05), block = source.subarray(1, 8001);
  f.core.push(block); assert.equal(source.length, 8002); assert.equal(block.length, 8000);
  source.fill(1); f.classify();
  assert.equal(f.decodes()[0].audio.length, 20800);
  assert.ok(f.decodes()[0].audio.slice(0, PRE_ROLL).every(sample => sample === 0));
  assert.ok(f.decodes()[0].audio.slice(PRE_ROLL).every(sample => Math.abs(sample - 0.05) < 1e-6));
  f.finish(); assert.equal(f.replies('partial')[0].text, 'recognized');
  f.feed(TRAILING_SILENCE - 1, 0); assert.equal(f.decodes().length, 1);
  f.feed(1, 0); assert.equal(f.decodes()[1].audio.length, 26400);
  assert.deepEqual(f.replies('speech').map(e => [e.event, e.id]), [['started', 1], ['completed', 1]]);
  f.finish(); assert.equal(f.replies('final').length, 1);
  f.core.stop(); f.stopped();
  assert.equal(f.replies('stopped').length, 1);
  assert.equal(f.replies('diagnostics').at(-1).pendingSamples, 0);
});

test('busy inference coalesces previews, rejects an ended utterance preview, and prioritizes finals', () => {
  const f = fixture(); f.ready(); f.core.start(); f.feed(8000);
  for (let i = 0; i < 8; i++) f.feed(8000);
  assert.equal(f.decodes().length, 1);
  f.finish(); assert.equal(f.decodes()[1].audio.length, 72000);
  f.feed(5600, 0); f.feed(8000);
  f.finish(1, 'stale preview');
  assert.deepEqual(f.replies('partial').map(e => e.text), ['recognized']);
  assert.equal(f.decodes()[2].final, true);
  assert.equal(f.decodes()[2].audio.length, 77600);
  f.finish(2); assert.equal(f.decodes()[3].final, false);
  assert.equal(f.decodes()[3].audio.length, 8000);
});

test('maximum-duration finals preserve continuous speech without repeating pre-roll', () => {
  const f = fixture(); f.ready(); f.core.start(); f.feed(PRE_ROLL, 0);
  f.feed(MAX_SPEECH); assert.equal(f.decodes()[0].audio.length, MAX_SPEECH + PRE_ROLL);
  f.finish(); f.feed(MAX_SPEECH); assert.equal(f.decodes()[1].audio.length, MAX_SPEECH);
  f.finish(); f.feed(37); f.core.stop(); f.stopped();
  assert.equal(f.decodes()[2].audio.length, 37); f.finish();
  assert.equal(f.replies('final').length, 3); assert.equal(f.replies('stopped').length, 1);
});

test('Stop waits for VAD tail and finals, suppresses previews, drains once and supports repeat', () => {
  const f = fixture(); f.ready(); f.core.start(); f.feed(8000);
  // Input sent before Stop may still be waiting for VAD, including a short tail.
  f.core.push(new Float32Array(37).fill(0.05)); f.core.stop(); f.core.stop();
  f.classify(); f.stopped(); assert.equal(f.replies('stopped').length, 0);
  f.finish(0); assert.equal(f.replies('partial').length, 0);
  assert.equal(f.decodes()[1].audio.length, 8037);
  f.finish(1, ''); assert.equal(f.replies('final')[0].text, '');
  assert.equal(f.replies('stopped').length, 1);
  f.stopped(); f.core.stop(); assert.equal(f.replies('stopped').length, 1);
  f.core.start(); f.core.stop(); f.stopped();
  assert.equal(f.replies('stopped').length, 2); assert.equal(f.decodes().length, 2);
});

for (const duringStop of [false, true]) {
  test(`release ${duringStop ? 'during Stop' : 'during recognition'} rejects old callbacks and sessions`, () => {
    const f = fixture(); f.ready(); f.core.start(); f.feed(8000);
    const oldSession = f.decodes()[0].session, callbacks = f.workers.map(w => w.onmessage);
    if (duringStop) f.core.stop();
    f.core.release(); f.core.release(); assert.ok(f.workers.every(w => w.terminated));
    f.core.load(); const [asr, vad] = f.workers.slice(-2);
    asr.reply({ type: 'ready' }); vad.reply({ type: 'ready' }); f.core.start();
    const count = f.events.length;
    for (const type of ['partial', 'final', 'decoded', 'vad', 'vad-stopped', 'error', 'ready', 'configuration']) {
      const data = { type, id: 1, text: 'old', message: 'old error', session: oldSession };
      for (const callback of callbacks) callback({ data });
      asr.reply(data); vad.reply(data);
    }
    assert.equal(f.events.length, count);
    f.core.push(new Float32Array(8000)); assert.equal(vad.messages.at(-1).type, 'vad-audio');
  });
}

test('repeat rejects previous session results on retained workers', () => {
  const f = fixture(); f.ready(); f.core.start(); f.feed(8000); f.core.stop(); f.stopped();
  f.finish(0); f.finish(1); const oldSession = f.decodes()[0].session;
  f.core.start(); const count = f.events.length;
  f.asr.reply({ type: 'final', id: 1, text: 'old', session: oldSession });
  f.vad.reply({ type: 'error', message: 'old failure', session: oldSession });
  assert.equal(f.events.length, count);
  f.feed(8000); f.finish(2); assert.equal(f.replies('partial').length, 1);
});

test('backpressure includes VAD and queued inference and releases a stalled pipeline', () => {
  const f = fixture(); f.ready(); f.core.start(); f.feed(8000);
  for (let i = 0; i < 29; i++) f.feed(16000);
  f.feed(8000); assert.equal(f.replies('error').length, 0);
  f.core.push(new Float32Array(1));
  assert.match(f.replies('error')[0].message, /over 30 seconds behind/);
  assert.ok(f.workers.every(w => w.terminated));
  const vad = fixture(); vad.ready(); vad.core.start();
  vad.core.push(new Float32Array(BUFFER_LIMIT)); vad.core.push(new Float32Array(1));
  assert.match(vad.replies('error')[0].message, /over 30 seconds behind/);
});

for (const role of ['asr', 'vad']) {
  for (const mechanism of ['message', 'exception']) {
    test(`${role} ${mechanism} errors release both workers and emit an error once`, () => {
      const f = fixture(); f.ready(); f.core.start(); f.feed(8000);
      if (mechanism === 'message') f[role].reply({ type: 'error', session: f.core.session, message: 'controlled failure' });
      else f[role].onerror({ preventDefault() {}, message: 'controlled failure' });
      assert.equal(f.replies('error').length, 1); assert.ok(f.workers.every(w => w.terminated));
      f.finish(); assert.equal(f.replies('partial').length, 0);
    });
  }
}

test('worker construction, posting and input errors release allocated resources', () => {
  let terminated = false; const events = [];
  const core = new LocalAsrCore(event => events.push(event), { workerFactory(path) {
    if (path.includes('silero')) throw new Error('worker creation failed');
    return { terminate() { terminated = true; } };
  } });
  core.load(); assert.ok(terminated); assert.match(events[0].message, /creation failed/);
  const posting = fixture(); posting.ready(); posting.core.start();
  posting.vad.postMessage = () => { throw new Error('posting failed'); };
  posting.core.push(new Float32Array(1)); assert.match(posting.replies('error')[0].message, /posting failed/);
  const input = fixture(); input.ready(); input.core.start(); input.core.push([0]);
  assert.match(input.replies('error')[0].message, /Float32Array/);
});
