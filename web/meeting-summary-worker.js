import { meetingSummaryModel } from './meeting-summary-models.js';
import { summaryMessages, summaryText, MAX_PROMPT_TOKENS, MAX_NEW_TOKENS } from './meeting-summary-policy.js';
import { cacheOnlyMeetingSummaryRuntime } from '../extension/meeting-summary-cache.js';

let model, tokenizer, queue = Promise.resolve();
async function load(type) {
  if (model) throw new Error('Meeting summary Worker already loaded.');
  const spec = meetingSummaryModel(type);
  const adapter = await self.navigator.gpu?.requestAdapter();
  if (!adapter?.features.has('shader-f16')) throw new Error('Meeting summary requires Worker WebGPU with shader-f16. Check Chrome hardware acceleration and available GPU memory.');
  const { PreTrainedTokenizer, AutoModelForCausalLM, env } = await import('./vendor/meeting-summary/transformers.js');
  await cacheOnlyMeetingSummaryRuntime(env, type);
  env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL('./vendor/meeting-summary/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
    wasm: new URL('./vendor/meeting-summary/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
  };
  const options = { revision: spec.revision, dtype: spec.dtype, device: spec.device };
  // 4.2 AutoTokenizer's discovery probes main without forwarding revision.
  // Both exports declare TokenizersBackend (generic PreTrainedTokenizer).
  // Construct it from the exact verified JSONs, with no mutable alias/probe.
  const base = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/`;
  tokenizer = new PreTrainedTokenizer(
    await (await env.customCache.match(base + 'tokenizer.json')).json(),
    await (await env.customCache.match(base + 'tokenizer_config.json')).json());
  model = await AutoModelForCausalLM.from_pretrained(spec.id, options);
}
async function summarize({ previous, text, language }) {
  if (!model) throw new Error('Meeting summary model is not ready.');
  const started = performance.now();
  const formatted = tokenizer.apply_chat_template(summaryMessages(previous, text, language), {
    tokenize: false, add_generation_prompt: true, enable_thinking: false,
  });
  // Prefill only the first heading/list marker, never meeting content. This
  // encourages a readable note rather than a structured payload in small LMs.
  const prefix = language === 'ja' ? '議論の要点\n- ' : 'Discussion points\n- ';
  const inputs = tokenizer(formatted + prefix, { add_special_tokens: false, truncation: false });
  const promptTokens = inputs.input_ids.dims.at(-1);
  if (promptTokens + MAX_NEW_TOKENS > MAX_PROMPT_TOKENS) throw new RangeError('Meeting summary exceeds the 8192-token runtime budget. No evidence was truncated.');
  // Generation caches live only for this request; the note is the sole history.
  const output = await model.generate({ ...inputs, max_new_tokens: MAX_NEW_TOKENS, do_sample: false, repetition_penalty: 1.05 });
  const tokens = output.tolist()[0].slice(promptTokens);
  const eos = [model.generation_config?.eos_token_id ?? model.config.eos_token_id].flat().map(Number);
  if (tokens.length === MAX_NEW_TOKENS && !eos.includes(Number(tokens.at(-1)))) throw new Error('Meeting summary reached its output token limit; incomplete snapshot was not published.');
  const generated = summaryText(tokenizer.decode(tokens, { skip_special_tokens: true }));
  const summary = summaryText(prefix + generated);
  return { summary, metrics: { promptTokens, outputTokens: tokens.length, generationMs: performance.now() - started } };
}
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === 'load') { const started = performance.now(); await load(data.processor); self.postMessage({ type: 'ready', id: data.id, initializationMs: performance.now() - started }); }
      else if (data.type === 'summarize') self.postMessage({ type: 'result', id: data.id, ...await summarize(data) });
      else throw new Error('Unknown meeting summary request.');
    } catch (error) { self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) }); }
  });
};
