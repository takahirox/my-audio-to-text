// Independent browser implementation of FunAudioLLM's Apache-2.0 inference
// algorithm; no Quick Inference runtime code or patched ORT binaries.
import * as ort from './tts-assets/qwen3/ort.webgpu.min.mjs';
import { Qwen2Tokenizer } from './tts-assets/transformers.js';
import { streamingCosyVoice3Flow, streamingCosyVoice3Hift, cosyVoice3Mask } from './cosyvoice3-onnx.js';

const TEXT_VOCAB = 151936, SOS = 6561, TASK = 6563, MAX_TOKENS = 500;
const SILENT = new Set([1, 2, 28, 29, 55, 248, 494, 2241, 2242, 2322, 2323]);
const T = (data, dims) => new ort.Tensor('float32', data, dims);
const ids = values => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length]);
const free = values => Object.values(values).forEach(value => value.dispose());
const melSlice = (data, frames, start, end) => {
  const out = new Float32Array(80 * (end - start));
  for (let c = 0; c < 80; c++) out.set(data.subarray(c * frames + start, c * frames + end), c * (end - start));
  return out;
};
function sample(logits, history, minimum) {
  const values = Array.from(logits);
  if (!values.every(Number.isFinite)) throw Error('CosyVoice3 produced invalid logits. Check GPU memory and restart.');
  if (minimum) values[SOS] = -Infinity; // Upstream sampling_ids masks index speech_token_size.
  const max = Math.max(...values), weights = values.map(v => Math.exp(v - max));
  const draw = entries => {
    let n = Math.random() * entries.reduce((sum, [w]) => sum + w, 0);
    for (const [w, i] of entries) { n -= w; if (n <= 0 && w > 0) return i; }
    throw Error('CosyVoice3 has no next token.');
  };
  const sorted = weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]);
  const total = weights.reduce((a, b) => a + b, 0); let mass = 0, count = 0;
  do { mass += sorted[count++][0]; } while (count < 25 && mass < total * .8);
  const token = draw(sorted.slice(0, count));
  if (!history.slice(-10).includes(token)) return token;
  weights[token] = 0; return draw(weights.map((w, i) => [w, i]));
}

