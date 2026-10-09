// Replace heavy inference/WASM boundaries only. Actual production Nodes,
// Worker entries, model selection/asset URLs, Pipeline, frontend mapping and
// player adapter run unchanged in native module Workers.
export async function ttsFixture(page, slug, mode = 'success') {
  const wave = `[0, .2, -.2, 0]`;
  await page.context().route('https://huggingface.co/**', route => {
    const url = new URL(route.request().url());
    if (!/\/resolve\/[a-f0-9]{40}\//.test(url.pathname)) return route.abort();
    if (mode === 'network-error') return route.fulfill({ status: 503, body: 'Unavailable' });
    const file = url.pathname.split('/').at(-1);
    if (file.endsWith('.bin')) return route.fulfill({ body: Buffer.alloc(510 * 256 * 4) });
    const json = file === 'tts.json' ? { ae: { sample_rate: 44100 } } : file === 'unicode_indexer.json' ? []
      : { style_ttl: { dims: [1, 1, 1], data: [0] }, style_dp: { dims: [1, 1, 1], data: [0] } };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(json) });
  });
  await page.context().route('**/tts-assets/ort.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const env = { wasm: {} };
    export class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } }
    export const InferenceSession = { async create(bytes, options) {
      if (options.executionProviders[0] !== 'wasm') throw Error('Wrong backend');
      if (${JSON.stringify(mode)} === 'load-error') throw Error('Model initialization failed');
      if (${JSON.stringify(mode)} === 'loading') await new Promise(r => setTimeout(r, 2000));
      return {};
    } };
  ` }));
  await page.context().route('**/supertonic3-runtime.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export class UnicodeProcessor {}
    export class Style {}
    export class TextToSpeech {
      constructor(cfg) { this.sampleRate = cfg.ae.sample_rate; }
      async call(text, language, style, steps) {
        if (!['ja', 'en'].includes(language) || steps !== 5) throw Error('Invalid settings');
        if (${JSON.stringify(mode)} === 'inference-error') throw Error('Inference failed');
        if (text === 'slow') await new Promise(r => setTimeout(r, 2000));
        return { wav: ${mode === 'invalid-audio' ? '[NaN]' : wave} };
      }
    }
  ` }));
  await page.context().route('**/tts-assets/transformers.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const env = { backends: { onnx: { wasm: {} } } };
    export class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } }
    export const StyleTextToSpeech2Model = { async from_pretrained(id, options) {
      if (!/^[a-f0-9]{40}$/.test(options.revision) || options.device !== 'wasm' || options.dtype !== 'q8') throw Error('Unpinned or wrong model');
      if (${JSON.stringify(mode)} === 'load-error') throw Error('Model initialization failed');
      if (${JSON.stringify(mode)} === 'loading') await new Promise(r => setTimeout(r, 2000));
      return async input => {
        if (input.style.dims[1] !== 256 || input.speed.data[0] !== 1) throw Error('Invalid feeds');
        if (${JSON.stringify(mode)} === 'inference-error') throw Error('Inference failed');
        if (input.input_ids.slow) await new Promise(r => setTimeout(r, 2000));
        return { waveform: { data: new Float32Array(${mode === 'invalid-audio' ? '[NaN]' : wave}) } };
      };
    } };
    export const AutoTokenizer = { async from_pretrained(id, options) {
      if (!/^[a-f0-9]{40}$/.test(options.revision)) throw Error('Unpinned tokenizer');
      return (text, settings) => {
        if (settings.truncation !== false) throw Error('Silent truncation');
        return { input_ids: { dims: [1, text === 'tokens' ? 513 : 10], slow: text === 'slow' } };
      };
    } };
  ` }));
  await page.context().route('**/tts-assets/phonemizer.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function phonemize(text) { return [text]; }' }));
  await page.context().route('**/tts-assets/openjtalk-wasm-wrapper-D6E3BSJO.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export default async function factory(settings) {
      if (!settings.locateFile('openjtalk-wasm.wasm').includes('/tts-assets/')) throw Error('Wrong WASM path');
      return {
        async configure(dic, voice, archive) {
          const root = new URL('./', import.meta.url).href;
          if (!voice.startsWith(root) || !archive.startsWith(root)) throw Error('Wrong repository prefix');
          // Exercise native requests and relative asset resolution too.
          await fetch(voice); await fetch(archive); await fetch(settings.locateFile('openjtalk-wasm.wasm'));
        },
        runFrontend(text) { return [{ pron: 'コンニチワ' }, { string: '。' }]; },
      };
    }
  ` }));
  await page.context().route(/\/tts-assets\/(openjtalk-voice\.htsvoice|open_jtalk_dic_utf_8-1\.11\.tar\.gz|openjtalk-wasm\.wasm)$/, route => route.fulfill({ body: 'fixture' }));
  if (mode === 'no-wasm' || mode === 'no-simd' || mode === 'no-gzip') {
    await page.context().route(`**/${slug}-worker.js`, async route => {
      const original = await route.fetch();
      const prefix = mode === 'no-simd' ? 'WebAssembly.validate = () => false;'
        : `Object.defineProperty(globalThis, '${mode === 'no-wasm' ? 'WebAssembly' : 'DecompressionStream'}', { value: undefined });`;
      await route.fulfill({ response: original, body: `${prefix}\n${await original.text()}` });
    });
  }
}

export async function observeTts(page) {
  await page.evaluate(async () => {
    const { Pipeline } = await import('../../pipeline.js');
    const { AudioOutputNode } = await import('../../synthesized-audio.js');
    window.ttsGraphs = []; window.ttsWaveforms = []; window.ttsWorkers = [];
    const start = Pipeline.prototype.start;
    Pipeline.prototype.start = function () { window.ttsGraphs.push(this); return start.call(this); };
    const receive = AudioOutputNode.prototype.receive;
    AudioOutputNode.prototype.receive = function (port, audio, context) {
      window.ttsWaveforms.push({ samples: audio.samples.length, sampleRate: audio.sampleRate, channels: audio.channels,
        finite: audio.samples.every(Number.isFinite), peak: Math.max(...audio.samples.subarray(0, 50000).map(Math.abs)),
        rms: Math.sqrt(audio.samples.reduce((sum, value) => sum + value * value, 0) / audio.samples.length), duration: audio.samples.length / audio.sampleRate });
      return receive.call(this, port, audio, context);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); this.record = { url: String(url), terminated: 0 }; window.ttsWorkers.push(this.record); }
      terminate() { this.record.terminated++; return super.terminate(); }
    };
  });
}
