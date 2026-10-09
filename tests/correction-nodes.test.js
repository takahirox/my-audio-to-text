import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, TextOutputNode } from '../web/translation-nodes.js';
import { TRANSCRIPT } from '../web/transcription-nodes.js';
import { SpeechTranscriptCorrectionNode, FinalTranscriptTextNode } from '../web/correction-nodes.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}, respond = message => ({ type: message.type === 'load' ? 'ready' : message.type === 'drain' ? 'drained' : 'result', text: message.text + ' corrected' })) {
  const workers = [], output = [], original = [], errors = [], events = [];
  let context;
  const node = new SpeechTranscriptCorrectionNode({ ...options, onEvent: event => events.push(event), workerFactory(url) {
    const worker = { url, messages: [], terminated: 0,
      postMessage(message) {
        this.messages.push(message);
        const response = respond(message);
        if (response) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ...response } }));
      }, terminate() { this.terminated++; },
    }; workers.push(worker); return worker;
  } });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(value) { context = value; } }, node,
    candidate: new TextOutputNode(text => output.push(text)), original: new TextOutputNode(text => original.push(text)),
  }, connections: [
    { from: ['source', 'text'], to: ['original', 'text'] },
    { from: ['source', 'text'], to: ['node', 'text'] },
    { from: ['node', 'text'], to: ['candidate', 'text'] },
  ], onError: error => errors.push(error.message) });
  return { pipeline, node, workers, output, original, errors, events, emit: value => context.emit('text', value) };
}
test('plain TEXT identity, serial final texts, exactly one output including empty, drain and originals', async () => {
  const f = fixture({ language: 'ja' });
  assert.deepEqual(f.node.inputs, { text: TEXT }); assert.deepEqual(f.node.outputs, { text: TEXT });
  await f.pipeline.start(); for (const text of ['', ' ', 'first', 'second']) f.emit(text);
  await f.pipeline.stop();
  assert.deepEqual(f.output, ['', ' ', 'first corrected', 'second corrected']);
  assert.deepEqual(f.original, ['', ' ', 'first', 'second']);
  assert.deepEqual(f.workers[0].messages.map(m => m.type), ['load', 'correct', 'correct', 'drain']);
  assert.equal(f.workers[0].messages[0].language, 'ja');
  assert.equal(f.workers[0].url.pathname.endsWith('/qwen3-correction-worker.js'), true);
  await f.pipeline.dispose(); await f.pipeline.dispose(); assert.equal(f.workers[0].terminated, 1);
});
test('explicit final transcript adapter extracts text without mutating IDs or wiring provisional', async () => {
  const adapter = new FinalTranscriptTextNode(), outputs = [], original = [];
  const transcript = Object.freeze({ text: 'final', id: 42 });
  const graph = new Pipeline({ nodes: {
    source: { outputs: { provisional: TRANSCRIPT, final: TRANSCRIPT }, start(c) { c.emit('provisional', {text:'partial',id:42}); c.emit('final', transcript); } },
    adapter, sink: new TextOutputNode(text => outputs.push(text)),
    original: { inputs: { final: TRANSCRIPT }, receive(port, value) { original.push(value); } },
  }, connections: [
    { from: ['source', 'final'], to: ['adapter', 'final'] },
    { from: ['source', 'final'], to: ['original', 'final'] },
    { from: ['adapter', 'text'], to: ['sink', 'text'] },
  ] });
  await graph.start(); await graph.stop(); await graph.dispose();
  assert.deepEqual(outputs, ['final']); assert.equal(original[0], transcript);
  assert.throws(() => new Pipeline({ nodes: { source: {outputs:{final:TRANSCRIPT}}, correction:new SpeechTranscriptCorrectionNode() }, connections:[{from:['source','final'],to:['correction','text']}] }), /Incompatible/);
  assert.throws(() => adapter.receive('provisional', transcript, {}), /final transcript/);
});
test('disabled correction copies exactly without creating a Worker; node can also be omitted', async () => {
  const f = fixture({ enabled: false }); await f.pipeline.start(); f.emit('  I will not go.  ');
  await f.pipeline.stop(); await f.pipeline.dispose(); assert.deepEqual(f.output, f.original); assert.equal(f.workers.length, 0);
  const out = []; const graph = new Pipeline({ nodes: { source: {outputs:{text:TEXT},start(c){c.emit('text','original');}}, sink:new TextOutputNode(v=>out.push(v)) }, connections:[{from:['source','text'],to:['sink','text']}] });
  await graph.start(); await graph.stop(); await graph.dispose(); assert.deepEqual(out, ['original']);
});
for (const phase of ['load', 'correct', 'drain']) {
  test(`cancel during ${phase} settles pending work and ignores stale replies; fresh run succeeds`, async () => {
    const f = fixture({}, message => message.type === phase ? null : {type:message.type==='load'?'ready':message.type==='drain'?'drained':'result',text:'old'});
    const starting = f.pipeline.start(); const observed = starting.catch(e => e);
    if (phase !== 'load') { await starting; f.emit('old'); }
    await tick(); let stopping;
    if (phase === 'drain') { stopping = f.pipeline.stop(); await tick(); }
    const worker = f.workers[0], callback = worker.onmessage, id = worker.messages.at(-1).id;
    await f.pipeline.dispose(); if (phase === 'load') assert.equal((await observed).name, 'AbortError');
    if (stopping) await stopping;
    callback({data:{type:'result',id,text:'stale'}});
    assert.equal(worker.terminated, 1); assert.equal(f.node.pending.size, 0); assert.equal(f.output.includes('stale'), false);
    const next = fixture(); await next.pipeline.start(); next.emit('fresh'); await next.pipeline.stop(); await next.pipeline.dispose(); assert.deepEqual(next.output,['fresh corrected']);
  });
  test(`${phase} failure reports error by default and explicit bypass preserves originals`, async () => {
    for (const onFailure of ['error','bypass']) {
      const f = fixture({onFailure}, m => m.type === phase ? {type:'error',message:'Model failed'} : {type:m.type==='load'?'ready':m.type==='drain'?'drained':'result',text:m.text});
      if (phase==='load' && onFailure==='error') {
        await assert.rejects(f.pipeline.start(), /Model failed/); assert.equal(f.workers[0].terminated,1); continue;
      }
      await f.pipeline.start(); f.emit('original'); f.emit('next');
      if (onFailure==='error') await assert.rejects(f.pipeline.stop(), AggregateError);
      else { await f.pipeline.stop(); assert.deepEqual(f.output, ['original','next']); assert.equal(f.events.filter(e=>e.type==='bypass').length,phase==='correct'?2:1); }
      assert.deepEqual(f.original, ['original','next']); await f.pipeline.dispose(); assert.equal(f.workers[0].terminated,1);
    }
  });
}
test('stop waits for inference and candidate delivery', async () => {
  const f = fixture({}, m => m.type==='correct'?null:{type:m.type==='load'?'ready':'drained'});
  await f.pipeline.start(); f.emit('one'); await tick(); let stopped=false;
  const stopping=f.pipeline.stop().then(()=>stopped=true); await tick(); assert.equal(stopped,false);
  const request=f.workers[0].messages.at(-1); f.workers[0].onmessage({data:{type:'result',id:request.id,text:'one'}});
  await stopping; assert.deepEqual(f.output,['one']); await f.pipeline.dispose();
});
test('invalid/long inputs and invalid candidate fail safely; original branch survives', async () => {
  for (const value of [42, 'x'.repeat(501)]) {
    const f=fixture(); await f.pipeline.start(); f.emit(value); await assert.rejects(f.pipeline.stop(),AggregateError); assert.deepEqual(f.output,[]); await f.pipeline.dispose();
  }
  for (const text of [42, '', 'x'.repeat(1001), '<think>reasoning</think>one', '2']) {
    const f=fixture({},m=>({type:m.type==='load'?'ready':'result',text}));
    await f.pipeline.start(); f.emit('one'); await assert.rejects(f.pipeline.stop(),AggregateError); assert.deepEqual(f.original,['one']); assert.deepEqual(f.output,[]); await f.pipeline.dispose();
  }
});
test('Worker crash, messageerror and postMessage failure release resources', async () => {
  for (const type of ['onerror','onmessageerror','postMessage']) for (const onFailure of ['error','bypass']) {
    const f=fixture({onFailure}); await f.pipeline.start();
    if(type==='postMessage') f.workers[0].postMessage=()=>{throw Error('communication failed');};
    else f.workers[0][type]({message:'communication failed'});
    f.emit('original');
    if(onFailure==='error') await assert.rejects(f.pipeline.stop(),AggregateError);
    else {await f.pipeline.stop();assert.deepEqual(f.output,['original']);}
    await f.pipeline.dispose(); assert.equal(f.workers[0].terminated,1);
  }
});
test('fresh instance and explicit options required', async () => {
  for (const options of [{language:'fr'},{onFailure:'silent'}]) assert.throws(()=>new SpeechTranscriptCorrectionNode(options));
  const f=fixture();await f.pipeline.start();await f.pipeline.stop();await f.pipeline.dispose();
  await assert.rejects(f.node.start({signal:new AbortController().signal}),/fresh/);
});
