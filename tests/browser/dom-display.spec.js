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

test('explicit DOM history rows align unequal heights and highlight exactly one pair from either hover or keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { PairedTextToDOMNode, DOMAccumulatorNode } = await import('/dom-nodes.js'), { LiveTextDisplayNode } = await import('/text-nodes.js');
    const root = document.createElement('div'); root.id='comparison'; root.style.width='600px'; document.body.append(root);
    const sink = new LiveTextDisplayNode(dom=>root.replaceChildren(dom));
    const out = {signal:new AbortController().signal,emit(_,dom){sink.receive('dom',dom,out);}};
    window.historyDOM = new DOMAccumulatorNode(); historyDOM.start(out);
    const c = {...out,groupInputs:['input1','input2'],emit(_,dom){historyDOM.receive('append',dom,out);}};
    window.historyContext=out;
    window.paired = new PairedTextToDOMNode(); paired.start(c);
    paired.receiveInputs({input1:'same',input2:'a long translation\n'.repeat(8)},c);
    paired.receiveInputs({input1:'same',input2:'second'},c);
    paired.receiveInputs({input1:'failed <script>source</script>'},c);
    window.pairedContext=c;
  });
  const rows = page.locator('#comparison tbody tr'); await expect(rows).toHaveCount(3);
  await expect(page.locator('#comparison thead')).toHaveCount(0);
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
  await page.evaluate(()=>{paired.cancel();paired.receiveInputs({input1:'stale',input2:'stale'},pairedContext);}); await expect(rows).toHaveCount(3);
  await page.evaluate(()=>{paired.start(pairedContext);historyDOM.start(historyContext);}); await expect(rows).toHaveCount(0);
});


test('direct paired formatter replaces the previous pair with literal pairs, omissions and empty results', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { PairedTextToDOMNode } = await import('/dom-nodes.js'), { LiveTextDisplayNode } = await import('/text-nodes.js');
    const root = document.createElement('div'); root.id='latest-pair'; root.style.width='600px'; document.body.append(root);
    const sink = new LiveTextDisplayNode(dom=>root.replaceChildren(dom));
    const c = {signal:new AbortController().signal,groupInputs:['input1','input2'],emit(_,dom){sink.receive('dom',dom,c);}};
    const paired = new PairedTextToDOMNode(); paired.start(c);
    window.renderPair = (values, provisional = false) => paired.receiveInputs(values,{...c,provisional});
    renderPair({input1:'original',input2:'long translation\n'.repeat(8)});
  });
  const rows = page.locator('#latest-pair tbody tr'), cells = rows.locator('td');
  await expect(rows).toHaveCount(1);
  const boxes = await cells.evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return {top:r.top,height:r.height};}));
  expect(boxes[0]).toEqual(boxes[1]); expect(boxes[0].height).toBeGreaterThan(100);
  for (const method of ['hover','focus']) for (const side of [0,1]) {
    await page.mouse.move(0,0); await cells.nth(side)[method]();
    const colors = await cells.evaluateAll(cells=>cells.map(cell=>getComputedStyle(cell).backgroundColor));
    expect(colors[0]).toBe(colors[1]); expect(colors[0]).not.toBe('rgba(0, 0, 0, 0)');
  }
  for (const [value, expected] of [
    [{input1:'same',input2:'日本語'},['same','日本語']],
    [{input1:'same',input2:'日本語'},['same','日本語']],
    [{input1:'<script>source</script>'},['<script>source</script>','']],
    [{input1:'',input2:''},['','']],
  ]) {
    let committed;
    for (const provisional of [false,true]) {
      await page.evaluate(({value,provisional})=>renderPair(value,provisional),{value,provisional});
      await expect(rows).toHaveCount(1); expect(await cells.allTextContents()).toEqual(expected);
      await expect(page.locator('#latest-pair script, #latest-pair img')).toHaveCount(0);
      const markup = await page.locator('#latest-pair').innerHTML();
      if (provisional) expect(markup).toBe(committed); else committed = markup;
    }
  }
});

test('Pipeline emits consistent atomic pairs and symmetric independent snapshots from arbitrary producers', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {Pipeline}=await import('/pipeline.js'), {TEXT,DOM}=await import('/port-contracts.js'), {PairedTextToDOMNode}=await import('/dom-nodes.js');
    const edge=(source,output,target,input)=>({from:[source,output],to:[target,input]});
    const outcomes=[];
    for(const reverse of [false,true]) for(const mode of ['grouped','independent','unrelated','provisional']) {
      let a,b;const snapshots=[],plain=[];
      const connections=[edge('a','left','pairs','input1'),edge(mode==='unrelated'?'b':'a','right','pairs','input2'),edge('a','left','plain','text'),edge('pairs','dom','sink','dom')];
      const pipeline=new Pipeline({nodes:{
        a:{outputs:{left:TEXT,right:TEXT},start(c){a=c;}},b:{outputs:{right:TEXT},start(c){b=c;}},pairs:new PairedTextToDOMNode(),
        sink:{inputs:{dom:DOM},receive(_,dom){snapshots.push([...dom.querySelectorAll('td')].map(cell=>cell.textContent));}},
        plain:{inputs:{text:TEXT},receive(_,text){plain.push(text);}},
      },connections:reverse?connections.reverse():connections});
      await pipeline.start();
      if(mode==='grouped'||mode==='provisional') {
        for(const group of [{right:'orphan'},{left:'same',right:'same'},{left:'same',right:'same'},{left:'same'},{left:'',right:''}]) a.emitOutputs(group,{provisional:mode==='provisional'});
      } else if(mode==='independent') {
        if(reverse) a.emit('right','same');
        a.emit('left','same');
        if(!reverse) a.emit('right','same');
      }
      else {a.emitOutputs({left:'same',right:'same'},{provisional:mode==='provisional'});b.emitOutputs({right:'same'});}
      await pipeline.entries.get('pairs').queue;await pipeline.entries.get('sink').queue;await pipeline.entries.get('plain').queue;
      outcomes.push({reverse,mode,snapshots,plain,errors:pipeline.errors.map(error=>error.message)});
      await pipeline.cancel();await pipeline.dispose();
    }
    return outcomes;
  });
  for(const {reverse,mode,snapshots,plain,errors} of result) {
    if(mode==='grouped'||mode==='provisional') {
      expect(snapshots).toEqual([['','orphan'],['same','same'],['same','same'],['same',''],['','']]);
      expect(plain).toEqual(['same','same','same','']);expect(errors).toEqual([]);
    } else {
      expect(snapshots).toEqual([mode==='independent'&&reverse?['','same']:['same',''],['same','same']]);expect(plain).toEqual(['same']);expect(errors).toEqual([]);
    }
  }
});
