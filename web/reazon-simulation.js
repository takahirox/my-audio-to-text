import { joinAudio } from './audio.js';

const RATE = 16000;
export const PRE_ROLL = 0.8 * RATE;
export const PREVIEW_INTERVAL = 0.5 * RATE;
export const TRAILING_SILENCE = 0.35 * RATE;
export const MAX_SPEECH = 12 * RATE;
export const BUFFER_LIMIT = 30 * RATE;

// ReazonSpeech-only policy. Input blocks have already been classified by Silero.
// Finals take priority; there is no provisional queue, just the latest snapshot.
export class ReazonSimulation {
  constructor(send, drained, speech = () => {}) {
    this.send = send; this.drained = drained; this.speech = speech;
    this.preRoll = new Float32Array(); this.active = null; this.nextId = 0;
    this.finals = []; this.inFlight = null; this.stopping = false; this.finished = false;
  }
  get waiting() {
    return (this.active?.length || 0) + this.finals.reduce((sum, item) => sum + item.audio.length, 0)
      + (this.inFlight?.final ? this.inFlight.length : 0);
  }
  push(audio, speaking) {
    if (this.stopping || this.finished) return;
    if (this.waiting + audio.length + (!this.active && speaking ? this.preRoll.length : 0) > BUFFER_LIMIT) {
      throw new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.');
    }
    let offset = 0;
    while (offset < audio.length) {
      if (!this.active) {
        if (!speaking) {
          // Only idle audio enters pre-roll; never repeat a committed boundary.
          this.preRoll = joinAudio([this.preRoll, audio.subarray(offset)]).slice(-PRE_ROLL);
          break;
        }
        this.active = { id: ++this.nextId, chunks: [this.preRoll], length: this.preRoll.length,
          duration: 0, silence: 0, previewDuration: 0, speaking: true };
        this.preRoll = new Float32Array(); this.speech('started');
      }
      const item = this.active;
      const count = Math.min(audio.length - offset, MAX_SPEECH - item.duration,
        speaking ? Infinity : TRAILING_SILENCE - item.silence);
      const chunk = audio.slice(offset, offset + count);
      item.chunks.push(chunk); item.length += count; item.duration += count;
      item.silence = speaking ? 0 : item.silence + count; item.speaking = speaking;
      offset += count;
      if (item.duration === MAX_SPEECH || item.silence === TRAILING_SILENCE) this.finalize();
    }
    this.pump();
  }
  finalize() {
    if (!this.active) return;
    this.finals.push({ id: this.active.id, audio: joinAudio(this.active.chunks) });
    this.active = null; this.speech('completed');
  }
  acceptsPartial(id) { return !this.stopping && this.active?.id === id; }
  pump() {
    if (this.inFlight || this.finished) return;
    const final = this.finals.shift();
    if (final) {
      this.inFlight = { id: final.id, length: final.audio.length, final: true };
      this.send({ type: 'decode', ...final, final: true });
      return;
    }
    const item = this.active;
    if (this.stopping) {
      this.finished = true; this.drained(); return;
    }
    if (!item?.speaking || item.duration - item.previewDuration < PREVIEW_INTERVAL) return;
    item.previewDuration = item.duration;
    const audio = joinAudio(item.chunks);
    this.inFlight = { id: item.id, length: audio.length, final: false };
    this.send({ type: 'decode', audio, id: item.id, final: false });
  }
  decoded() { this.inFlight = null; this.pump(); }
  stop() { this.stopping = true; this.preRoll = new Float32Array(); this.finalize(); this.pump(); }
}
