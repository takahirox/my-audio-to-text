import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, portContract } from '../web/pipeline.js';
import { TEXT } from '../web/translation-nodes.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { SYNTHESIZED_AUDIO, AudioOutputNode, audioToWav, validateSynthesizedAudio } from '../web/synthesized-audio.js';
import { japaneseFrontendToPhonemes } from '../web/kokoro-japanese.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(Node, reply = message => ({ type: message.type === 'load' ? 'ready' : message.type === 'generate' ? 'result' : 'drained',
  audio: { samples: new Float32Array([0, 0.5, -0.5]), sampleRate: Node === KokoroTextToSpeechNode ? 24000 : 44100, channels: 1 } })) {
  const output = [], errors = [], workers = []; let context;
  const node = new Node({ workerFactory(url) {
    const worker = { url, messages: [], terminated: 0, terminate() { this.terminated++; },
      postMessage(message) {
        this.messages.push(message); const value = reply(message);
        if (value) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ...value } }));
      },
    }; workers.push(worker); return worker;
  } });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(value) { context = value; } }, node,
    sink: new AudioOutputNode(async audio => { await tick(); output.push(audio); }),
  }, connections: [
    { from: ['source', 'text'], to: ['node', 'text'] },
    { from: ['node', 'audio'], to: ['sink', 'audio'] },
  ], onError: error => errors.push(error.message) });
  return { pipeline, node, workers, output, errors, emit: text => context.emit('text', text) };
}

for (const Node of [Supertonic3TextToSpeechNode, KokoroTextToSpeechNode]) {
  test(`${Node.name}: explicit ports, actual sample rate, repeated input, blank input and sink drain`, async () => {
    const f = fixture(Node);
    assert.deepEqual(f.node.inputs, { text: TEXT }); assert.deepEqual(f.node.outputs, { audio: SYNTHESIZED_AUDIO });
    await f.pipeline.start(); f.emit(' '); f.emit('こんにちは。'); f.emit('Hello.');
    await f.pipeline.stop(); assert.equal(f.output.length, 2);
    assert.equal(f.output[0].sampleRate, Node === KokoroTextToSpeechNode ? 24000 : 44100);
    assert.deepEqual(f.workers[0].messages.map(x => x.type), ['load', 'generate', 'generate', 'drain']);
    assert.ok(f.workers[0].url.pathname.endsWith(Node === KokoroTextToSpeechNode ? '/kokoro-worker.js' : '/supertonic3-worker.js'));
    await f.pipeline.dispose(); await f.pipeline.dispose(); assert.equal(f.workers[0].terminated, 1);
  });
  for (const phase of ['load', 'generate', 'drain']) {
    test(`${Node.name}: cancellation during ${phase} settles RPCs and discards late outputs`, async () => {
      const f = fixture(Node, message => message.type === phase ? null : { type: message.type === 'load' ? 'ready' : 'drained' });
      const starting = f.pipeline.start(), started = starting.catch(error => error);
      let stopping;
      if (phase !== 'load') await starting;
      if (phase === 'generate') f.emit('old');
      if (phase === 'drain') stopping = f.pipeline.stop();
      await tick();
      const worker = f.workers[0], callback = worker.onmessage, id = worker.messages.at(-1).id;
      await f.pipeline.dispose();
      if (phase === 'load') assert.equal((await started).name, 'AbortError');
      if (stopping) await stopping;
      callback({ data: { type: 'result', id, audio: { samples: new Float32Array([1]), sampleRate: 24000, channels: 1 } } });
      assert.equal(worker.terminated, 1); assert.equal(f.node.pending.size, 0); assert.deepEqual(f.output, []);
      const fresh = fixture(Node); await fresh.pipeline.start(); fresh.emit('fresh'); await fresh.pipeline.stop();
      assert.equal(fresh.output.length, 1); await fresh.pipeline.dispose();
    });
  }
  test(`${Node.name}: graceful Stop waits for in-flight inference and asynchronous player consumer`, async () => {
    const f = fixture(Node, message => message.type === 'generate' ? null : { type: message.type === 'load' ? 'ready' : 'drained' });
    await f.pipeline.start(); f.emit('slow'); await tick();
    let done = false; const stopping = f.pipeline.stop().then(() => { done = true; });
    await tick(); assert.equal(done, false);
    const worker = f.workers[0], id = worker.messages.at(-1).id;
    worker.onmessage({ data: { id, type: 'result', audio: { samples: new Float32Array([1]), sampleRate: 48000, channels: 1 } } });
    await stopping; assert.equal(f.output[0].sampleRate, 48000); await f.pipeline.dispose();
  });
  test(`${Node.name}: initialization/network failure, input validation, malformed audio and Worker crash`, async () => {
    const load = fixture(Node, () => ({ type: 'error', message: 'Offline cache miss' }));
    await assert.rejects(load.pipeline.start(), /Offline cache miss/); assert.equal(load.workers[0].terminated, 1);
    for (const input of [123, 'x'.repeat(301)]) {
      const f = fixture(Node); await f.pipeline.start(); f.emit(input);
      await assert.rejects(f.pipeline.stop(), AggregateError); assert.deepEqual(f.output, []); await f.pipeline.dispose();
    }
    for (const result of [{ type: 'result', audio: { samples: new Float32Array([NaN]), sampleRate: 0, channels: 2 } },
      { type: 'error', message: 'Inference failed' }, { type: 'unexpected' }]) {
      const f = fixture(Node, message => message.type === 'generate' ? result : { type: 'ready' });
      await f.pipeline.start(); f.emit('test'); await assert.rejects(f.pipeline.stop(), AggregateError);
      assert.equal(f.errors.length, 1); assert.deepEqual(f.output, []); assert.equal(f.workers[0].terminated, 1); await f.pipeline.dispose();
    }
    const f = fixture(Node); await f.pipeline.start(); f.workers[0].onerror({ message: 'Worker crash' });
    await assert.rejects(f.pipeline.stop(), AggregateError); assert.equal(f.errors.length, 1); assert.match(f.errors[0], /Worker crash/); await f.pipeline.dispose();
    const next = fixture(Node); await next.pipeline.start(); next.workers[0].postMessage = () => { throw Error('Transport failed'); };
    next.emit('test'); await assert.rejects(next.pipeline.stop(), AggregateError); await next.pipeline.dispose();
  });
}

