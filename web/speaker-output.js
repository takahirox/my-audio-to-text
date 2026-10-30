import { SYNTHESIZED_AUDIO, validateSynthesizedAudio } from './synthesized-audio.js';
import { AUDIO_STREAM, AUDIO_STREAM_LIMITS, validateAudioStream } from './audio-stream.js';

// Limits include the currently playing clip. No WAVs or object URLs are needed.
export const SPEAKER_LIMITS = Object.freeze({ clips: 32, seconds: 120, bytes: 32 * 1024 * 1024 });

export class SpeakerOutputNode {
  inputs = { audio: SYNTHESIZED_AUDIO };
  outputs = {};
  constructor({ contextFactory = () => new AudioContext(), onState = () => {} } = {}) {
    this.contextFactory = contextFactory;
    this.onState = onState;
    this.queue = [];
    this.seconds = 0;
    this.bytes = 0;
    this.rejected = 0;
    this.waiters = [];
  }
  report(message, needsActivation = false) {
    if (this.disposed) return;
    const overflow = this.rejected ? ` Queue full; ${this.rejected} clip(s) rejected. Stop to drain accepted audio, then Start again.` : '';
    this.onState({ message: message + overflow, needsActivation, overflow: !!this.rejected });
  }
  // Call synchronously from Start/Enable speaker, before permission/model awaits.
  // resume() can remain pending under autoplay policy, so never await it here.
  enable() {
    if (this.disposed) return;
    try {
      const audio = this.audio ||= this.contextFactory();
      audio.onstatechange = () => {
        if (this.disposed || this.audio !== audio) return;
        if (audio.state === 'running') { this.blocked = false; this.problem = ''; this.pump(); }
        else this.paused();
      };
      this.blocked = false;
      Promise.resolve(audio.resume()).then(() => {
        if (!this.disposed && this.audio === audio && audio.state === 'running') { this.blocked = false; this.problem = ''; this.pump(); }
      }, error => { if (!this.disposed && this.audio === audio) this.unavailable(error); });
      if (audio.state === 'running') this.pump();
      else this.paused();
    } catch (error) { this.unavailable(error); }
  }
  unavailable(error) {
    this.blocked = true;
    this.problem = error.message || String(error);
    this.paused();
  }
  paused() {
    if (this.audio?.state === 'closed') {
      this.blocked = true;
      this.report('Speaker audio output closed. Cancel playback, check the default audio output, then Start again.');
      return;
    }
    this.report(`${this.problem ? `Speaker unavailable: ${this.problem}.` : 'Playback paused.'} Check the default audio output, then press Enable speaker.`, true);
  }
  start(context) {
    this.signal = context.signal;
    this.abort = () => { void this.dispose(); };
    if (this.signal.aborted) { void this.dispose(); return; }
    this.signal.addEventListener('abort', this.abort, { once: true });
    if (!this.audio) this.enable();
  }
  receive(port, value, context) {
    if (this.disposed || this.stopping || context.signal.aborted) return;
    if (port !== 'audio') throw new TypeError('Unknown audio input port.');
    const audio = validateSynthesizedAudio(value);
    const seconds = audio.samples.length / audio.sampleRate;
    if (this.rejected || this.queue.length >= SPEAKER_LIMITS.clips || this.seconds + seconds > SPEAKER_LIMITS.seconds
        || this.bytes + audio.samples.byteLength > SPEAKER_LIMITS.bytes) {
      this.rejected++;
      this.report('Speaker playback queue reached its limit.', this.blocked || this.audio?.state !== 'running');
      return;
    }
    this.queue.push({ ...audio, samples: audio.samples.slice() });
    this.seconds += seconds;
    this.bytes += audio.samples.byteLength;
    this.pump();
  }
  pump() {
    if (this.disposed || this.blocked || this.audio?.state !== 'running') return;
    if (this.current) {
      this.report('Playing through the default speaker. Keep this Live window open.');
      return;
    }
    const clip = this.queue[0];
    if (!clip) {
      this.report('Speaker ready. Keep this Live window open.');
      this.waiters.splice(0).forEach(resolve => resolve());
      return;
    }
    let source;
    try {
      const buffer = this.audio.createBuffer(1, clip.samples.length, clip.sampleRate);
      buffer.copyToChannel(clip.samples, 0);
      source = this.audio.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audio.destination);
      this.current = source;
      source.onended = () => {
        if (this.disposed || this.current !== source) return;
        source.onended = null; source.disconnect(); source.buffer = null;
        this.current = null;
        this.queue.shift();
        this.seconds -= clip.samples.length / clip.sampleRate;
        this.bytes -= clip.samples.byteLength;
        this.pump();
      };
      source.start();
      this.report('Playing through the default speaker. Keep this Live window open.');
    } catch (error) {
      if (source) { source.onended = null; source.disconnect(); source.buffer = null; }
      this.current = null;
      this.unavailable(error);
    }
  }
  stop() {
    this.stopping = true;
    if (this.disposed || !this.queue.length) return;
    return new Promise(resolve => this.waiters.push(resolve));
  }
  cancel() { return this.dispose(); }
  dispose() {
    if (this.disposed) return this.closing;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.abort);
    if (this.current) {
      this.current.onended = null;
      this.current.stop(); this.current.disconnect(); this.current.buffer = null;
      this.current = null;
    }
    this.queue.length = 0; this.seconds = 0; this.bytes = 0;
    this.waiters.splice(0).forEach(resolve => resolve());
    if (this.audio) {
      const audio = this.audio; this.audio = null;
      audio.onstatechange = null;
      this.closing = audio.state === 'closed' ? Promise.resolve() : audio.close();
    }
    return this.closing;
  }
}

