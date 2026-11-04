import { test, expect } from '@playwright/test';

test('browser held TEXT samples FIFO through async completion; Stop and Cancel/restart', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js');
    const { HoldNode } = await import('/hold-node.js');
    const { TextFormatterNode } = await import('/text-nodes.js');
    const { TEXT } = await import('/port-contracts.js');
    const outputs = [], requests = [], pending = [];
    let send;
    const build = () => new Pipeline({ nodes: {
      source: { outputs: { text: TEXT }, start(c) { send = s => c.emit('text', s); } },
      hold: new HoldNode(), formatter: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }),
      update: { inputs: { text: TEXT }, outputs: { result: TEXT }, async receive(_, text, c) {
        requests.push(text); const result = await new Promise(resolve => pending.push(resolve)); c.emit('result', result);
      } },
      sink: { inputs: { text: TEXT }, receive(_, s) { outputs.push(s); } },
    }, connections: [
      { from: ['source', 'text'], to: ['formatter', 'input2'] }, { from: ['hold', 'value'], to: ['formatter', 'input1'] },
      { from: ['formatter', 'text'], to: ['update', 'text'] }, { from: ['update', 'result'], to: ['hold', 'input'] },
      { from: ['update', 'result'], to: ['sink', 'text'] },
    ] });
    const next = () => new Promise(resolve => setTimeout(resolve, 0));
    const p = build(); await p.start(); send('A'); send('B'); send('C'); await next();
    const first = [...requests]; pending.shift()('S1'); await next(); const second = [...requests];
    pending.shift()('same'); await next(); const third = [...requests];
    const stop = p.stop(); pending.shift()('same'); await stop; await p.dispose();
    const fresh = build(); await fresh.start(); send('cancel'); send('queued'); await next();
    await fresh.cancel(); pending.shift()('late'); await next();
    const restart = build(); await restart.start(); send('fresh'); await next();
    pending.shift()('S1'); await restart.stop(); await restart.dispose();
    return { first, second, third, requests, outputs };
  });
  expect(result.first).toEqual(['/A']);
  expect(result.second).toEqual(['/A', 'S1/B']);
  expect(result.third).toEqual(['/A', 'S1/B', 'same/C']);
  expect(result.requests).toEqual(['/A', 'S1/B', 'same/C', '/cancel', '/fresh']);
  expect(result.outputs).toEqual(['S1', 'same', 'same', 'S1']);
});

test('independent owned async output drains after feedback FIFO without delaying the next window', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js');
    const { HoldNode } = await import('/hold-node.js');
    const { TextFormatterNode } = await import('/text-nodes.js');
    const { TEXT } = await import('/port-contracts.js');
    const held = new HoldNode(), requests = [], jobs = [], outputs = [];
    let send;
    const p = new Pipeline({ nodes: {
      source: { outputs: { text: TEXT }, start(c) { send = text => c.emit('text', text); } }, held,
      formatter: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }),
      update: { inputs: { text: TEXT }, outputs: { text: TEXT }, receive(_, text, c) { requests.push(text); c.emit('text', 'S' + requests.length); } },
      async: { inputs: { text: TEXT }, outputs: { text: TEXT }, receive(_, text, c) { jobs.push({ text, work: c.defer() }); } },
      sink: { inputs: { text: TEXT }, receive(_, text) { outputs.push(text); } },
    }, connections: [
      { from: ['source', 'text'], to: ['formatter', 'input2'] }, { from: ['held', 'value'], to: ['formatter', 'input1'] },
      { from: ['formatter', 'text'], to: ['update', 'text'] }, { from: ['update', 'text'], to: ['held', 'input'] },
      { from: ['update', 'text'], to: ['async', 'text'] }, { from: ['async', 'text'], to: ['sink', 'text'] },
    ] });
    try {
      await p.start(); send('A'); send('B'); send('C'); await new Promise(resolve => setTimeout(resolve, 0));
      const before = { requests: [...requests], held: held.value, outputs: [...outputs] };
      let stopped = false; const stopping = p.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 0)); const waiting = !stopped;
      for (const { text, work } of jobs) { work.context.emit('text', 'T:' + text); work.complete(); }
      await stopping;
      return { before, waiting, outputs, errors: p.errors.map(e => e.message) };
    } finally { await p.dispose(); }
  });
  expect(result.before).toEqual({ requests: ['/A', 'S1/B', 'S2/C'], held: 'S3', outputs: [] });
  expect(result.waiting).toBe(true);
  expect(result.outputs).toEqual(['T:S1', 'T:S2', 'T:S3']);
  expect(result.errors).toEqual([]);
});