export class CosyVoice3Runtime {
  static async create(read, progress = () => {}) {
    if (!await navigator.gpu?.requestAdapter()) throw Error('CosyVoice3 requires desktop Worker WebGPU; no CPU/cloud fallback.');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./tts-assets/qwen3/', import.meta.url).href;
    const runtime = new CosyVoice3Runtime(); runtime.sessions = {};
    try {
      for (const [name, file] of [['embed', 'embed_q4'], ['llm', 'llm_q8'], ['encoder', 'flow_encoder_q4'], ['flow', 'flow_step_q8'], ['hift', 'hift_q4c8']]) {
        progress(`Loading local CosyVoice3 ${name}…`);
        let bytes = await read(`onnx/${file}.onnx`);
        if (name === 'flow') bytes = await streamingCosyVoice3Flow(bytes);
        if (name === 'hift') bytes = await streamingCosyVoice3Hift(bytes);
        const options = { executionProviders: ['webgpu'] };
        if (name === 'flow') options.preferredOutputLocation = { x_next: 'gpu-buffer' };
        if (name === 'llm') {
          options.preferredOutputLocation = {};
          for (let i = 0; i < 24; i++) for (const k of ['key', 'value']) options.preferredOutputLocation[`present.${i}.${k}`] = 'gpu-buffer';
        }
        runtime.sessions[name] = await ort.InferenceSession.create(bytes, options);
      }
      runtime.voice = JSON.parse(new TextDecoder().decode(await read('voice_default.json')));
      runtime.tokenizer = new Qwen2Tokenizer(JSON.parse(new TextDecoder().decode(await read('tokenizer.json'))),
        { tokenizer_class: 'Qwen2Tokenizer', eos_token: '<|im_end|>', pad_token: '<|endoftext|>' });
      const half = new Uint16Array((await read('flow_noise_f16.bin')).buffer);
      runtime.flowNoise = Float32Array.from(half, v => {
        const s = v >> 15 ? -1 : 1, e = (v >> 10) & 31, f = v & 1023;
        return s * (e ? 2 ** (e - 15) * (1 + f / 1024) : 2 ** -14 * f / 1024);
      });
      return runtime;
    } catch (error) { await runtime.dispose(); throw error; }
  }
  async embed(values) {
    const input = ids(values);
    try { return (await this.sessions.embed.run({ ids: input })).embeds; }
    finally { input.dispose(); }
  }
  async mel(tokens, finalize) {
    const voice = this.voice, all = [...voice.prompt_speech_tokens, ...tokens];
    const input = { tokens: ids(all), embedding: T(Float32Array.from(voice.embedding), [1, 192]),
      prompt_feat: T(Float32Array.from(voice.prompt_feat), [1, voice.prompt_feat_shape[0], 80]) };
    let enc, mu, cond, mask, x;
    try {
      enc = await this.sessions.encoder.run(input);
      // Three real future tokens replace the export's right zero padding.
      // Drop their outputs; all earlier pre-lookahead convolutions are intact.
      const frames = all.length * 2 - (finalize ? 0 : 6);
      mu = T(melSlice(enc.mu.data, all.length * 2, 0, frames), [1, 80, frames]);
      cond = T(melSlice(enc.cond.data, all.length * 2, 0, frames), [1, 80, frames]);
      mask = new ort.Tensor('bool', cosyVoice3Mask(frames), [1, 1, frames, frames]);
      const noise = new Float32Array(80 * frames);
      for (let c = 0; c < 80; c++) noise.set(this.flowNoise.subarray(c * 3000, c * 3000 + frames), c * frames);
      x = T(noise, [1, 80, frames]);
      const span = Array.from({ length: 11 }, (_, i) => Math.fround(1 - Math.cos(Math.fround(Math.fround(i / 10) * Math.fround(Math.PI / 2)))));
      for (let i = 0; i < 10; i++) {
        const t = T(new Float32Array([span[i]]), [1]), dt = T(new Float32Array([Math.fround(span[i + 1] - span[i])]), [1]);
        try {
          const out = await this.sessions.flow.run({ x, mu, cond, spks: enc.spks, t, dt, streaming_mask: mask });
          x.dispose(); x = out.x_next;
        } finally { t.dispose(); dt.dispose(); }
      }
      return melSlice(await x.getData(), frames, voice.prompt_feat_shape[0], frames);
    } finally { free(input); if (enc) free(enc); mu?.dispose(); cond?.dispose(); mask?.dispose(); x?.dispose(); }
  }
  async vocode(mel, noise) {
    const frames = mel.length / 80;
    const input = { mel: T(mel, [1, 80, frames]), noise: T(noise.subarray(0, frames * 480 * 9), [1, frames * 480, 9]) }; let out;
    try { out = await this.sessions.hift.run(input); return Float32Array.from(out.audio.data); }
    finally { free(input); if (out) free(out); }
  }
  async generate(text, settings, emit) {
    const textIds = this.tokenizer.encode(text.normalize('NFKC'), { add_special_tokens: false });
    if (textIds.length > 128) throw Error('CosyVoice3 accepts at most 128 text tokens. Split longer committed input.');
    const voice = this.voice, history = [], kept = [];
    let cache = {}, length = 0, embeds, silent = 0, tokenOffset = 0, mel = new Float32Array(), emitted = 0;
    const noise = Float32Array.from({ length: MAX_TOKENS * 2 * 480 * 9 }, Math.random);
    for (let i = 0; i < 24; i++) for (const k of ['key', 'value']) cache[`past_key_values.${i}.${k}`] = T(new Float32Array(), [1, 2, 0, 64]);
    // Prompt length must align with the trained 25-token/50-mel attention grid.
    let hop = 25 + (25 - voice.prompt_speech_tokens.length % 25) % 25;
    const decode = async finalize => {
      const next = await this.mel(kept, finalize), nextFrames = next.length / 80;
      const oldFrames = mel.length / 80, newFrames = nextFrames - tokenOffset * 2;
      if (newFrames <= 0) return;
      const joined = new Float32Array(80 * (oldFrames + newFrames));
      for (let c = 0; c < 80; c++) {
        joined.set(mel.subarray(c * oldFrames, (c + 1) * oldFrames), c * (oldFrames + newFrames));
        joined.set(next.subarray(c * nextFrames + tokenOffset * 2, (c + 1) * nextFrames), c * (oldFrames + newFrames) + oldFrames);
      }
      mel = joined; tokenOffset = kept.length - (finalize ? 0 : 3);
      const pcm = await this.vocode(mel, noise);
      // HiFT needs 3 F0 + 4 conv-pre + 1 iSTFT mel frames of right context.
      const end = finalize ? pcm.length : pcm.length - 8 * 480;
      if (end > emitted) { const chunk = pcm.slice(emitted, end); emitted = end; await emit(chunk, { synthesisComplete: finalize, generatedSpeechTokens: kept.length }); }
    };
    try {
      embeds = await this.embed([TEXT_VOCAB + SOS, ...voice.prompt_text_ids, ...textIds, TEXT_VOCAB + TASK, ...voice.prompt_speech_tokens.map(t => TEXT_VOCAB + t)]);
      const limit = Math.min(MAX_TOKENS, textIds.length * 20);
      for (let i = 0; i < limit; i++) {
        length += embeds.dims[1]; const attention_mask = ids(Array(length).fill(1)); let out;
        try { out = await this.sessions.llm.run({ inputs_embeds: embeds, attention_mask, ...cache }); }
        finally { embeds.dispose(); embeds = null; attention_mask.dispose(); }
        free(cache); cache = {};
        for (let layer = 0; layer < 24; layer++) for (const k of ['key', 'value']) cache[`past_key_values.${layer}.${k}`] = out[`present.${layer}.${k}`];
        let token;
        try { token = sample(out.logits.data.slice(-6761), history, i < textIds.length * 2); }
        finally { out.logits.dispose(); }
        if (token >= SOS) { if (kept.length) await decode(true); return; }
        history.push(token); silent = SILENT.has(token) ? silent + 1 : 0;
        if (silent <= 5) kept.push(token);
        if (kept.length - tokenOffset >= hop + 3) { await decode(false); hop = 25; }
        embeds = await this.embed([TEXT_VOCAB + token]);
      }
      throw Error('CosyVoice3 reached its token/20-second limit without EOS. Shorten this utterance and restart.');
    } finally { embeds?.dispose(); free(cache); }
  }
  async dispose() { for (const session of Object.values(this.sessions)) await session.release(); this.sessions = {}; }
}