// A separate typed input keeps completed clips and incremental streams explicit.
// AudioBufferSource performs sample-rate conversion into the context's clock.
export const STREAM_SPEAKER_LIMITS = Object.freeze({ chunks: 64, seconds: 8, bytes: 8 * 1024 * 1024 });
export class StreamingSpeakerOutputNode extends SpeakerOutputNode {
  inputs = { stream: AUDIO_STREAM };
  constructor(options = {}) {
    super(options); this.lastId = 0; this.nextTime = 0; this.underruns = 0;
  }
  report(message, needsActivation = false, fields = {}) {
    if (this.disposed) return;
    const overflow = this.rejected ? ' Stream queue full; further audio rejected. Stop drains accepted audio, then Start again.' : '';
    this.onState({ message: message + overflow, needsActivation, overflow: !!this.rejected, ...fields });
  }
  receive(port, value, context) {
    if (this.disposed || this.stopping || context.signal.aborted || this.rejected) return;
    if (port !== 'stream') throw TypeError('Unknown streaming speaker input port.');
    const event = validateAudioStream(value);
    if (event.type === 'start') {
      if (this.active || event.id <= this.lastId) throw Error('Audio stream start is overlapping or replayed.');
      this.active = { id: event.id, sequence: 0, sampleRate: event.sampleRate };
      this.lastId = event.id; return;
    }
    if (!this.active || event.id !== this.active.id || event.sequence !== this.active.sequence) throw Error('Audio stream boundary or chunk sequence mismatch.');
    if (event.type === 'end') { this.active = null; return; }
    if (event.type === 'abort') {
      const removed = this.queue.filter(chunk => chunk.id === event.id);
      for (const chunk of removed) this.release(chunk, true);
      this.active = null;
      this.nextTime = Math.max(this.audio?.currentTime || 0, ...this.queue.map(chunk => chunk.end || 0));
      this.report(`Speech generation aborted: ${event.message}`);
      this.pump(); return;
    }
    const sampleRate = this.active.sampleRate, seconds = event.samples.length / sampleRate;
    if (seconds > AUDIO_STREAM_LIMITS.chunkSeconds) throw RangeError('An audio stream chunk exceeds two seconds.');
    if (this.queue.length >= STREAM_SPEAKER_LIMITS.chunks || this.seconds + seconds > STREAM_SPEAKER_LIMITS.seconds
        || this.bytes + event.samples.byteLength > STREAM_SPEAKER_LIMITS.bytes) {
      this.rejected = 1; this.active = null;
      this.report('Streaming speaker reached its buffering limit.', this.blocked || this.audio?.state !== 'running'); return;
    }
    this.active.sequence++;
    this.queue.push({ id: event.id, sequence: event.sequence, samples: event.samples.slice(), sampleRate });
    this.seconds += seconds; this.bytes += event.samples.byteLength; this.pump();
  }
  release(chunk, stop = false) {
    const index = this.queue.indexOf(chunk);
    if (index < 0) return;
    if (chunk.source) {
      chunk.source.onended = null;
      if (stop) chunk.source.stop();
      chunk.source.disconnect(); chunk.source.buffer = null; chunk.source = null;
    }
    this.queue.splice(index, 1);
    this.seconds = Math.max(0, this.seconds - chunk.samples.length / chunk.sampleRate);
    this.bytes -= chunk.samples.byteLength;
  }
  pump() {
    if (this.disposed || this.blocked || this.audio?.state !== 'running') return;
    for (const chunk of this.queue) {
      if (chunk.source) continue;
      let source;
      try {
        const buffer = this.audio.createBuffer(1, chunk.samples.length, chunk.sampleRate);
        buffer.copyToChannel(chunk.samples, 0);
        source = this.audio.createBufferSource(); source.buffer = buffer; source.connect(this.audio.destination);
        const now = this.audio.currentTime;
        if (this.nextTime && this.nextTime < now && chunk.sequence > 0) this.underruns++;
        // A short lead applies only after underrun/idle. Successive chunks use
        // the previous scheduled end, never onended or a main-thread timer.
        const start = Math.max(now + (this.nextTime <= now ? 0.04 : 0), this.nextTime);
        chunk.source = source; chunk.end = start + buffer.duration;
        source.onended = () => {
          if (this.disposed || chunk.source !== source) return;
          this.release(chunk); this.pump();
        };
        source.start(start); this.nextTime = chunk.end;
        this.report('Streaming through the default speaker. Keep this Live window open.', false, {
          type: 'scheduled', id: chunk.id, sequence: chunk.sequence,
          at: performance.timeOrigin + performance.now(), audioTime: start, duration: buffer.duration, underruns: this.underruns });
      } catch (error) {
        if (source) { source.onended = null; source.disconnect(); source.buffer = null; }
        chunk.source = null; this.unavailable(error); return;
      }
    }
    if (!this.queue.length) {
      this.report('Streaming speaker ready. Keep this Live window open.');
      this.waiters.splice(0).forEach(resolve => resolve());
    }
  }
  stop() {
    if (this.active) throw Error('Audio stream ended without an end/abort boundary.');
    return super.stop();
  }
  dispose() {
    if (this.disposed) return this.closing;
    for (const chunk of [...this.queue]) this.release(chunk, true);
    this.active = null;
    return super.dispose();
  }
}
