// Preserve fractional positions across blocks (notably for 44.1 kHz devices).
export class Resampler {
  constructor(rate) { this.ratio = rate / 16000; this.position = 0; this.tail = new Float32Array(); }
  push(samples) {
    const input = new Float32Array(this.tail.length + samples.length);
    input.set(this.tail); input.set(samples, this.tail.length);
    const output = [];
    while (this.position + 1 < input.length) {
      const i = Math.floor(this.position), fraction = this.position - i;
      output.push(input[i] + fraction * (input[i + 1] - input[i]));
      this.position += this.ratio;
    }
    const used = Math.min(Math.floor(this.position), input.length);
    this.tail = input.slice(used); this.position -= used;
    return Float32Array.from(output);
  }
  flush() {
    // At end of input, extend the final sample for interpolation only.
    const output = [];
    while (this.position < this.tail.length) {
      const i = Math.floor(this.position), fraction = this.position - i;
      output.push(this.tail[i] + fraction * ((this.tail[i + 1] ?? this.tail[i]) - this.tail[i]));
      this.position += this.ratio;
    }
    this.tail = new Float32Array(); this.position = 0;
    return Float32Array.from(output);
  }
}

export function joinAudio(chunks) {
  const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export class BrowserAudioSource {
  constructor(onAudio, onEnded) { this.onAudio = onAudio; this.onEnded = onEnded; }
  checkCanceled() {
    if (this.canceled) throw new DOMException('Capture canceled', 'AbortError');
  }
  async start() {
    try {
      // Both permission APIs and resume run directly in the Start gesture.
      this.context = new AudioContext();
      const resumed = this.context.resume();
      // Permission can take longer than resume; handle rejection immediately.
      void resumed.catch(() => {});
      this.media = await this.getMedia();
      this.checkCanceled();
      const tracks = this.media.getAudioTracks();
      if (!tracks.length) throw new Error(this.noAudioMessage || 'No audio was shared. Choose a browser tab and enable "Share tab audio" in the sharing picker, then try again.');
      const ended = () => { if (!this.canceled) this.onEnded?.(); };
      for (const track of this.media.getTracks()) track.onended = ended;
      if (this.media.getTracks().some(track => track.readyState === 'ended')) {
        throw new Error('Audio sharing ended before capture started. Start again and select a tab with audio.');
      }
      await resumed; this.checkCanceled();
      // Display capture requires video, but only its audio enters Web Audio.
      this.source = this.context.createMediaStreamSource(new MediaStream(tracks));
      this.resampler = new Resampler(this.context.sampleRate);
      const onChunk = (chunk) => {
        const audio = this.resampler.push(chunk);
        if (audio.length) this.onAudio(audio);
      };
      if (this.context.audioWorklet) {
        await this.context.audioWorklet.addModule(this.workletURL || './capture-worklet.js');
        this.checkCanceled();
        this.node = new AudioWorkletNode(this.context, 'capture');
        this.node.port.onmessage = ({ data }) => onChunk(data);
      } else {
        this.node = this.context.createScriptProcessor(2048, tracks[0].getSettings().channelCount || 2, 1);
        this.node.onaudioprocess = ({ inputBuffer }) => {
          const mono = new Float32Array(inputBuffer.length);
          for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
            const samples = inputBuffer.getChannelData(channel);
            for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / inputBuffer.numberOfChannels;
          }
          onChunk(mono);
        };
      }
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
    } catch (error) {
      // A picker can resolve after Cancel has already closed the context.
      this.releaseTracks();
      await this.stop(false); throw error;
    }
  }
  stop(flush = true) {
    this.canceled = true;
    this.releaseTracks();
    if (!flush) {
      this.discard = true;
      this.finishFlush?.();
      this.disconnect();
    }
    return this.stopping ??= this.finishStop(flush);
  }
  releaseTracks() {
    if (!this.media || this.releasedMedia === this.media) return;
    this.releasedMedia = this.media;
    this.media.getTracks().forEach(track => { track.onended = null; track.stop(); });
  }
  disconnect() {
    if (this.node?.port) this.node.port.onmessage = null;
    if (this.node) this.node.onaudioprocess = null;
    this.source?.disconnect(); this.node?.disconnect(); this.gain?.disconnect();
  }
  async finishStop(flush) {
    try {
      // Flush the worklet's last short block before disconnecting.
      if (flush && this.node?.port) {
        await new Promise((resolve) => {
          this.finishFlush = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(this.finishFlush, 500);
          const previous = this.node.port.onmessage;
          this.node.port.onmessage = (event) => {
            if (event.data === 'flushed') this.finishFlush();
            else previous?.(event);
          };
          this.node.port.postMessage('flush');
        });
      }
      this.finishFlush = null;
      if (flush && !this.discard && this.resampler) {
        const tail = this.resampler.flush();
        if (tail.length) this.onAudio(tail);
      }
    } finally {
      this.finishFlush?.(); this.finishFlush = null;
      this.disconnect();
      if (this.context?.state !== 'closed') await this.context?.close();
    }
  }
}

export class Microphone extends BrowserAudioSource {
  getMedia() {
    return navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    } });
  }
}

export class BrowserTab extends BrowserAudioSource {
  getMedia() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Browser-tab audio capture is unavailable. Use a desktop Chromium browser over HTTPS or localhost, or choose Microphone.');
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: true,
      systemAudio: 'exclude', windowAudio: 'exclude',
    }).catch(error => {
      if (['NotAllowedError', 'AbortError'].includes(error.name)) {
        throw new Error('Tab sharing was denied or canceled. Start again, choose a browser tab, and enable "Share tab audio".');
      }
      throw error;
    });
  }
}
