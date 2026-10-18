import { validateDecision } from './if-condition-policy.js';

// Binary NLI classifier, trained for zero-shot labels and browser use. Selection
// and real MV3 evidence: docs/if-condition-node.md. No generative chat backend.
export const IF_CONDITION_MODEL = Object.freeze({
  id: 'MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33',
  revision: 'c07f66d9cbf781191bee66edfe8ad7856f045781', dtype: 'q8', device: 'wasm',
});
export function decisionFromLogits(logits) {
  if (logits?.length !== 2 || Array.from(logits).some(value => !Number.isFinite(value))) throw new Error('Invalid IfCondition binary model logits.');
  const maximum = Math.max(...logits);
  const yes = Math.exp(logits[0] - maximum), no = Math.exp(logits[1] - maximum);
  const result = { branch: yes > no ? 'yes' : 'no', confidence: Math.max(yes,no)/(yes+no) };
  validateDecision(result);
  return result;
}
