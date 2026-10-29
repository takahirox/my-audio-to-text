import { test, expect } from '@playwright/test';

test('DOM snapshots clone safely for fan-out and preserve literal multiline/empty updates', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { TextToDOMNode } = await import('/dom-nodes.js'), { LiveTextDisplayNode } = await import('/text-nodes.js');
    const a = document.createElement('div'), b = document.createElement('div'); a.id='snapshot-a'; b.id='snapshot-b'; document.body.append(a,b);
    const sinks = [a,b].map(root => new LiveTextDisplayNode(dom => root.replaceChildren(dom)));
    window.snapshots = [];
    const c = {signal:new AbortController().signal, emit(_,dom) { window.snapshots.push(dom); for(const sink of sinks) sink.receive('dom',dom,c); }};
    const formatter = new TextToDOMNode(); window.renderSnapshot = text => formatter.receive('text',text,c);
    renderSnapshot('  <img src=x onerror=alert(1)>\n<script>bad</script>\n\t literal  ');
  });
  const literal = '  <img src=x onerror=alert(1)>\n<script>bad</script>\n\t literal  ';
  for (const id of ['a','b']) {
    expect(await page.locator(`#snapshot-${id}`).textContent()).toBe(literal);
    await expect(page.locator(`#snapshot-${id} img, #snapshot-${id} script`)).toHaveCount(0);
    await expect(page.locator(`#snapshot-${id} > div`)).toHaveCSS('white-space','pre-wrap');
  }
  expect(await page.evaluate(()=>snapshots[0].parentNode===null && document.querySelector('#snapshot-a').firstChild!==document.querySelector('#snapshot-b').firstChild)).toBe(true);
  for (const text of ['same','same','short','']) {
    await page.evaluate(text=>renderSnapshot(text),text); expect(await page.locator('#snapshot-a').textContent()).toBe(text); expect(await page.locator('#snapshot-b').textContent()).toBe(text);
  }
});

test('paired rows align unequal heights and highlight exactly one pair from either hover or keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { PairedTextToDOMNode } = await import('/dom-nodes.js'), { LiveTextDisplayNode } = await import('/text-nodes.js');
    const root = document.createElement('div'); root.id='comparison'; root.style.width='600px'; document.body.append(root);
    const sink = new LiveTextDisplayNode(dom=>root.replaceChildren(dom));
    const c = {signal:new AbortController().signal,groupInputs:['source','text','error'],emit(_,dom){sink.receive('dom',dom,c);}};
    window.paired = new PairedTextToDOMNode(); paired.start(c);
    paired.receiveInputs({source:'same',text:'a long translation\n'.repeat(8),error:''},c);
    paired.receiveInputs({source:'same',text:'second',error:''},c);
    paired.receiveInputs({source:'failed <script>source</script>',error:'<img src=x onerror=alert(1)>'},c);
    window.pairedContext=c;
  });
  const rows = page.locator('#comparison tbody tr'); await expect(rows).toHaveCount(3);
  expect(await rows.nth(0).locator('td').allTextContents()).toEqual(['same','a long translation\n'.repeat(8)]);
  await expect(page.locator('#comparison script, #comparison img')).toHaveCount(0);
  const boxes = await rows.nth(0).locator('td').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return {top:r.top,height:r.height};}));
  expect(boxes[0].top).toBe(boxes[1].top); expect(boxes[0].height).toBe(boxes[1].height); expect(boxes[0].height).toBeGreaterThan(100);
  for (const row of [0,1]) for (const cell of [0,1]) {
    await rows.nth(row).locator('td').nth(cell).hover();
    const colors = await rows.evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>getComputedStyle(cell).backgroundColor)));
    expect(colors[row][0]).toBe(colors[row][1]); expect(colors[row][0]).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors[1-row]).toEqual(['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  }
  await page.mouse.move(0,0);
  for (const row of [0,1]) for (const cell of [0,1]) {
    await rows.nth(row).locator('td').nth(cell).focus();
    const colors=await rows.evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>getComputedStyle(cell).backgroundColor)));
    expect(colors[row][0]).toBe(colors[row][1]); expect(colors[row][0]).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors[1-row]).toEqual(['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  }
  await page.evaluate(()=>{paired.cancel();paired.receiveInputs({source:'stale',text:'stale'},pairedContext);}); await expect(rows).toHaveCount(3);
  await page.evaluate(()=>paired.start(pairedContext)); await expect(rows).toHaveCount(0);
});
