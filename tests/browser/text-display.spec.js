import { test, expect } from '@playwright/test';

test('shared TEXT formatter, accumulator and pure sink compose grouped and independent streams', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js'), { TEXT } = await import('/port-contracts.js');
    const { TextFormatterNode, TextAccumulatorNode, LiveTextDisplayNode } = await import('/text-nodes.js');
    let grouped, independent, current, history;
    const pipeline = new Pipeline({ nodes: {
      grouped: { outputs: { a: TEXT, b: TEXT }, start(c) { grouped = c.emitOutputs; } },
      independent: { outputs: { text: TEXT }, start(c) { independent = c.emit; } },
      formatter: new TextFormatterNode({ inputCount: 6, template: '{1}\n{5}\n{6}\n{{escaped}}' }),
      accumulator: new TextAccumulatorNode(), current: new LiveTextDisplayNode(text => current = text), history: new LiveTextDisplayNode(text => history = text),
    }, connections: [
      { from: ['grouped', 'a'], to: ['formatter', 'input1'] }, { from: ['grouped', 'b'], to: ['formatter', 'input5'] },
      { from: ['independent', 'text'], to: ['formatter', 'input6'] },
      { from: ['formatter', 'text'], to: ['current', 'content'] }, { from: ['formatter', 'text'], to: ['accumulator', 'append'] },
      { from: ['accumulator', 'text'], to: ['history', 'content'] },
    ] });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    await pipeline.start(); grouped({ a: '<b>A</b>', b: '{1}' }); await flush();
    independent('text', 'C'); await flush(); independent('text', ''); await flush();
    await pipeline.stop(); await pipeline.dispose();
    return { current, history, errors: pipeline.errors.map(e => e.message) };
  });
  expect(result).toEqual({ current: '<b>A</b>\n{1}\n\n{escaped}', history: ['<b>A</b>\n{1}\n\n{escaped}', '<b>A</b>\n{1}\nC\n{escaped}', '<b>A</b>\n{1}\n\n{escaped}'].join('\n'), errors: [] });
});

test('accumulator exact values, grouped ordering, Stop/Cancel and fresh session in browser engines', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { TextAccumulatorNode } = await import('/text-nodes.js');
    const states = [], node = new TextAccumulatorNode(), c = { signal: new AbortController().signal, emit: (_, text) => states.push(text) };
    node.start(c); const expected = [], invariants = [];
    for (const final of ['  <img src=x>\n&  ', 'same', 'same', '', '']) {
      for (const preview of ['first', 'replaced', '']) {
        node.receive('preview', preview, c);
        invariants.push(states.at(-1) === expected.join('\n') + (preview ? (expected.length ? '\n' : '') + preview : ''));
      }
      node.receiveInputs({ append: final, preview: 'discard' }, c); expected.push(final); invariants.push(states.at(-1) === expected.join('\n'));
    }
    node.receive('preview', 'Stop preview', c); node.stop(c); const stopped = states.at(-1);
    node.receive('preview', 'Cancel preview', c); const count = states.length; const canceled = node.cancel(); node.dispose();
    const noCancelPublication = states.length === count; node.start(c);
    return { invariants, stopped, canceled, noCancelPublication, fresh: states.at(-1), first: states[0] };
  });
  expect(result.invariants.every(Boolean)).toBe(true);
  const history = ['  <img src=x>\n&  ', 'same', 'same', '', ''].join('\n');
  expect(result.stopped).toBe(history); expect(result.canceled).toBe(history); expect(result.noCancelPublication).toBe(true);
  expect(result.fresh).toBe(''); expect(result.first).toBe('');
});
