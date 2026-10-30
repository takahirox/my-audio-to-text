import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const real = process.env.STREAMING_TTS_SMOKE === '1';
const test = base.extend({
  streaming: async ({}, use) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'streaming-tts-168-'));
    const root = path.join(temporary, 'extension'), requests = [], bodies = new Map();
    let context;
    // Package unchanged production source, manifest, CSP, UI and TTS assets. No
    // ASR model bundle is necessary for this Text → TTS → Speaker graph.
    if (process.env.TTS_EXTENSION_ROOT) {
      await cp(process.env.TTS_EXTENSION_ROOT, root, { recursive: true });
    } else {
      await cp('extension', path.join(root, 'extension'), { recursive: true });
      await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !source.startsWith(path.resolve('web/vendor')) && !source.startsWith('web/vendor') });
      await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    }
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      const body = bodies.get(request.url);
      if (!body) { response.writeHead(404).end(); return; }
      if (Buffer.isBuffer(body)) { response.end(body); return; }
      createReadStream(body).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const spec = JSON.parse(await readFile('extension/qwen3-tts-assets.json', 'utf8'));
      for (const entry of spec.files) {
        if (real) {
          const file = path.resolve(process.env.QWEN3_TTS_MODEL_DIR || '.cache/qwen3-tts-models', entry.path);
          // The production ModelAssetCache independently verifies every chunk.
          await readFile(file).then(bytes => expect(bytes.length).toBe(entry.bytes)); bodies.set('/' + entry.path, file);
        } else {
          const body = Buffer.alloc(8192, 17); bodies.set('/' + entry.path, body);
          entry.bytes = body.length; entry.sha256Chunks = [createHash('sha256').update(body).digest('hex')];
        }
        entry.sourceURL = `http://127.0.0.1:${server.address().port}/${entry.path}`;
      }
      await writeFile(path.join(root, 'extension/qwen3-tts-assets.json'), JSON.stringify(spec));
      if (real) await writeFile(path.join(root, 'web/qwen3-decoder-reference-worker.js'), `
        import { Qwen3TtsRuntime } from './qwen3-tts-runtime.js';
        import { qwen3TtsAssets } from '../extension/qwen3-tts-cache.js';
        self.onmessage=async()=>{let runtime;try{
          runtime=await Qwen3TtsRuntime.create(await qwen3TtsAssets());
          const frames=Array.from({length:256},(_,t)=>Array.from({length:16},(_,c)=>(t*37+c*101)%2048));
          const full=await runtime.decode(frames);let emitted=0,maxDifference=0;const boundaries=[];
          for(let n=10;n<=frames.length;n+=8){
            const end=n-2,pcm=await runtime.decode(frames.slice(0,n));let difference=0;
            for(let i=emitted*1920;i<end*1920;i++)difference=Math.max(difference,Math.abs(full[i]-pcm[i]));
            boundaries.push({emittedFrames:end,maxDifference:difference});maxDifference=Math.max(maxDifference,difference);emitted=end;
          }
          postMessage({maxDifference,boundaries,frames:frames.length,finite:full.every(Number.isFinite)});
        }catch(error){postMessage({error:error.message});}finally{await runtime?.dispose();}};`);
      if (!real) await writeFile(path.join(root, 'web/qwen3-tts-worker.js'), `
        let id, sequence;
        const emit=()=>postMessage({type:'chunk',id,sequence:sequence++,samples:Float32Array.from({length:2400},(_,i)=>.2*Math.sin(i/10)),at:performance.timeOrigin+performance.now()});
        self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready'});
          if(data.type==='generate'){id=data.id;sequence=0;postMessage({type:'start',id,sampleRate:24000,channels:1,at:performance.timeOrigin+performance.now()});emit();}
          if(data.type==='ack'&&data.id===id){if(sequence<3)setTimeout(emit,25);else setTimeout(()=>postMessage({type:'end',id,sequence,at:performance.timeOrigin+performance.now()}),200);}
        };`);
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
        channel: process.env.TTS_BROWSER_CHANNEL || 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
      });
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
      await use({ context, url: `chrome-extension://${id}/extension/`, requests, root });
    } finally {
      await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
});

