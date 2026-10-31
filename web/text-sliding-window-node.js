import { TEXT, NUMBER } from './port-contracts.js';

function maxCharsValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw RangeError('TextSlidingWindow.maxChars must be a positive safe integer (UTF-16 code units).');
  return value;
}

function* sentenceStarts(text, segmenter) {
  if (segmenter) {
    for (const { index } of segmenter.segment(text)) if (index) yield index;
  } else {
    // Conservative fallback: Japanese punctuation needs no following space;
    // English punctuation must be followed by whitespace or the end of input.
    for (const match of text.matchAll(/(?:[。！？]["'”’」』）)\]]*\s*|[.!?]["'”’)\]]*(?:\s+|$))/gu)) {
      const end = match.index + match[0].length;
      if (end < text.length) yield end;
    }
  }
}

function* wordStarts(text, segmenter) {
  if (segmenter) {
    for (const { index, isWordLike } of segmenter.segment(text)) if (index && isWordLike) yield index;
  } else {
    for (const match of text.matchAll(/\S+/gu)) if (match.index) yield match.index;
  }
}

function retainSuffix(text, maxChars, sentenceSegmenter, wordSegmenter) {
  if (text.length <= maxChars) return text;
  // Keep the earliest boundary that fits. If the newest sentence/word itself
  // is too long, discard its predecessors before trying the next granularity.
  for (const [starts, segmenter] of [[sentenceStarts, sentenceSegmenter], [wordStarts, wordSegmenter]]) {
    let last = 0;
    for (const index of starts(text, segmenter)) {
      last = index;
      if (text.length - index <= maxChars) return text.slice(index);
    }
    text = text.slice(last);
  }
  let start = Math.max(0, text.length - maxChars);
  // Move forward, never backward beyond the bound, if the cut splits a pair.
  if (start && /[\uD800-\uDBFF]/u.test(text[start - 1]) && /[\uDC00-\uDFFF]/u.test(text[start])) start++;
  return text.slice(start);
}

export class TextSlidingWindowNode {
  inputs = { text: TEXT, maxChars: NUMBER };
  outputs = { text: TEXT };
  constructor() {
    this.buffer = ''; this.maxChars = 1000; this.stopped = true;
    if (typeof Intl.Segmenter === 'function') {
      this.sentenceSegmenter = new Intl.Segmenter('und', { granularity: 'sentence' });
      this.wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });
    }
  }
  start(context) {
    this.dispose();
    this.context = context; this.maxChars = 1000; this.stopped = context.signal.aborted;
    this.abort = () => this.dispose();
    if (!this.stopped) context.signal.addEventListener('abort', this.abort, { once: true });
  }
  receiveInputs(values, context = this.context) {
    if (this.stopped || this.context?.signal.aborted || context?.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (port === 'maxChars') maxCharsValue(value);
      else if (port !== 'text' || typeof value !== 'string') throw TypeError('TextSlidingWindow expects text: TEXT and optional maxChars: NUMBER.');
    }
    // Apply an atomic group's bound before its text, regardless of port order.
    if (Object.hasOwn(values, 'maxChars')) this.maxChars = values.maxChars;
    const hasText = Object.hasOwn(values, 'text');
    this.buffer = retainSuffix(this.buffer + (hasText ? values.text : ''), this.maxChars, this.sentenceSegmenter, this.wordSegmenter);
    if (hasText) context.emit('text', this.buffer);
  }
  receive(port, value, context = this.context) { this.receiveInputs({ [port]: value }, context); }
  stop() { this.dispose(); }
  cancel() { this.dispose(); }
  dispose() {
    this.stopped = true; this.buffer = '';
    this.context?.signal.removeEventListener('abort', this.abort);
    this.context = undefined;
  }
}
