// Bounds apply independently to each IfCondition instance. No input truncation.
export const MAX_CONDITION_CHARS = 512;
export const MAX_TEXT_CHARS = 2048;
export const MAX_PROMPT_TOKENS = 512;
export const MAX_QUEUED_INPUTS = 32;
export const MAX_QUEUED_CHARS = 32768;
export const MIN_CONFIDENCE = 0.55;

export function validateCondition(condition) {
  if (typeof condition !== 'string' || !condition.trim() || condition.length > MAX_CONDITION_CHARS) {
    throw new TypeError(`IfCondition needs a nonempty condition of at most ${MAX_CONDITION_CHARS} characters.`);
  }
  return condition;
}
export function validateText(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) {
    throw new TypeError(`IfCondition accepts TEXT of at most ${MAX_TEXT_CHARS} characters; shorten the input.`);
  }
}

// This is uncertainty in model scores, not a calibrated probability of truth.
export function validateDecision(result) {
  if (!['yes', 'no'].includes(result?.branch) || !Number.isFinite(result.confidence)
      || result.confidence < MIN_CONFIDENCE || result.confidence > 1) {
    throw new Error('IfCondition decision is ambiguous or invalid. No branch was emitted; revise the condition and Start again.');
  }
  return result.branch;
}
