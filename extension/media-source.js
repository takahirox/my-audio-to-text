import { Resampler, Microphone } from '../web/audio.js';
import { PageConnection } from './page-target.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';

export class SelectedMediaSource {
  constructor(target, onAudio, onEnded) { this.target = target && { ...target }; this.onAudio = onAudio; this.onEnded = onEnded; }
  async start() {
    if (!this.target?.mediaId) throw Error('Discover and select page media in Live first, or choose Chrome tab audio.');
    if (this.canceled) throw new DOMException('Capture canceled', 'AbortError');
    this.connection = new PageConnection(this.target, event => {
      if (this.canceled) return;
      if (event.event === 'ended') { this.onEnded?.(event.error); return; }
      if (event.event !== 'audio' || !Array.isArray(event.samples) || event.samples.length > 2048 || !event.samples.every(Number.isFinite) || !Number.isFinite(event.rate) || event.rate < 8000 || event.rate > 192000) return;
      this.resampler ??= new Resampler(event.rate);
      const audio = this.resampler.push(Float32Array.from(event.samples)); if (audio.length) this.onAudio(audio);
    });
    try { await this.connection.request('capture', { target: this.target.mediaId }); }
    catch (error) { await this.stop(false); throw error; }
  }
  async stop(flush = true) {
    if (this.canceled) return;
    this.canceled = true;
    try { if (!flush) this.connection?.close();
      else if (!this.connection?.closed) await this.connection?.request('stop'); }
    finally {
      this.connection?.close();
      if (flush && this.resampler) { const tail = this.resampler.flush(); if (tail.length) this.onAudio(tail); }
    }
  }
}
export class SelectedPageMediaAudioNode extends ExtensionTabAudioNode {
  constructor(target, options = {}) {
    super(target?.tabId, { ...options, sourceFactory: (_tab, audio, ended) => new SelectedMediaSource(target, audio, reason => { options.onState?.(reason); ended(); }) });
  }
}
export class ExtensionMicrophoneAudioNode extends ExtensionTabAudioNode {
  constructor(stream, options = {}) {
    super(null, { ...options, sourceFactory: (_tab, audio, ended) => {
      const source = new Microphone(audio, ended);
      source.getMedia = async () => {
        if (!stream) throw Error('Press Start in Live to permit microphone capture.');
        return stream;
      };
      return source;
    } });
    this.stream = stream;
  }
  dispose() { this.stream?.getTracks().forEach(track => track.stop()); return super.dispose(); }
}
