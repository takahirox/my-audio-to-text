import { serveTts, progress, ttsAsset } from './tts-worker.js';

export const SUPERTONIC3 = Object.freeze({
  id: 'supertone-oss-archive/supertonic-3', revision: 'aafc6e32416a594460b32413efc49d7fe4ce6d46', sampleRate: 44100,
});
const base = `https://huggingface.co/${SUPERTONIC3.id}/resolve/${SUPERTONIC3.revision}/`;
let tts, style, language;
serveTts({
  async load(settings) {
    if (!['ja', 'en'].includes(settings.language) || !['F1', 'M1'].includes(settings.voice)) throw new Error('Unsupported Supertonic 3 language or voice.');
    language = settings.language;
    const ort = await import('./tts-assets/ort.mjs');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./tts-assets/', import.meta.url).href;
    const { TextToSpeech, UnicodeProcessor, Style } = await import('./supertonic3-runtime.js');
    const cfg = await (await ttsAsset(base + 'onnx/tts.json')).json();
    const indexer = await (await ttsAsset(base + 'onnx/unicode_indexer.json')).json();
    const sessions = [];
    for (const file of ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']) {
      const bytes = await (await ttsAsset(base + `onnx/${file}.onnx`)).arrayBuffer();
      progress(`Initializing ${file}…`);
      sessions.push(await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }));
    }
    tts = new TextToSpeech(cfg, new UnicodeProcessor(indexer), ...sessions);
    if (tts.sampleRate !== SUPERTONIC3.sampleRate) throw new Error('Unexpected Supertonic checkpoint sample rate.');
    const voice = await (await ttsAsset(base + `voice_styles/${settings.voice}.json`)).json();
    const tensor = value => new ort.Tensor('float32', new Float32Array(value.data.flat(Infinity)), value.dims);
    style = new Style(tensor(voice.style_ttl), tensor(voice.style_dp));
  },
  async generate(text) {
    progress('Generating speech…');
    const { wav } = await tts.call(text, language, style, 5, 1.05, 0.3,
      (step, total) => progress(`Generating speech… step ${step}/${total}`));
    return { samples: new Float32Array(wav), sampleRate: tts.sampleRate, channels: 1 };
  },
});
