import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabTranscriptionPipeline } from '../web/transcription-nodes.js';
import { LocalAsrCore } from '../web/local-asr-core.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const values = [], errors = [], workers = [];
  let capture;
  const flow = createTabTranscriptionPipeline({
    onTranscript: (port, value) => values.push([port, value]),
    onError: error => errors.push(error),
    sourceFactory(audio, ended) {
      capture = { audio, ended, start() {},
        stop(flush = true) { if (flush) audio(new Float32Array(37).fill(0.05)); },
      };
      return capture;
    },
    workerFactory(path) {
      const worker = { path, messages: [], terminated: false,
        postMessage(message, transfer = []) { this.messages.push(structuredClone(message, { transfer })); },
        terminate() { this.terminated = true; },
        reply(data) { this.onmessage({ data }); },
      };
      workers.push(worker); return worker;
    },
  });
  const load = async () => {
    const loading = flow.speech.load();
    workers.forEach(worker => worker.reply({ type: 'ready' })); await loading;
    await flow.pipeline.start();
  };
  const decodes = () => workers[0].messages.filter(m => m.type === 'decode');
  const classify = () => {
    const message = workers[1].messages.filter(m => m.type === 'vad-audio').at(-1);
    workers[1].reply({ type: 'vad', session: message.session,
      frames: [{ audio: message.audio, speaking: true }] });
  };
  const finish = (index, text) => {
    const request = decodes()[index];
    workers[0].reply({ type: request.final ? 'final' : 'partial', id: request.id, session: request.session, text });
    workers[0].reply({ type: 'decoded', session: request.session });
  };
  return { ...flow, values, errors, workers, load, decodes, classify, finish, get capture() { return capture; } };
}

test('real ASR adapter exposes provisional/final through one core and drains the final capture tail', async () => {
  const f = fixture(); assert.ok(f.speech.core instanceof LocalAsrCore); await f.load();
  assert.deepEqual(f.workers.map(w => w.path), ['./sherpa-worker.js', './silero-worker.js']);
  const pcm = new Float32Array(8000).fill(0.05);
  f.capture.audio(pcm); await tick(); f.classify(); f.finish(0, 'provisional'); await tick();
  assert.equal(pcm.length, 8000, 'fan-out payload ownership remains with caller');
  assert.deepEqual(f.values, [['provisional', { text: 'provisional', id: 1 }]]);
  let drained = false; const stopping = f.pipeline.stop().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); f.classify();
  const stop = f.workers[1].messages.find(m => m.type === 'vad-stop');
  f.workers[1].reply({ type: 'vad-stopped', session: stop.session });
  assert.equal(f.decodes()[1].audio.length, 8037);
  f.finish(1, ' '); await stopping;
  assert.deepEqual(f.values.at(-1), ['final', { text: 'provisional', id: 1 }]);
  assert.equal(f.pipeline.state, 'stopped'); assert.equal(f.workers.length, 2);
  await f.pipeline.dispose(); assert.ok(f.workers.every(w => w.terminated));
});

for (const phase of ['load', 'running', 'draining']) {
  test(`ASR disposal during ${phase} releases workers and rejects stale outputs into a replacement pipeline`, async () => {
    const f = fixture();
    let pending;
    if (phase === 'load') pending = f.pipeline.start().catch(error => error);
    else {
      await f.load(); f.capture.audio(new Float32Array(8000).fill(0.05)); await tick(); f.classify();
      if (phase === 'draining') pending = f.pipeline.stop();
    }
    await tick(); const callbacks = f.workers.map(w => w.onmessage);
    await f.pipeline.dispose(); if (pending) await pending;
    assert.ok(f.workers.every(w => w.terminated));
    const replacement = fixture(); await replacement.load();
    f.capture?.audio(new Float32Array(8000)); f.capture?.ended();
    for (const callback of callbacks) callback({ data: { type: 'final', text: 'stale', id: 1, session: 1 } });
    await tick(); assert.deepEqual(f.values, []); assert.deepEqual(replacement.values, []);
    await replacement.pipeline.dispose();
  });
}

for (const phase of ['load', 'running', 'draining']) {
  test(`ASR ${phase} errors propagate and allow immediate resource cleanup`, async () => {
    const f = fixture();
    if (phase === 'load') {
      const loading = f.pipeline.start(); await tick();
      f.workers[0].reply({ type: 'error', message: 'controlled load failure' });
      await assert.rejects(loading, /controlled load failure/);
    } else {
      await f.load();
      const stopping = phase === 'draining' ? f.pipeline.stop() : null;
      await tick();
      f.workers[0].reply({ type: 'error', message: 'controlled inference failure' });
      await assert.rejects(stopping || f.pipeline.stop(), AggregateError);
    }
    assert.equal(f.errors.length, 1); assert.ok(f.workers.every(w => w.terminated));
    await f.pipeline.dispose();
  });
}
