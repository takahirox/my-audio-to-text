import { QWEN3_CORRECTION, correctionMessages, validateInput, validateCandidate, MAX_PROMPT_TOKENS, GENERATION } from './correction-policy.js';
import { correctionCache } from './correction-cache.js';

let generator, language, queue = Promise.resolve();
const progress = event => self.postMessage({ ...event, type: 'progress' });
async function load(options) {
  if (generator) throw new Error('Correction Worker already loaded.');
  if (!['auto', 'ja', 'en'].includes(options.language)) throw new TypeError('Choose auto, ja or en.');
  if (!self.navigator.gpu) throw new Error('Qwen3 correction requires WebGPU in a secure browser Worker on HTTPS or localhost.');
  const adapter = await self.navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter is available for Qwen3 correction.');
  if (!adapter.features.has('shader-f16')) throw new Error('Qwen3 q4f16 requires a WebGPU adapter with shader-f16 support.');
  try {
    const { pipeline, env } = await import('./correction-assets/transformers.js');
    env.allowLocalModels = false;
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useWasmCache = false;
    env.useCustomCache = true;
    env.customCache = correctionCache(self.caches, progress);
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.wasmPaths = {
      mjs: new URL('./correction-assets/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
      wasm: new URL('./correction-assets/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
    };
    generator = await pipeline('text-generation', QWEN3_CORRECTION.id, {
      ...QWEN3_CORRECTION, progress_callback: progress,
    });
    language = options.language;
  } catch (error) {
    throw new Error(`Qwen3 loading failed: ${error.message || error}. Check asset access, cache and device memory; retry or bypass correction.`);
  }
}
async function correct(text) {
  if (!generator) throw new Error('Correction model is not ready.');
  validateInput(text);
  if (!text.trim()) return text; // exactly one output, no inference
  const prompt = generator.tokenizer.apply_chat_template(correctionMessages(text, language), {
    tokenize: false, add_generation_prompt: true, enable_thinking: false,
  });
  const inputs = generator.tokenizer(prompt);
  const length = inputs.input_ids.dims[1];
  if (length > MAX_PROMPT_TOKENS) throw new RangeError('Correction prompt exceeds 1,024 tokens. Shorten the final transcript.');
  const output = await generator.model.generate({ ...inputs, ...GENERATION });
  const rows = output.tolist();
  if (rows.length !== 1) throw new Error('Qwen3 returned multiple candidates.');
  const tokens = rows[0].slice(length);
  const eos = generator.model.config.eos_token_id;
  if (!(Array.isArray(eos) ? eos : [eos]).some(id => BigInt(id) === BigInt(tokens.at(-1) ?? -1))) {
    throw new Error('Qwen3 candidate reached its output limit without completing. Use the original or bypass correction.');
  }
  const candidate = generator.tokenizer.decode(tokens, { skip_special_tokens: true });
  return validateCandidate(candidate, text);
}
// Native Worker FIFO owns the model. Cancel terminates this Worker from the
// Node, aborting load/inference and invalidating all outstanding replies.
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { type, id } = data;
    try {
      if (type === 'load') { await load(data); self.postMessage({ type: 'ready', id }); }
      else if (type === 'correct') self.postMessage({ type: 'result', id, text: await correct(data.text) });
      else if (type === 'drain') self.postMessage({ type: 'drained', id });
      else throw new Error(`Unknown correction request: ${type}`);
    } catch (error) { self.postMessage({ type: 'error', id, message: error.message || String(error) }); }
  });
};
