import { test, expect } from '@playwright/test';

test('shared TEXT formatter/display Nodes compose grouped and independent streams in the browser', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js');
    const { TEXT } = await import('/port-contracts.js');
    const { TextFormatterNode, LiveTextDisplayNode } = await import('/text-nodes.js');
    let grouped, independent;
    const current = new LiveTextDisplayNode(), history = new LiveTextDisplayNode(() => {}, { appendConnected: true });
    const pipeline = new Pipeline({ nodes: {
      grouped: { outputs: { a: TEXT, b: TEXT }, start(c) { grouped = c.emitOutputs; } },
      independent: { outputs: { text: TEXT }, start(c) { independent = c.emit; } },
      formatter: new TextFormatterNode({ template: '{1}\n{2}\n{3}\n{{escaped}}' }), current, history,
    }, connections: [
      { from: ['grouped', 'a'], to: ['formatter', 'input1'] }, { from: ['grouped', 'b'], to: ['formatter', 'input2'] },
      { from: ['independent', 'text'], to: ['formatter', 'input3'] },
      { from: ['formatter', 'text'], to: ['current', 'replace'] }, { from: ['formatter', 'text'], to: ['history', 'append'] },
    ] });
    const flush = async () => { await pipeline.entries.get('formatter').queue; await pipeline.entries.get('current').queue; await pipeline.entries.get('history').queue; };
    await pipeline.start(); grouped({ a: '<b>A</b>', b: '{1}' }); await flush();
    independent('text', 'C'); await flush(); independent('text', ''); await flush();
    await pipeline.stop(); await pipeline.dispose();
    return { current: current.preview, history: history.items, preview: history.preview, errors: pipeline.errors.map(e => e.message) };
  });
  expect(result).toEqual({ current: '<b>A</b>\n{1}\n\n{escaped}', history: ['<b>A</b>\n{1}\n\n{escaped}', '<b>A</b>\n{1}\nC\n{escaped}', '<b>A</b>\n{1}\n\n{escaped}'], preview: '', errors: [] });
});
