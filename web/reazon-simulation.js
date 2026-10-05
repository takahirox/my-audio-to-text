import { joinAudio } from './audio.js';

// ReazonSpeech-only experiment: cumulative 1-second previews of disjoint
// 10-second windows. Capture continues while one offline decode is in flight.
export class ReazonSimulation {
  constructor(send, drained) {
    this.send = send; this.drained = drained;
    this.chunks = []; this.length = 0; this.previewLength = 0;
    this.inFlight = null; this.stopping = false; this.finished = false;
  }
  get waiting() { return this.length + (this.inFlight?.final ? this.inFlight.length : 0); }
  push(audio) {
    if (this.waiting + audio.length > 30 * 16000) {
      throw new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.');
    }
    this.chunks.push(audio); this.length += audio.length;
    this.pump();
  }
  snapshot(length, consume) {
    const chunks = []; let remaining = length;
    for (const chunk of this.chunks) {
      if (!remaining) break;
      const count = Math.min(remaining, chunk.length);
      chunks.push(chunk.subarray(0, count)); remaining -= count;
    }
    const audio = joinAudio(chunks);
    if (consume) {
      remaining = length;
      while (remaining) {
        const chunk = this.chunks.shift();
        if (remaining < chunk.length) {
          this.chunks.unshift(chunk.slice(remaining)); remaining = 0;
        } else remaining -= chunk.length;
      }
      this.length -= length;
    }
    return audio;
  }
  pump() {
    if (this.inFlight || this.finished) return;
    const final = this.length >= 10 * 16000 || this.stopping;
    if (!this.length) {
      if (this.stopping) { this.finished = true; this.drained(); }
      return;
    }
    if (!final && this.length - this.previewLength < 16000) return;
    const length = Math.min(this.length, 10 * 16000);
    const audio = this.snapshot(length, final);
    this.previewLength = final ? 0 : length;
    this.inFlight = { length, final };
    this.send({ type: 'decode', audio, final });
  }
  decoded() { this.inFlight = null; this.pump(); }
  stop() { this.stopping = true; this.pump(); }
}
