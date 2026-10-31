import { TEXT, NUMBER } from './port-contracts.js';

export function validateWindowThreshold(port, value) {
  if (port === 'maxChars') {
    if (!Number.isSafeInteger(value) || value < 2) throw RangeError('TextWindow.maxChars must be a NUMBER whole number of at least 2 UTF-16 code units.');
  } else if (port === 'maxWaitSeconds') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2147483.647) throw RangeError('TextWindow.maxWaitSeconds must be a finite NUMBER greater than 0 and at most 2147483.647 seconds.');
  } else throw TypeError(`Unknown TextWindow input: ${port}.`);
  return value;
}

export class TextWindowNode {
  inputs = { text: TEXT, maxChars: NUMBER, maxWaitSeconds: NUMBER };
  outputs = { text: TEXT };
  maxChars = 600;
  maxWaitSeconds = 1.5;
  pending = '';
  timer = null;
  start(context) {
    this.context = context;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
  }
  clearTimer() {
    clearTimeout(this.timer); this.timer = null; this.deadlineToken = null;
  }
  schedule() {
    this.clearTimer();
    if (!this.pending || this.stopped || this.context.signal.aborted) return;
    const remaining = this.openedAt + this.maxWaitSeconds * 1000 - Date.now();
    if (remaining <= 0) { this.flush(); return; }
    const token = this.deadlineToken = {};
    this.timer = setTimeout(() => {
      if (this.deadlineToken !== token || this.stopped || this.context.signal.aborted) return;
      this.flush();
    }, Math.ceil(remaining));
  }
  flush(end = this.pending.length) {
    this.clearTimer();
    if (!end || this.context.signal.aborted) return;
    const text = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    this.openedAt = this.pending ? Date.now() : null;
    this.context.emit('text', text);
  }
  flushLength() {
    while (!this.stopped && !this.context.signal.aborted && this.pending.length >= this.maxChars) {
      let end = this.maxChars;
      // A hard UTF-16 bound must not split a surrogate pair inside the buffer.
      if (/[\uD800-\uDBFF]/.test(this.pending[end - 1]) && /[\uDC00-\uDFFF]/.test(this.pending[end] || '')) end--;
      this.flush(end);
    }
  }
  receive(port, value) { this.receiveInputs({ [port]: value }); }
  receiveInputs(values) {
    // Validate the whole delivery before changing limits or accepting text.
    for (const [port, value] of Object.entries(values)) {
      if (port !== 'text') validateWindowThreshold(port, value);
      else {
        if (typeof value !== 'string') throw TypeError('TextWindow expects TEXT on text.');
        if (value.length > 32768) throw RangeError('TextWindow accepts at most 32,768 characters per input. Split the source input before retrying.');
      }
    }
    if (this.stopped || this.context.signal.aborted) return;
    for (const port of ['maxChars', 'maxWaitSeconds']) if (Object.hasOwn(values, port)) this[port] = values[port];
    if (values.text) {
      if (!this.pending) this.openedAt = Date.now();
      this.pending += values.text;
    }
    this.flushLength();
    this.schedule();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.flush();
    this.context?.signal.removeEventListener('abort', this.abort);
  }
  dispose() {
    this.stopped = true; this.clearTimer(); this.pending = ''; this.openedAt = null;
    this.context?.signal.removeEventListener('abort', this.abort);
  }
}