test('generated audio is incompatible with bare captured PCM; contract and WAV preserve model rate', async () => {
  assert.throws(() => new Pipeline({ nodes: { source: { outputs: { audio: portContract('captured-pcm') } }, sink: new AudioOutputNode(() => {}) },
    connections: [{ from: ['source', 'audio'], to: ['sink', 'audio'] }] }), /contract/i);
  for (const rate of [24000, 44100]) {
    const blob = audioToWav({ samples: new Float32Array([-1, 0, 1]), sampleRate: rate, channels: 1 });
    const view = new DataView(await blob.arrayBuffer());
    assert.equal(view.getUint32(24, true), rate); assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(48, true), 32767);
  }
  for (const value of [new Float32Array([1]), { samples: new Float32Array(), sampleRate: 24000, channels: 1 },
    { samples: new Float32Array([Infinity]), sampleRate: 24000, channels: 1 }, { samples: [0], sampleRate: 24000, channels: 1 }]) {
    assert.throws(() => validateSynthesizedAudio(value), TypeError);
  }
});
test('unsupported model-specific settings are explicit', () => {
  assert.throws(() => new Supertonic3TextToSpeechNode({ language: 'fr' }), /Japanese.*English/);
  assert.throws(() => new Supertonic3TextToSpeechNode({ voice: 'unknown' }), /voice/);
  assert.throws(() => new KokoroTextToSpeechNode({ voice: 'unknown' }), /Japanese.*English/);
});
test('Japanese frontend fixture preserves word readings and punctuation', () => {
  assert.equal(japaneseFrontendToPhonemes([{ pron: 'コンニチワ' }, { string: '。' }]), 'koɲɲiʨiβa .');
  assert.equal(japaneseFrontendToPhonemes([{ pron: 'テンキ' }, { pron: 'デス' }, { string: '！' }]), 'teŋkʲi desɨ !');
});
