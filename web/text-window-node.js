import { TEXT } from './port-contracts.js';

export function windowSettings({ maxChars = 600, maxWaitMs = 1500, sentenceBoundary = 'on' } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > 1000) throw Error('maxChars must be a whole number from 2 to 1000.');
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 30000) throw Error('maxWaitMs must be a whole number from 1 to 30000.');
  if (!['on', 'off'].includes(sentenceBoundary)) throw Error('sentenceBoundary must be on or off.');
  return { maxChars, maxWaitMs, sentenceBoundary };
}

// Deliberately conservative, not a sentence tokenizer. Decimal points, initials
// and common English abbreviations do not close a window. No punctuation is
// required: length, deadline and Stop also close it.
function sentenceEnd(text) {
  const punctuation = /[.!?。！？]["'”’)\]]?(?:\s+|$)/gu;
  for (const match of text.matchAll(punctuation)) {
    if (match[0][0] === '.') {
      const word = text.slice(0, match.index).match(/([\p{L}.]+)$/u)?.[1] || '';
      if (word.length < 3 || word.includes('.') || /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc)$/i.test(word)) continue;
      if (/\d$/.test(text.slice(0, match.index))) continue;
    }
    return match.index + match[0].length;
  }
  return 0;
}

export class TextWindowNode {
  inputs = { text: TEXT };
  outputs = { text: TEXT, provisional: TEXT };
  constructor(settings = {}) { Object.assign(this, windowSettings(settings)); this.pending = ''; }
  start(context) {
    this.context = context;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
  }
  schedule() {
    if (!this.pending || this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.context.signal.aborted && !this.stopped) this.flush();
    }, this.maxWaitMs);
  }
  flush(end = this.pending.length) {
    clearTimeout(this.timer); this.timer = null;
    if (!end || this.context.signal.aborted) return;
    const text = this.pending.slice(0, end); this.pending = this.pending.slice(end);
    this.context.emit('text', text);
    this.schedule();
  }
  receive(port, text) {
    if (port !== 'text' || typeof text !== 'string') throw TypeError('TextWindow expects TEXT on text.');
    if (text.length > 32768) throw RangeError('TextWindow accepts at most 32,768 characters per input. Split the source input before retrying.');
    if (this.stopped || this.context.signal.aborted || !text) return;
    // Preserve every input code unit; insert one space only at an adjacent
    // utterance boundary lacking whitespace. Never trim or deduplicate.
    if (this.pending && !/\s$/u.test(this.pending) && !/^\s/u.test(text)) this.add(' ');
    this.add(text);
    if (this.pending) this.context.emit('provisional', this.pending);
    this.schedule();
  }
  flushLimit() {
    const space = [...this.pending.matchAll(/\s+/gu)].at(-1);
    this.flush(space?.index > 0 ? space.index + space[0].length : this.pending.length);
  }
  add(text) {
    let offset = 0;
    while (offset < text.length) {
      let count = Math.min(this.maxChars - this.pending.length, text.length - offset);
      // Keep surrogate pairs together across a hard length boundary.
      if (offset + count < text.length && /[\uD800-\uDBFF]/.test(text[offset + count - 1]) && /[\uDC00-\uDFFF]/.test(text[offset + count])) count--;
      if (!count) { this.flushLimit(); continue; }
      this.pending += text.slice(offset, offset + count); offset += count;
      let end;
      while (this.sentenceBoundary === 'on' && (end = sentenceEnd(this.pending))) this.flush(end);
      if (this.pending.length === this.maxChars) this.flushLimit();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.flush();
    clearTimeout(this.timer); this.timer = null;
  }
  dispose() {
    this.stopped = true; clearTimeout(this.timer); this.timer = null; this.pending = '';
    this.context?.signal.removeEventListener('abort', this.abort);
  }
}
