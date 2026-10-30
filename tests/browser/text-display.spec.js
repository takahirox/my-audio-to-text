import { test, expect } from '@playwright/test';

test('shared TEXT formatter, accumulator and pure sink compose grouped and independent streams', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js'), { TEXT } = await import('/port-contracts.js');
    const { TextToDOMNode } = await import('/dom-nodes.js');
    const { TextFormatterNode, TextAccumulatorNode, LiveTextDisplayNode } = await import('/text-nodes.js');
    let grouped, independent, current, history;
    const pipeline = new Pipeline({ nodes: {
      grouped: { outputs: { a: TEXT, b: TEXT }, start(c) { grouped = c.emitOutputs; } },
      independent: { outputs: { text: TEXT }, start(c) { independent = c.emit; } },
      formatter: new TextFormatterNode({ inputCount: 6, template: '{1}\n{5}\n{6}\n{{escaped}}' }),
      currentDOM: new TextToDOMNode(), historyDOM: new TextToDOMNode(), accumulator: new TextAccumulatorNode(), current: new LiveTextDisplayNode(text => current = text.textContent), history: new LiveTextDisplayNode(text => history = text.textContent),
    }, connections: [
      { from: ['grouped', 'a'], to: ['formatter', 'input1'] }, { from: ['grouped', 'b'], to: ['formatter', 'input5'] },
      { from: ['independent', 'text'], to: ['formatter', 'input6'] },
      { from: ['formatter', 'text'], to: ['currentDOM', 'text'] }, { from: ['currentDOM', 'dom'], to: ['current', 'dom'] }, { from: ['formatter', 'text'], to: ['accumulator', 'append'] },
      { from: ['accumulator', 'text'], to: ['historyDOM', 'text'] }, { from: ['historyDOM', 'dom'], to: ['history', 'dom'] },
    ] });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    await pipeline.start(); grouped({ a: '<b>A</b>', b: '{1}' }); await flush();
    independent('text', 'C'); await flush(); independent('text', ''); await flush();
    await pipeline.stop(); await pipeline.dispose();
    return { current, history, errors: pipeline.errors.map(e => e.message) };
  });
  expect(result).toEqual({ current: '<b>A</b>\n{1}\n\n{escaped}', history: ['<b>A</b>\n{1}\n\n{escaped}', '<b>A</b>\n{1}\nC\n{escaped}', '<b>A</b>\n{1}\n\n{escaped}'].join('\n'), errors: [] });
});

test('accumulator exact values, Stop/Cancel and fresh session in browser engines', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { TextAccumulatorNode } = await import('/text-nodes.js');
    const states = [], node = new TextAccumulatorNode(), c = { signal: new AbortController().signal, emit: (_, text) => states.push(text) };
    node.start(c); const expected = [], invariants = [];
    for (const final of ['  <img src=x>\n&  ', 'same', 'same', '', '']) {
      node.receiveInputs({ append: final }, c); expected.push(final); invariants.push(states.at(-1) === expected.join('\n'));
    }
    node.stop(c); const stopped = states.at(-1);
    const count = states.length; const canceled = node.cancel(); node.dispose();
    const noCancelPublication = states.length === count; node.start(c);
    return { invariants, stopped, canceled, noCancelPublication, fresh: states.at(-1), first: states[0] };
  });
  expect(result.invariants.every(Boolean)).toBe(true);
  const history = ['  <img src=x>\n&  ', 'same', 'same', '', ''].join('\n');
  expect(result.stopped).toBe(history); expect(result.canceled).toBe(history); expect(result.noCancelPublication).toBe(true);
  expect(result.fresh).toBe(''); expect(result.first).toBe('');
});

for (const operation of ['stop', 'cancel']) test(`explicit ASR history/tail DOM branches clear finalized and canceled previews (${operation})`, async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async operation => {
    const { Pipeline } = await import('/pipeline.js');
    const { SpeechToTextZipformerEnNode } = await import('/zipformer-node.js');
    const { TextAccumulatorNode, LiveTextDisplayNode } = await import('/text-nodes.js');
    const { TextToDOMNode, DOMCombinerNode } = await import('/dom-nodes.js');
    const speech = new SpeechToTextZipformerEnNode(), acc = new TextAccumulatorNode(), snapshots = {};
    speech.core = { state: 'ready', load() { speech.receiveEvent({ type: 'ready' }); }, start() {}, stop() { speech.receiveEvent({ type: 'stopped' }); }, release() {} };
    const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
    const pipeline = new Pipeline({ nodes: { speech, acc, history: new TextToDOMNode(), preview: new TextToDOMNode(), combined: new DOMCombinerNode(),
      a: new LiveTextDisplayNode(dom => snapshots.a = dom.textContent), b: new LiveTextDisplayNode(dom => snapshots.b = dom.textContent) }, connections: [
      edge('speech', 'final', 'acc', 'append'), edge('acc', 'text', 'history', 'text'), edge('speech', 'provisional', 'preview', 'text'),
      edge('history', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'), edge('combined', 'dom', 'a', 'dom'), edge('combined', 'dom', 'b', 'dom'),
    ] });
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    await pipeline.start();
    const event = (type, id, text) => speech.receiveEvent({ type, id, text });
    event('partial', 0, 'old'); event('partial', 0, 'replaced'); await tick(); const preview = snapshots.a;
    event('final', 0, 'same'); event('partial', 0, 'stale'); await tick(); const first = snapshots.a;
    event('partial', 1, 'new'); event('final', 0, 'duplicate'); await tick(); const newer = snapshots.a;
    event('final', 1, 'same'); event('final', 2, ''); event('partial', 2, 'late'); await tick(); const finalized = snapshots.a;
    event('partial', 3, 'discard'); await tick(); await pipeline[operation]();
    event('partial', 3, 'late'); await tick();
    return { preview, first, newer, finalized, snapshots, committed: acc.committed, count: acc.count, errors: pipeline.errors.map(e => e.message) };
  }, operation);
  expect(result).toEqual({ preview: 'replaced', first: 'same', newer: 'samenew', finalized: 'same\nsame\n', snapshots: { a: 'same\nsame\n', b: 'same\nsame\n' }, committed: 'same\nsame\n', count: 3, errors: [] });
});
