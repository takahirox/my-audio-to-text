import { test, expect, openGraph } from './graph-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('real packaged concurrent Zipformer and Whisper: independent results, resource measurements, Stop, repeat and Cancel', async ({ graphExtension: f }, info) => {
  test.skip(!process.env.CONCURRENT_SMOKE, 'Opt-in: prepare pinned assets, build, then CONCURRENT_SMOKE=1 playwright test --config playwright.extension.config.js tests/extension/graph-concurrent-smoke.spec.js');
  test.setTimeout(300000);
  const page = await openGraph(f), runs = [], requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  f.context.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
  const cdp = await f.context.browser().newBrowserCDPSession();
  async function resources() {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const pids = processInfo.map(process => process.id).filter(id => Number.isSafeInteger(id) && id > 0);
    const rss = execFileSync('ps', ['-o','rss=', '-p',pids.join(',')], { encoding:'utf8' }).trim().split(/\s+/).reduce((sum,value) => sum + Number(value),0);
    return { cpuSeconds: processInfo.reduce((sum,process) => sum + process.cpuTime,0), rssKiB: rss };
  }
  const spec = JSON.parse(await readFile('scripts/zipformer-assets.json','utf8'));
  const wav = await readFile('.cache/zipformer-en/test_wavs/0.wav');
  expect(createHash('sha256').update(wav).digest('hex')).toBe(spec.files.find(entry => entry.path==='test_wavs/0.wav').sha256);
  let pcm;
  for(let offset=12;offset+8<=wav.length;) {
    const size=wav.readUInt32LE(offset+4);
    if(wav.toString('ascii',offset,offset+4)==='data') pcm=Array.from({length:size/2},(_,index)=>wav.readInt16LE(offset+8+index*2)/32768);
    offset+=8+size+size%2;
  }
  await page.evaluate(async () => {
    const { defaultGraph, graphNode, edge, saveGraph } = await import('./graph.js');
    const graph=defaultGraph();graph.nodes[1].type='SpeechToTextZipformerEn';
    graph.nodes.push(graphNode('MicrophoneAudio','mic'),graphNode('SpeechToTextWhisper','whisper'),graphNode('LiveTextDisplay','local'));
    graph.edges.push(edge('mic','audio','whisper','audio'),edge('whisper','final','local','append'));saveGraph(localStorage,graph);
    navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});
    const { ExtensionTabAudioNode }=await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start=function(context){
      window.captures ||= {}; window.captures[this.constructor.name]=context;
    };
    for(const [module,name] of [['zipformer-node.js','SpeechToTextZipformerEnNode'],['whisper-node.js','SpeechToTextWhisperNode']]) {
      const Node=(await import('../web/'+module))[name], receive=Node.prototype.receiveEvent;
      Node.prototype.receiveEvent=function(event){
        window.modelEvents ||= [];
        if(['partial','final'].includes(event.type)) window.modelEvents.push({node:name,type:event.type,text:event.text,ms:performance.now()});
        return receive.call(this,event);
      };
    }
  });
  const host = await page.evaluate(() => ({ browser:navigator.userAgent, isolated:crossOriginIsolated, hardwareConcurrency:navigator.hardwareConcurrency }));
  try {
    for(let repeat=0;repeat<2;repeat++) {
      await page.evaluate(()=>window.graphInvoke({type:'invoke',tabId:42},{id:chrome.runtime.id}));
      const start=Date.now();await page.locator('#start').click();
      await expect(page.locator('#status')).toHaveText('Transcription active',{timeout:120000});const loaded=Date.now();
      expect(await page.evaluate(()=>window.graphWorkers.filter(worker=>!worker.released).length)).toBe(3);
      const baseline=await resources(), samples=[baseline];
      await page.evaluate(async pcm=>{
        window.modelEvents=[];window.feedStart=performance.now();
        for(let offset=0;offset<pcm.length;offset+=1600) {
          for(const context of Object.values(window.captures)) context.emit('audio',Float32Array.from(pcm.slice(offset,offset+1600)));
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      },pcm);
      samples.push(await resources());const stop=Date.now();await page.locator('#stop').click();
      await expect(page.locator('#start')).toBeEnabled({timeout:120000});samples.push(await resources());
      await expect(page.locator('#errors')).toBeEmpty();
      const remote=await page.locator('[data-display="transcript"] .display-items li pre').allTextContents();
      const local=await page.locator('[data-display="local"] .display-items li pre').allTextContents();
      expect(remote.join(' ')).toMatch(/yellow lamps/i);expect(local.join(' ')).toMatch(/yellow lamps/i);
      expect(await page.evaluate(()=>window.graphWorkers.every(worker=>worker.released))).toBe(true);
      const timing=await page.evaluate(()=>({feedStart:window.feedStart,events:window.modelEvents}));
      runs.push({repeat, samples:pcm.length, audioSeconds:pcm.length/16000, loadMs:loaded-start, stopDrainMs:Date.now()-stop,
        elapsedMs:Date.now()-loaded, cpuSeconds:samples.at(-1).cpuSeconds-baseline.cpuSeconds,
        observedMaxRssKiB:Math.max(...samples.map(sample=>sample.rssKiB)), remote,local,
        firstOutputMs:Object.fromEntries(['SpeechToTextZipformerEnNode','SpeechToTextWhisperNode'].map(node=>[node,timing.events.find(event=>event.node===node&&event.text)?.ms-timing.feedStart]))});
      console.log(JSON.stringify(runs.at(-1)));
    }
    await page.locator('#start').click();await expect(page.locator('#status')).toHaveText('Transcription active',{timeout:120000});
    await page.locator('#cancel-session').click();await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(()=>window.graphWorkers.every(worker=>worker.released))).toBe(true);
    expect(errors).toEqual([]);expect(requests).toEqual([]);
  } finally {
    const output=info.outputPath('concurrent-evidence.json');
    await writeFile(output,JSON.stringify({host,runs,requests,errors,
      method:'Real packaged models/Workers; identical pinned English PCM feeds two source ports. Capture hardware and microphone grant are fixtures. CPU is total CDP Chrome process CPU time during feed/drain; sampled RSS sums Chrome processes (shared pages may be counted twice), not model-only peak memory.'},null,2)+'\n');
    await info.attach('concurrent-evidence',{path:output,contentType:'application/json'});
  }
});