test('real pinned decoder: incremental prefixes preserve full-decode samples through the utterance limit', async ({ streaming: f }, info) => {
  test.skip(!real, 'Requires explicitly prepared real Qwen3-TTS assets and desktop WebGPU.'); test.setTimeout(180000);
  const page = await f.context.newPage(); await page.goto(f.url + 'model-cache.html');
  await page.locator('#qwen3-tts').getByRole('button', { name: 'Download / retry' }).click();
  await expect(page.locator('#qwen3-tts .model-status')).toContainText('Ready', { timeout: 120000 });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('../web/qwen3-decoder-reference-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); }; worker.onerror = event => { worker.terminate(); reject(Error(event.message)); }; worker.postMessage({});
  }));
  const output = info.outputPath('decoder-reference.json'); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await info.attach('decoder-reference', { path: output, contentType: 'application/json' });
  expect(result.error).toBeUndefined(); expect(result.finite).toBe(true); expect(result.maxDifference).toBeLessThan(.0001);
  expect(result.frames).toBe(256); expect(result.boundaries.at(-1).emittedFrames).toBeGreaterThan(240); await page.close();
});

async function graph(f, language, text) {
  const editor = await f.context.newPage(); await editor.goto(f.url + 'graph-editor.html');
  await editor.evaluate(async ({ language, text }) => {
    const { GRAPH_VERSION, graphNode, edge, saveGraph } = await import('./graph.js');
    const literal = graphNode('Text', 'literal', 20, 50); literal.settings.value = text;
    const tts = graphNode('Qwen3TtsStreaming', 'tts', 320, 50);
    tts.settings = { language, voice: language === 'japanese' ? 'ono_anna' : 'ryan' };
    saveGraph(localStorage, { version: GRAPH_VERSION, nodes: [literal, tts, graphNode('StreamingSpeakerOutput', 'speaker', 650, 50)],
      edges: [edge('literal', 'value', 'tts', 'text'), edge('tts', 'stream', 'speaker', 'stream')] });
  }, { language, text });
  await editor.reload();
  await expect(editor.getByRole('button', { name: 'tts output stream', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'speaker input stream', exact: true })).toBeVisible();
  await editor.locator('#graph-save').click();
  await expect(editor.locator('#graph-models .model-status')).toContainText('Ready', { timeout: 120000 });
  await editor.reload(); await expect(editor.getByRole('button', { name: 'speaker input stream', exact: true })).toBeVisible();
  return editor;
}

async function observe(page) {
  await page.evaluate(async () => {
    window.ttsEvents = []; window.scheduleEvents = []; window.pcm = []; window.renderEvents = []; window.contexts = [];
    const { TextNode } = await import('../web/text-constant-node.js');
    const literalStart = TextNode.prototype.start;
    TextNode.prototype.start = function(context) { window.literalContext = context; return literalStart.call(this, context); };
    const { Qwen3TtsNode } = await import('../web/qwen3-tts-node.js');
    const message = Qwen3TtsNode.prototype.message;
    Qwen3TtsNode.prototype.message = function(data) {
      if (data.type === 'chunk') window.pcm.push(Array.from(data.samples));
      return message.call(this, data);
    };
    const event = Qwen3TtsNode.prototype.event;
    Qwen3TtsNode.prototype.event = function(data) { window.ttsEvents.push({ ...data, receivedAt: performance.timeOrigin + performance.now() }); return event.call(this, data); };
    const { StreamingSpeakerOutputNode } = await import('../web/speaker-output.js');
    const start = StreamingSpeakerOutputNode.prototype.start;
    StreamingSpeakerOutputNode.prototype.start = function(context) {
      const observer = this.onState;
      this.onState = state => { if (state.type === 'scheduled') window.scheduleEvents.push(state); observer(state); };
      window.streamingSpeaker = this; return start.call(this, context);
    };
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args); window.contexts.push(this);
        this.probe = this.createAnalyser(); this.probe.fftSize = 256;
        const silent = this.createGain(); silent.gain.value = 0; this.probe.connect(silent); silent.connect(this.destination);
        const samples = new Float32Array(256);
        const timer = setInterval(() => {
          if (this.state === 'closed') { clearInterval(timer); return; }
          this.probe.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          const playing = window.scheduleEvents.find(event => this.currentTime >= event.audioTime && this.currentTime < event.audioTime + event.duration);
          if (rms > .0001 && playing && !window.renderEvents.some(event => event.id === playing.id)) window.renderEvents.push({ id: playing.id, at: performance.timeOrigin + performance.now(), audioTime: this.currentTime, rms, output: this.getOutputTimestamp() });
        }, 5);
      }
      createBufferSource() { const source = super.createBufferSource(); source.connect(this.probe); return source; }
    };
  });
}

