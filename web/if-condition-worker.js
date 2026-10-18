import { IF_CONDITION_MODEL, decisionFromLogits } from './if-condition-model.js';
import { validateCondition, validateText, MAX_PROMPT_TOKENS } from './if-condition-policy.js';
import { translationRuntime } from './translation-worker.js';
import { cacheOnlyIfConditionRuntime } from '../extension/if-condition-cache.js';

let classifier, condition, queue = Promise.resolve();
async function load(value) {
  if (classifier) throw new Error('IfCondition Worker already loaded.');
  condition = validateCondition(value);
  const { pipeline, env } = await translationRuntime();
  // Executable JS/WASM is packaged. This verified cache adapter cannot download
  // weights at Start or inference; optional lookups get local 404s, never cloud.
  await cacheOnlyIfConditionRuntime(env);
  classifier = await pipeline('text-classification', IF_CONDITION_MODEL.id, {
    ...IF_CONDITION_MODEL, progress_callback: event => self.postMessage({ type: 'progress', message: `Loading IfCondition: ${event.status}` }),
  });
  const labels = classifier.model.config.label2id;
  if (labels?.entailment !== 0 || labels?.not_entailment !== 1 || Object.keys(labels).length !== 2) throw new Error('IfCondition model has incompatible binary labels.');
}
async function decide(text) {
  if (!classifier) throw new Error('IfCondition model is not ready.');
  validateText(text);
  // Separate sequence inputs to the binary NLI classifier: text is the premise,
  // the user's natural-language condition is the hypothesis. Neither is code.
  const inputs = classifier.tokenizer(text, { text_pair: condition, truncation: false });
  if (inputs.input_ids.dims.at(-1) > MAX_PROMPT_TOKENS) throw new RangeError('IfCondition text and condition exceed 512 tokens. Shorten them; no input was truncated.');
  const { logits } = await classifier.model(inputs);
  if (logits.dims.length !== 2 || logits.dims[0] !== 1 || logits.dims[1] !== 2) throw new Error('Invalid IfCondition logits shape.');
  return decisionFromLogits(logits.data);
}
// One owned Worker and one inference at a time. Cancel terminates this Worker
// even during load/inference, invalidating every pending reply at the Node.
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { type, id } = data;
    try {
      if (type === 'load') { await load(data.condition); self.postMessage({ type: 'ready', id }); }
      else if (type === 'decide') self.postMessage({ type: 'result', id, ...await decide(data.text) });
      else if (type === 'drain') self.postMessage({ type: 'drained', id });
      else throw new Error(`Unknown IfCondition request: ${type}`);
    } catch (error) { self.postMessage({ type: 'error', id, message: error.message || String(error) }); }
  });
};
