// Qwen3-TTS 0.6B CustomVoice, using the reviewed ONNX exports described in
// docs/streaming-tts.md. This implementation follows Qwen's Apache-2.0 model
// algorithm; it does not incorporate Quick Inference's noncommercial runtime.
import * as ort from './tts-assets/qwen3/ort.webgpu.min.mjs';
import { Qwen2Tokenizer } from './tts-assets/transformers.js';

const WIDTH = 1024, GROUPS = 16, SAMPLES_PER_FRAME = 1920;
// Recompute the causal prefix, bounded at 20.48 seconds. Trimming context from
// this export changes later samples (stacked attention extends its history).
// Prefix recomputation preserves continuity without inventing codec cache state.
const CHUNK_FRAMES = 8, LOOKAHEAD = 2, MAX_FRAMES = 256;
const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
const ids = values => tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length]);
const sum = rows => {
  const result = new Float32Array(WIDTH);
  for (const row of rows) for (let i = 0; i < WIDTH; i++) result[i] += row[i];
  return result;
};
function sample(logits) {
  if (!logits.every(value => Number.isFinite(value) || value === -Infinity)) throw Error('Qwen3-TTS produced invalid logits. Cancel and restart; check available GPU memory.');
  const top = Array.from(logits, (value, index) => [value, index]).sort((a, b) => b[0] - a[0]).slice(0, 50);
  const weights = top.map(([value]) => Math.exp((value - top[0][0]) / 0.9));
  let remaining = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) { remaining -= weights[i]; if (remaining <= 0) return top[i][1]; }
  throw Error('Qwen3-TTS has no valid next speech token.');
}

// The two decoders use float32 activations/cache and GPU-resident KV tensors.
// JS samples the final row of the returned logits/hidden state.
class Decoder {
  constructor(session, layers) {
    this.session = session; this.layers = layers; this.length = 0; this.cache = {};
    for (let i = 0; i < layers; i++) for (const key of ['key', 'value']) {
      this.cache[`past_key_values.${i}.${key}`] = tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
    }
  }
  async run(rows) {
    const data = new Float32Array(rows.length * WIDTH);
    rows.forEach((row, i) => data.set(row, i * WIDTH));
    const embeds = tensor('float32', data, [1, rows.length, WIDTH]);
    const mask = ids(Array(this.length + rows.length).fill(1));
    let result;
    try { result = await this.session.run({ inputs_embeds: embeds, attention_mask: mask, ...this.cache }); }
    finally { embeds.dispose(); mask.dispose(); }
    this.dispose(); this.cache = {}; this.length += rows.length;
    for (let i = 0; i < this.layers; i++) for (const key of ['key', 'value']) {
      this.cache[`past_key_values.${i}.${key}`] = result[`present.${i}.${key}`];
    }
    try {
      return { logits: Float32Array.from(result.logits.data.slice(-result.logits.dims.at(-1))),
        hidden: Float32Array.from(result.hidden_states.data.slice(-WIDTH)) };
    } finally { result.logits.dispose(); result.hidden_states.dispose(); }
  }
  dispose() { for (const value of Object.values(this.cache)) value.dispose(); this.cache = {}; }
}