test(`${real ? 'real pinned Qwen3-TTS' : 'controlled streaming transport'}: MV3 saved graph plays before synthesis ends, drains Stop, and cancels immediately`, async ({ streaming: f }, info) => {
  test.setTimeout(real ? 240000 : 45000);
  const evidence = { realInference: real, browser: f.context.browser().version(), packaging: process.env.TTS_EXTENSION_ROOT || 'focused production MV3 source fixture (inactive ASR bundles omitted)', languages: [] };
  for (const [language, text] of [['english', 'Hello. This speech is generated locally while the first audio is already playing.'],
    ['japanese', 'こんにちは。これは日本語の音声です。音声を作りながら、順番に再生します。']]) {
    const editor = await graph(f, language, text);
    const page = await f.context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); await page.goto(f.url + 'recorder.html'); await observe(page);
    const network = []; page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    const requests = f.requests.length;
    await f.context.setOffline(true);
    await page.locator('#start').click();
    await expect.poll(() => page.evaluate(() => window.renderEvents.length), { timeout: 90000 }).toBe(1);
    expect(await page.evaluate(() => window.ttsEvents.some(event => event.type === 'end'))).toBe(false);
    const second = language === 'english' ? 'Thank you. This is the second committed utterance.' : '次の文章も、同じワーカーで順番に読み上げます。';
    await page.evaluate(text => window.literalContext.emit('value', text), second);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled({ timeout: 90000 });
    const record = await page.evaluate(() => ({ events: window.ttsEvents, scheduled: window.scheduleEvents, rendered: window.renderEvents,
      contexts: window.contexts.map(context => context.state), outputSampleRates: window.contexts.map(context => context.sampleRate), bytes: window.streamingSpeaker.bytes, queue: window.streamingSpeaker.queue.length,
      frames: window.pcm.reduce((sum, pcm) => sum + pcm.length, 0) }));
    const ends = record.events.filter(event => event.type === 'end'); expect(ends).toHaveLength(2);
    expect(record.events.filter(event => event.type === 'chunk').length).toBeGreaterThan(1);
    expect(record.rendered).toHaveLength(2);
    for (const end of ends) {
      expect(record.rendered.find(event => event.id === end.id).at).toBeLessThan(end.at);
      expect(record.scheduled.find(event => event.id === end.id).at).toBeLessThan(end.at);
      expect(record.scheduled.filter(event => event.id === end.id).map(event => event.sequence)).toEqual(Array.from({ length: end.sequence }, (_, i) => i));
    }
    for (let i = 1; i < record.scheduled.length; i++) {
      expect(record.scheduled[i].audioTime).toBeCloseTo(record.scheduled[i - 1].audioTime + record.scheduled[i - 1].duration, 5);
    }
    expect(record.bytes).toBe(0); expect(record.queue).toBe(0); expect(record.contexts).toEqual(['closed']);
    expect(network).toEqual([]); expect(f.requests.length).toBe(requests); expect(errors).toEqual([]);
    if (real) {
      const wav = await page.evaluate(async () => {
        const { audioToWav } = await import('../web/synthesized-audio.js');
        const samples = Float32Array.from(window.pcm.flat());
        return Array.from(new Uint8Array(await audioToWav({ samples, channels: 1, sampleRate: 24000 }).arrayBuffer()));
      });
      const output = info.outputPath(`qwen3-${language}.wav`); await writeFile(output, Buffer.from(wav));
      await info.attach(`qwen3-${language}`, { path: output, contentType: 'audio/wav' });
      record.wavSha256 = createHash('sha256').update(Buffer.from(wav)).digest('hex');
    }
    evidence.languages.push({ language, texts: [text, second], ...record });
    // A fresh session's Cancel closes the real AudioContext/owned Worker. Wait
    // after cancellation to catch any late reply that tries to schedule audio.
    await page.locator('#start').click();
    await expect.poll(() => page.evaluate(() => window.ttsEvents.filter(event => event.type === 'chunk').length), { timeout: 90000 }).toBeGreaterThan(record.events.filter(event => event.type === 'chunk').length);
    await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
    const count = await page.evaluate(() => window.scheduleEvents.length); await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scheduleEvents.length)).toBe(count);
    expect(await page.evaluate(() => window.contexts.every(context => context.state === 'closed'))).toBe(true);
    await page.close(); await editor.close();
    await f.context.setOffline(false);
  }
  const output = info.outputPath('streaming-tts-evidence.json'); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  await info.attach('streaming-tts-evidence', { path: output, contentType: 'application/json' });
});
