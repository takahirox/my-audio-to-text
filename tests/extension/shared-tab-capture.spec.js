import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real MV3 toolbar authorization, offscreen getUserMedia/worklet, tab audio,
// runtime ports and Live graphs. Model replies are deliberately tiny fixtures.
// Physical loudspeaker volume/echo and native permission dialogs need manual QA.
test('two independent Live graphs share native tab capture and one playback branch, then Stop/close/rejoin', async ({}, info) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(path.join(tmpdir(), 'shared-tab-capture-'));
  const root = path.join(directory, 'extension'); let context;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<button>Play tone</button><script>document.querySelector("button").onclick=()=>{window.audio=new AudioContext();const oscillator=audio.createOscillator();oscillator.frequency.value=440;oscillator.connect(audio.destination);oscillator.start();audio.resume();}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(file) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    for (const name of ['reazon', 'silero']) {
      const file = path.join(root, 'extension', `${name}-assets.json`), manifest = JSON.parse(await readFile(file, 'utf8'));
      const body = Buffer.from('shared capture model fixture');
      await writeFile(path.join(root, 'extension', `${name}-fixture.bin`), body);
      // The extension ID is not known yet. Relative same-origin fixture URL.
      manifest.files = [{ path: 'fixture.bin', bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: 'placeholder' }];
      await writeFile(file, JSON.stringify(manifest));
    }
    await writeFile(path.join(root, 'web/silero-worker.js'), `self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready'});
      if(data.type==='vad-audio')postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:true}]});
      if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
    };`);
    await writeFile(path.join(root, 'web/sherpa-worker.js'), `self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready'});
      if(data.type==='decode') {postMessage({type:data.final?'final':'partial',text:'PCM tone received',id:data.id,session:data.session});postMessage({type:'decoded',session:data.session});}
    };`);
    await writeFile(path.join(root, 'extension/capture-test-probe.js'), `
      const contexts=[],tracks=[]; let playbackConnections=0, mediaRequests=0;
      const NativeContext=AudioContext;
      globalThis.AudioContext=class extends NativeContext {
        constructor(...args){super(...args);contexts.push(this);}
        createMediaStreamSource(...args){const source=super.createMediaStreamSource(...args),connect=source.connect.bind(source);
          source.connect=(target,...rest)=>{if(target===this.destination)playbackConnections++;return connect(target,...rest);};return source;}
      };
      const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async(...args)=>{mediaRequests++;const media=await getMedia(...args);tracks.push(...media.getTracks());return media;};
      chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(message.type==='capture-test-probe')respond({mediaRequests,playbackConnections,contexts:contexts.map(c=>c.state),tracks:tracks.map(t=>t.readyState)});});
    `);
    const runtime = path.join(root, 'extension/web-voice-runtime.js');
    await writeFile(runtime, "import './capture-test-probe.js';\n" + await readFile(runtime, 'utf8'));
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: process.env.TAB_CAPTURE_HEADED !== '1',
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'], args: ['--enable-unsafe-extension-debugging'] });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    const url = `chrome-extension://${id}/extension/`;
    for (const name of ['reazon', 'silero']) {
      const file = path.join(root, 'extension', `${name}-assets.json`), manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.files[0].sourceURL = url + name + '-fixture.bin'; await writeFile(file, JSON.stringify(manifest));
    }
    await context.addInitScript(() => {
      window.captureRequests=[]; window.modelWorkers=[];
      const NativeWorker=Worker;
      window.Worker=class extends NativeWorker {
        constructor(...args){super(...args);modelWorkers.push(this);}
        terminate(){this.released=true;super.terminate();}
      };
      if(chrome.tabCapture) {
        const original=chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
        chrome.tabCapture.getMediaStreamId=options=>{captureRequests.push(options.targetTabId);return original(options);};
      }
    });
    const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const library = await context.newPage(); await library.goto(url + 'graph-library.html');
    await library.evaluate(async () => {
      const { GraphLibrary } = await import('./graph-library.js');
      const { defaultGraph, graphNode } = await import('./graph.js');
      const store = new GraphLibrary(localStorage), first = defaultGraph({ enabled: false }), second = defaultGraph({ enabled: false });
      second.nodes.push(graphNode('Display','second-output'));
      second.edges.push({from:['speech','provisional'],to:['second-output','input1']});
      second.nodes[0].id='second-audio'; for(const route of second.edges)if(route.from[0]==='audio')route.from[0]='second-audio';
      const a = (await store.create({name:'Tone A',graph:first})).graphs.at(-1).id;
      const b = (await store.create({name:'Tone B',graph:second})).graphs.at(-1).id;
      window.graphIds=[a,b]; await store.assign('live',a);
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/tone`);
    await website.locator('button').click();
    async function launch(index, source = website) {
      await library.evaluate(async index => { const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).assign('live',graphIds[index]); }, index);
      const opened = context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
      await source.bringToFront();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type:'tab', exclude:false }] });
      await cdp.send('Extensions.triggerAction', { id, targetId:targetInfos.find(target=>target.url===source.url()).targetId });
      const page = await opened; await expect(page.locator('#model-status')).toHaveText('Ready'); return page;
    }
    const a = await launch(0), b = await launch(1);
    const captureCount = async () => (await Promise.all([a,b].filter(page=>!page.isClosed()).map(page=>page.evaluate(()=>captureRequests.length)))).reduce((sum,count)=>sum+count,0);
    expect(await captureCount()).toBe(0);
    await expect(a.locator('#live-graph-name')).toHaveText('Tone A'); await expect(b.locator('#live-graph-name')).toHaveText('Tone B');
    for(const page of [a,b]) expect(await page.evaluate(()=>modelWorkers.filter(worker=>!worker.released).length)).toBe(2);
    await Promise.all([a.locator('#start').click(), b.locator('#start').click()]);
    await expect.poll(captureCount).toBeGreaterThan(0);
    for (const page of [a,b]) {
      await expect(page.locator('#status')).toHaveText('Transcription active');
      await expect(page.locator('#signal')).toContainText('Audio signal detected');
      await expect(page.locator('[data-display="transcript"]')).toContainText('PCM tone received');
      await expect(page.locator('#errors')).toBeEmpty();
    }
    const probe = () => library.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-test-probe' }));
    expect(await captureCount()).toBe(1);
    expect(await probe()).toMatchObject({ mediaRequests: 1, playbackConnections: 1, tracks: ['live'], contexts: ['running'] });
    await a.locator('#stop').click(); await expect(a.locator('#start')).toBeEnabled();
    await expect(b.locator('#status')).toHaveText('Transcription active');
    expect(await probe()).toMatchObject({ mediaRequests: 1, playbackConnections: 1, tracks: ['live'] });
    // Join an already active capture using a fresh graph/session generation.
    await a.locator('#start').click(); await expect(a.locator('#signal')).toContainText('Audio signal detected');
    expect(await captureCount()).toBe(1);
    const nativeCaptures = await captureCount();
    const issuer = await a.evaluate(() => captureRequests.length) ? a : b;
    const remaining = issuer === a ? b : a;
    await issuer.close(); await expect(remaining.locator('#errors')).toBeEmpty();
    await expect(remaining.locator('#status')).toHaveText('Transcription active');
    await remaining.locator('#stop').click(); await expect(remaining.locator('#start')).toBeEnabled();
    await expect.poll(() => library.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab=>tab.status==='active').length)).toBe(0);
    await expect.poll(async () => (await probe())?.tracks.every(state => state === 'ended') ?? true).toBe(true);
    // Last detach -> a fresh native capture. Another tab has its own owner.
    await remaining.locator('#start').click(); await expect(remaining.locator('#signal')).toContainText('Audio signal detected');
    const other = await context.newPage(); await other.goto(`http://127.0.0.1:${server.address().port}/other-tone`);
    await other.locator('button').click(); const c = await launch(1, other);
    await c.locator('#start').click(); await expect(c.locator('#signal')).toContainText('Audio signal detected');
    await expect.poll(() => library.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab=>tab.status==='active').length)).toBe(2);
    const beforeNavigation = await probe(); expect(beforeNavigation.mediaRequests).toBe(2); expect(beforeNavigation.playbackConnections).toBe(2);
    await website.goto(`http://127.0.0.1:${server.address().port}/navigated`);
    await expect(remaining.locator('#start')).toBeEnabled(); await expect(c.locator('#status')).toHaveText('Transcription active');
    await expect.poll(() => library.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab=>tab.status==='active').length)).toBe(1);
    // An unrelated authorized tab never reauthorizes the old window.
    await remaining.locator('#start').click(); await expect(remaining.locator('#errors')).toContainText('not authorized');
    await expect(c.locator('#errors')).toBeEmpty();
    // Losing the offscreen host must release native audio and report failure,
    // with an explicit Start needed to recover in this still-authorized window.
    await worker.evaluate(() => chrome.offscreen.closeDocument());
    await expect(c.locator('#errors')).toContainText('disconnected');
    await expect(c.locator('#start')).toBeEnabled();
    await c.locator('#start').click(); await expect(c.locator('#signal')).toContainText('Audio signal detected');
    await c.reload(); await expect(c.locator('#model-status')).toHaveText('Ready');
    await expect.poll(() => library.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab=>tab.status==='active').length)).toBe(0);
    expect(errors).toEqual([]);
    await writeFile(info.outputPath('shared-tab-capture.json'), JSON.stringify({ browser: context.browser().version(), nativeCaptures, sameTabGraphs:2, sameTabPlaybackBranches:1, distinctTabCaptures:2, navigationScoped:true, hostLossAndReload:true,
      limitations:'Synthetic audible tone and fixture ASR replies. Native Chrome tab capture, offscreen worklet and Live windows are real. No physical speaker/echo measurement or real model quality assertion.' },null,2));
  } finally { await context?.close(); await rm(directory, { recursive:true, force:true }); await new Promise(resolve => server.close(resolve)); }
});