export class Qwen3TtsRuntime {
  static async create(read, progress = () => {}) {
    if (!await navigator.gpu?.requestAdapter()) throw Error('Qwen3-TTS requires Worker WebGPU. Enable hardware acceleration and use a current desktop Chrome; no CPU/cloud fallback is provided.');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./tts-assets/qwen3/', import.meta.url).href;
    const runtime = new Qwen3TtsRuntime(); runtime.sessions = {};
    try {
      for (const [name, file, layers] of [['codec', 'codec_embed_q4.onnx', 0], ['text', 'text_embed_q4.onnx', 0],
        ['talker', 'talker/model.onnx', 28], ['predictor', 'code_predictor/model.onnx', 5], ['decoder', 'speech_tokenizer/tok_decoder_q4.onnx', 0]]) {
        progress(`Loading local Qwen3-TTS ${name}…`);
        const options = { executionProviders: ['webgpu'] };
        if (layers) {
          options.externalData = [{ path: 'model.onnx.data', data: await read(file + '.data') }];
          options.preferredOutputLocation = {};
          for (let i = 0; i < layers; i++) for (const key of ['key', 'value']) options.preferredOutputLocation[`present.${i}.${key}`] = 'gpu-buffer';
        }
        runtime.sessions[name] = await ort.InferenceSession.create(await read(file), options);
      }
      runtime.config = JSON.parse(new TextDecoder().decode(await read('config.json')));
      runtime.tokenizer = new Qwen2Tokenizer(JSON.parse(new TextDecoder().decode(await read('tokenizer.json'))),
        { tokenizer_class: 'Qwen2Tokenizer', eos_token: '<|im_end|>', pad_token: '<|endoftext|>' });
      return runtime;
    } catch (error) { await runtime.dispose(); throw error; }
  }
  async embed(name, values) {
    const input = ids(values); let result;
    try {
      result = await this.sessions[name].run({ ids: input });
      return values.map((_, i) => Float32Array.from(result.embeds.data.slice(i * WIDTH, (i + 1) * WIDTH)));
    } finally { input.dispose(); result?.embeds.dispose(); }
  }
  async decode(frames) {
    const codes = new BigInt64Array(frames.length * GROUPS);
    frames.forEach((frame, i) => frame.forEach((code, j) => { codes[j * frames.length + i] = BigInt(code); }));
    const input = tensor('int64', codes, [1, GROUPS, frames.length]); let result;
    try { result = await this.sessions.decoder.run({ codes: input }); return Float32Array.from(result.audio.data); }
    finally { input.dispose(); result?.audio.dispose(); }
  }
  async generate(text, { language, voice }, emit) {
    const cfg = this.config, tc = cfg.talker_config;
    const encode = text => this.tokenizer.encode(text, { add_special_tokens: false });
    // Qwen's role prefix and text body exclude the trailing chat template tokens.
    const role = encode('<|im_start|>assistant\n');
    const body = encode(`assistant\n${text}`).slice(encode('assistant\n').length);
    if (body.length > 256) throw Error('Qwen3-TTS accepts at most 256 text tokens. Split this committed utterance into shorter inputs.');
    const [bos, eos, pad] = await this.embed('text', [cfg.tts_bos_token_id, cfg.tts_eos_token_id, cfg.tts_pad_token_id]);
    const codec = await this.embed('codec', [tc.codec_think_id, tc.codec_think_bos_id, tc.codec_language_id[language],
      tc.codec_think_eos_id, tc.spk_id[voice], tc.codec_pad_id, tc.codec_bos_id]);
    const rows = await this.embed('text', role);
    codec.slice(0, -1).forEach((row, i) => rows.push(sum([i < codec.length - 2 ? pad : bos, row])));
    const codecPad = (await this.embed('codec', [tc.codec_pad_id]))[0];
    for (const row of [...await this.embed('text', body), eos]) rows.push(sum([row, codecPad]));
    rows.push(sum([pad, codec.at(-1)]));
    const talker = new Decoder(this.sessions.talker, 28), frames = [], seen = new Set();
    let emitted = 0, ended = false;
    const output = async final => {
      const end = final ? frames.length : frames.length - LOOKAHEAD;
      if (end <= emitted) return;
      const pcm = await this.decode(frames);
      const samples = pcm.slice(emitted * SAMPLES_PER_FRAME, end * SAMPLES_PER_FRAME);
      if (!samples.length || !samples.every(Number.isFinite)) throw Error('Qwen3-TTS decoder produced invalid PCM.');
      emitted = end;
      // This awaits a Worker acknowledgment; only one PCM message is in flight.
      await emit(samples);
    };
    try {
      let { logits, hidden } = await talker.run(rows);
      const limit = Math.min(MAX_FRAMES, 25 + 9 * body.length);
      for (let step = 0; step < limit; step++) {
        for (const token of seen) logits[token] = logits[token] < 0 ? logits[token] * 1.05 : logits[token] / 1.05;
        for (let token = 2048; token < 3072; token++) if (token !== tc.codec_eos_token_id) logits[token] = -Infinity;
        if (step < 2) logits[tc.codec_eos_token_id] = -Infinity;
        const first = sample(logits);
        if (first === tc.codec_eos_token_id) { ended = true; break; }
        const frame = [first], predictor = new Decoder(this.sessions.predictor, 5);
        try {
          let input = [hidden, (await this.embed('codec', [first]))[0]];
          for (let j = 0; j < GROUPS - 1; j++) {
            const result = await predictor.run(input), code = sample(result.logits.subarray(j * 2048, (j + 1) * 2048));
            frame.push(code);
            if (j < GROUPS - 2) input = await this.embed('codec', [3072 + j * 2048 + code]);
          }
        } finally { predictor.dispose(); }
        frames.push(frame); seen.add(first);
        if (frames.length - emitted >= CHUNK_FRAMES + LOOKAHEAD) await output(false);
        const embeddings = await this.embed('codec', frame.map((code, j) => j === 0 ? code : 3072 + (j - 1) * 2048 + code));
        ({ logits, hidden } = await talker.run([sum([...embeddings, pad])]));
      }
      if (!ended) throw Error('Qwen3-TTS reached its generation limit without an end token. Playback of this utterance was aborted; use a shorter input.');
      await output(true);
    } finally { talker.dispose(); }
  }
  async dispose() { await Promise.allSettled(Object.values(this.sessions).map(session => session.release())); this.sessions = {}; }
}
