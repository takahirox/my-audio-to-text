import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Chrome offscreen native permission, worklet, isolated Worker/WASM and GPU capability probe', async ({}, info) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'offscreen-feasibility-'));
  let context;
  try {
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Dictation feasibility probe', version: '1.0',
      permissions: ['offscreen'], background: { service_worker: 'background.js' },
      cross_origin_embedder_policy: { value: 'require-corp' }, cross_origin_opener_policy: { value: 'same-origin' },
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'" } }));
    await writeFile(path.join(dir, 'background.js'), 'self.results=[]; chrome.runtime.onMessage.addListener(message=>{results.push(message)});');
    await writeFile(path.join(dir, 'runtime.html'), '<script src="runtime.js"></script>');
    await writeFile(path.join(dir, 'worklet.js'), "registerProcessor('probe',class extends AudioWorkletProcessor{process(){return true}});");
    await writeFile(path.join(dir, 'worker.js'), `postMessage({ wasm:WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])), isolated:crossOriginIsolated, sharedMemory:!!new WebAssembly.Memory({initial:1,maximum:1,shared:true}) });`);
    await writeFile(path.join(dir, 'runtime.js'), `chrome.runtime.onMessage.addListener(message=>{
      if(message.type!=='probe')return;
      (async()=>{
        const permission=(await navigator.permissions.query({name:'microphone'})).state;
        const capture=await Promise.race([navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
          stream.getTracks().forEach(track=>track.stop());return 'success';
        },error=>error.name+': '+error.message),new Promise(resolve=>setTimeout(()=>resolve('pending after 1200ms'),1200))]);
        const context=new AudioContext(); await context.audioWorklet.addModule('worklet.js');await context.resume();
        const worklet=new AudioWorkletNode(context,'probe'); await context.close();
        const worker=await new Promise(resolve=>{const w=new Worker('worker.js');w.onmessage=({data})=>{w.terminate();resolve(data)}});
        const adapter=await navigator.gpu?.requestAdapter();
        chrome.runtime.sendMessage({permission,capture,activation:navigator.userActivation.isActive,storage:!!chrome.storage,tabs:!!chrome.tabs,
          worklet:!!worklet,worker,gpuAdapter:!!adapter,isolated:crossOriginIsolated});
      })();
    });`);
    context = await chromium.launchPersistentContext(path.join(dir, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream'] });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const runs = [];
    for (const setting of ['prompt', 'granted', 'denied']) {
      await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting, origin: `chrome-extension://${id}` });
      await worker.evaluate(() => chrome.offscreen.createDocument({ url: 'runtime.html', reasons: ['USER_MEDIA', 'WORKERS'], justification: 'Probe microphone runtime feasibility' }));
      await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'probe' }));
      await expect.poll(() => worker.evaluate(() => results.length)).toBe(1);
      const [result] = await worker.evaluate(() => results.splice(0)); runs.push(result);
      expect(result).toMatchObject({ permission: setting, activation: false, storage: false, tabs: false, worklet: true,
        isolated: true, worker: { wasm: true, isolated: true, sharedMemory: true } });
      await worker.evaluate(() => chrome.offscreen.closeDocument());
      if (setting === 'granted') expect(result.capture).toBe('success');
      else expect(result.capture).not.toBe('success');
    }
    expect(context.pages().map(p => p.url())).toEqual(['about:blank']);
    const report = { browser: context.browser().version(), platform: process.platform, headless: true, runs,
      limits: 'Fake device and CDP permission settings. No native permission bubble buttons or physical microphone automated. GPU adapter availability is not real-model WebGPU inference validation.' };
    await writeFile(info.outputPath('offscreen-feasibility.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { await context?.close(); await rm(dir, { recursive: true, force: true }); }
});
