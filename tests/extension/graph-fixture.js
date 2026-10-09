import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const test = base.extend({
  graphExtension: async ({}, use, info) => {
    const real = info.file.endsWith('graph-tts-smoke.spec.js');
    const temporary = await mkdtemp(path.join(tmpdir(), 'extension-graph-'));
    const root = path.join(temporary, 'extension'), profile = path.join(temporary, 'profile');
    let context;
    const requests = [], connections = new Set(), bodies = new Map(); let mode = 'normal';
    const server = createServer((request, response) => {
      requests.push(request.url); connections.add(response); response.on('close', () => connections.delete(response));
      response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (mode === 'error') { response.writeHead(503); response.end(); return; }
      const body = bodies.get(request.url.slice(1));
      if (!body) { response.writeHead(404); response.end(); return; }
      response.writeHead(200); response.write(body.subarray(0, 100));
      if (mode !== 'hold') response.end(body.subarray(100));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const load = async () => (await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root })).id;
    try {
      await cp(path.resolve('dist/chrome-extension'), root, { recursive: true,
        filter: source => !source.includes(`${path.sep}vendor`) && (real || !source.includes(`${path.sep}tts-assets`)) });
      // ASR/capture are fixtures even in TTS smoke. TTS smoke uses every real
      // packaged TTS runtime/frontend and real checkpoint, with no replacements.
      for (const role of ['sherpa', 'silero']) await writeFile(path.join(root, `web/${role}-worker.js`), `
        self.onmessage=({data})=>{if(data.type==='load')postMessage({type:'ready'});if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});};`);
      if (!real) {
        for (const file of ['supertonic3-assets.json', 'kokoro-assets.json']) {
          const entries = JSON.parse(await readFile(path.join(root, 'extension', file), 'utf8')).map(entry => {
            const key = file + '/' + entry.path;
            let body = Buffer.alloc(entry.path.endsWith('.bin') ? 510 * 256 * 4 : 8192);
            if (entry.path.endsWith('.json')) body = Buffer.from(JSON.stringify(entry.path.endsWith('tts.json') ? { ae: { sample_rate: 44100 } }
              : entry.path.endsWith('unicode_indexer.json') ? [] : { style_ttl: { dims: [1, 1, 1], data: [0] }, style_dp: { dims: [1, 1, 1], data: [0] } }));
            bodies.set(key, body);
            return { path: entry.path, bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: `http://127.0.0.1:${server.address().port}/${key}` };
          });
          await writeFile(path.join(root, 'extension', file), JSON.stringify(entries));
        }
        await mkdir(path.join(root, 'web/tts-assets'), { recursive: true });
        await writeFile(path.join(root, 'web/tts-assets/ort.mjs'), `
          export const env={wasm:{}}; export class Tensor{constructor(type,data,dims){this.data=data;this.dims=dims;}}
          export const InferenceSession={async create(){return {};}};`);
        await writeFile(path.join(root, 'web/supertonic3-runtime.js'), `
          export class UnicodeProcessor{} export class Style{} export class TextToSpeech{
            constructor(cfg){this.sampleRate=cfg.ae.sample_rate;}
            async call(text){if(text==='slow')await new Promise(r=>setTimeout(r,2000));if(text==='fail')throw Error('Fixture inference failure');
              return {wav:Float32Array.from({length:4410},(_,i)=>.2*Math.sin(i/10))};}}`);
        await writeFile(path.join(root, 'web/tts-assets/transformers.js'), `
          export const env={backends:{onnx:{wasm:{}}}}; export class Tensor{constructor(type,data,dims){this.data=data;this.dims=dims;}}
          export const StyleTextToSpeech2Model={async from_pretrained(id,options){
            if(env.allowRemoteModels!==false||env.useBrowserCache!==false)throw Error('Remote models must be disabled');
            for(const file of ['config.json','onnx/model_quantized.onnx','tokenizer.json','tokenizer_config.json'])
              if(!await env.customCache.match('https://huggingface.co/'+id+'/resolve/'+options.revision+'/'+file))throw Error('Cache missing');
            return async ({input_ids})=>{if(input_ids.text==='slow')await new Promise(r=>setTimeout(r,2000));if(input_ids.text==='fail')throw Error('Fixture inference failure');
              return {waveform:{data:Float32Array.from({length:2400},(_,i)=>.2*Math.sin(i/10))}};};}};
          export const AutoTokenizer={async from_pretrained(){return text=>({input_ids:{text,dims:[1,10]}});}};`);
        await writeFile(path.join(root, 'web/kokoro-english.js'), 'export async function phonemize(text){return text;}');
        await writeFile(path.join(root, 'web/kokoro-japanese.js'), 'export async function createJapanesePhonemizer(){return async text=>text;}');
      }
      context = await launch(); const id = await load();
      const f = { context, root, id, url: `chrome-extension://${id}/extension/recorder.html`, requests,
        mode(value) { mode = value; }, async restart() { await context.close(); context = await launch(); expect(await load()).toBe(id); this.context = context; } };
      await use(f);
    } finally { await context?.close(); for (const response of connections) response.destroy(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
  },
});
export async function openGraph(f) {
  await f.context.addInitScript(() => {
    const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = listener => { window.graphInvoke = listener; add(listener); };
    const NativeWorker = window.Worker; window.graphWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.url = String(args[0]); this.messages = []; this.released = false; window.graphWorkers.push(this); }
      postMessage(data, ...rest) {
        this.messages.push({ type: data.type, text: data.text });
        if (window.holdTtsLoad && this.url.match(/supertonic3-worker|kokoro-worker/) && data.type === 'load') return;
        super.postMessage(data, ...rest);
      }
      terminate() { this.released = true; super.terminate(); }
    };
  });
  const page = await f.context.newPage(); await page.goto(f.url);
  await page.evaluate(async () => {
    const { SpeechToTextNode } = await import('../web/transcription-nodes.js');
    const start = SpeechToTextNode.prototype.start;
    SpeechToTextNode.prototype.start = function(context) { window.speech = this; return start.call(this, context); };
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function() {};
    ExtensionTabAudioNode.prototype.stop = function() {};
  });
  page.editor = await f.context.newPage(); await page.editor.goto(f.url.replace('recorder.html', 'graph-editor.html'));
  page.models = await f.context.newPage(); await page.models.goto(f.url.replace('recorder.html', 'model-cache.html'));
  return page;
}
export async function startGraph(page, timeout = 30000) {
  // Send through the recorder's registered production invocation listener.
  await page.evaluate(async () => { window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }); });
  await expect(page.locator('#status')).toHaveText('Transcription active', { timeout });
}
export async function emitFinal(page, text) {
  await page.evaluate(text => window.speech.receiveEvent({ type: 'final', text }), text);
}
export async function addAudioPath(page, type) {
  const editor = page.editor;
  await editor.locator('#translation-enabled').uncheck();
  for (const node of ['FinalText', type, 'AudioOutput']) {
    await editor.locator('#graph-node-type').selectOption(node); await editor.locator('#graph-add').click();
  }
  for (const [source, output, target, input] of [['speech', 'final', 'finaltext', 'final'], ['finaltext', 'text', type.toLowerCase(), 'text'], [type.toLowerCase(), 'audio', 'audiooutput', 'audio']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).click();
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).click();
  }
  await expect(editor.locator('#graph-errors')).toBeEmpty(); await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
}
export { expect };
