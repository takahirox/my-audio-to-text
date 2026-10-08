import { serveTts, progress, ttsAsset } from './tts-worker.js';

export const KOKORO = Object.freeze({
  id: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', sampleRate: 24000,
});
// The model feeds/style indexing follow hexgrad/kokoro (Apache-2.0).
// Use the lower-level pinned Transformers API: kokoro-js.from_pretrained()
// does not forward revision, and its generate() validates English voices only.
let model, tokenizer, Tensor, voiceData, phonemize;
serveTts({
  async load({ voice }) {
    if (!['af_heart', 'jf_alpha'].includes(voice)) throw new Error('Unsupported Kokoro voice/language.');
    if (voice === 'jf_alpha' && typeof DecompressionStream !== 'function') throw new Error('Japanese Kokoro requires DecompressionStream (gzip). Use a current browser.');
    const hf = await import('./tts-assets/transformers.js');
    hf.env.allowLocalModels = false; hf.env.useBrowserCache = true;
    hf.env.backends.onnx.wasm.numThreads = 1; hf.env.backends.onnx.wasm.proxy = false;
    hf.env.backends.onnx.wasm.wasmPaths = new URL('./tts-assets/', import.meta.url).href;
    Tensor = hf.Tensor;
    const options = { revision: KOKORO.revision, progress_callback: value => progress(`Loading ${value.file || 'Kokoro'}${Number.isFinite(value.progress) ? ` ${value.progress.toFixed(0)}%` : ''}…`) };
    model = await hf.StyleTextToSpeech2Model.from_pretrained(KOKORO.id, { ...options, device: 'wasm', dtype: 'q8' });
    tokenizer = await hf.AutoTokenizer.from_pretrained(KOKORO.id, options);
    voiceData = new Float32Array(await (await ttsAsset(`https://huggingface.co/${KOKORO.id}/resolve/${KOKORO.revision}/voices/${voice}.bin`)).arrayBuffer());
    if (voiceData.length !== 510 * 256) throw new Error('Invalid Kokoro voice embedding.');
    if (voice === 'af_heart') {
      const english = await import('./kokoro-english.js');
      phonemize = text => english.phonemize(text, 'a');
    } else {
      progress('Loading Japanese Open JTalk frontend and dictionary…');
      const { createJapanesePhonemizer } = await import('./kokoro-japanese.js');
      phonemize = await createJapanesePhonemizer();
    }
  },
  async generate(text) {
    progress('Generating speech…');
    const phonemes = await phonemize(text);
    if (!phonemes.trim()) throw new Error('Kokoro frontend produced no phonemes. Try Japanese or English text with the matching voice.');
    const { input_ids } = tokenizer(phonemes, { truncation: false });
    const length = input_ids.dims.at(-1);
    if (length > 512) throw new Error('Kokoro input exceeds 512 phoneme tokens. Use a shorter snippet.');
    const offset = Math.min(Math.max(length - 2, 0), 509) * 256;
    const { waveform } = await model({ input_ids,
      style: new Tensor('float32', voiceData.slice(offset, offset + 256), [1, 256]),
      speed: new Tensor('float32', [1], [1]),
    });
    return { samples: new Float32Array(waveform.data), sampleRate: KOKORO.sampleRate, channels: 1 };
  },
});
