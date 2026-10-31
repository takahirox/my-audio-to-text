import { test, expect } from '@playwright/test';

test('browser TEXT window deadlines, Unicode bounds, fan-out, Stop and Cancel', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { TextWindowNode } = await import('/text-window-node.js');
    const { Pipeline } = await import('/pipeline.js');
    const { TEXT, NUMBER } = await import('/port-contracts.js');
    const runs = [];
    for (const cancel of [false, true]) {
      const windows = [], original = [], node = new TextWindowNode();
      let send;
      const pipeline = new Pipeline({ nodes: {
        source: { outputs: { text: TEXT, chars: NUMBER, wait: NUMBER }, start(c) { send = s => c.emit('text', s); c.emitOutputs({ chars: 7, wait: 0.03 }); } }, window: node,
        batches: { inputs: { text: TEXT }, receive(_, s) { windows.push(s); } },
        original: { inputs: { text: TEXT }, receive(_, s) { original.push(s); } },
      }, connections: [
        { from: ['source', 'text'], to: ['window', 'text'] },
        { from: ['source', 'chars'], to: ['window', 'maxChars'] }, { from: ['source', 'wait'], to: ['window', 'maxWaitSeconds'] }, { from: ['source', 'text'], to: ['original', 'text'] },
        { from: ['window', 'text'], to: ['batches', 'text'] },
      ] });
      await pipeline.start(); send('Hello'); send('world');
      await new Promise(r => setTimeout(r, 80));
      send('😀tail'); await new Promise(r => setTimeout(r, 0));
      if (cancel) await pipeline.cancel(); else { await pipeline.stop(); await pipeline.stop(); await pipeline.dispose(); }
      await new Promise(r => setTimeout(r, 50));
      runs.push({ cancel, windows, original, pending: node.pending });
    }
    return runs;
  });
  expect(result[0].windows).toEqual(['Hellowo', 'rld', '😀tail']);
  expect(result[1].windows).toEqual(['Hellowo', 'rld']);
  expect(result.every(r => r.pending === '')).toBe(true);
  for (const run of result) expect(run.original).toEqual(['Hello', 'world', '😀tail']);
});
