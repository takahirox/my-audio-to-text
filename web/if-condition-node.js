import { TEXT } from './port-contracts.js';

// Inference-agnostic conditional router. A local decision backend must be supplied
// explicitly; this is not a keyword matcher or a substitute for actual inference.
export class IfConditionNode {
  inputs = { text: TEXT };
  outputs = { yes: TEXT, no: TEXT };

  constructor({ condition, threshold = 0.5, decide } = {}) {
    if (typeof condition !== 'string' || !condition.trim() || condition.length > 512) {
      throw new TypeError('IfCondition requires a nonempty condition (up to 512 characters).');
    }
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('IfCondition threshold must be between 0 and 1.');
    }
    if (typeof decide !== 'function') {
      throw new TypeError('IfCondition needs a local inference backend; no fallback or fake decision is allowed.');
    }
    this.condition = condition;
    this.threshold = threshold;
    this.decide = decide;
  }

  // The Pipeline serializes each consumer's asynchronous receive calls. Only
  // one of two output ports is emitted, preserving the original TEXT verbatim.
  async receive(port, value, context) {
    if (port !== 'text' || typeof value !== 'string') {
      throw new TypeError('IfCondition expects a TEXT input.');
    }
    context.signal.throwIfAborted();
    const score = await this.decide(value, this.condition, context.signal);
    context.signal.throwIfAborted();
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new TypeError('IfCondition backend must return a probability in [0, 1].');
    }
    context.emit(score >= this.threshold ? 'yes' : 'no', value);
  }
}
