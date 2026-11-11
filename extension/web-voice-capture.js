// Loaded only in Chrome's ISOLATED content-script world. No DOM/message bridge.
(() => {
  if (globalThis.WebVoiceCapture) return;
  const size = 1280, windowSize = 8; // 80 ms of mono Float32 PCM at 16 kHz.
  // Native Web Audio resamples the device into this context's requested rate.
  // Worklet -> content is transferable; Chrome runtime Ports are JSON/base64.
  const worklet = `class VoiceCapture extends AudioWorkletProcessor {
    constructor() {
      super(); this.block = new Float32Array(1280); this.used = 0; this.pending = 0;
      this.port.onmessage = ({data}) => {
        if (data === 'ack') this.pending--;
        if (data === 'flush') { this.closed = true; this.flush(); this.port.postMessage('flushed'); }
      };
    }
    flush() {
      if (!this.used || this.failed) return;
      if (this.pending >= 8) { this.failed = true; this.port.postMessage('overflow'); return; }
      const block = this.block.slice(0, this.used); this.used = 0; this.pending++;
      this.port.postMessage({ audio: block, time: currentTime }, [block.buffer]);
    }
    process(inputs) {
      if (this.closed || this.failed) return true;
      const channels = inputs[0]; if (!channels.length) return true;
      for (let i = 0; i < channels[0].length; i++) {
        this.block[this.used++] = channels.reduce((sum, c) => sum + c[i], 0) / channels.length;
        if (this.used === this.block.length) this.flush();
        if (this.failed) break;
      }
      return true;
    }
  }; registerProcessor('web-voice-capture', VoiceCapture);`;
  const errorMessage = error => {
    const recovery = {
      NotAllowedError: 'Allow microphone access for this website in Chrome site settings and check OS microphone access.',
      SecurityError: 'This website blocks microphone capture. Check its Permissions Policy and Chrome site settings.',
      NotFoundError: 'Connect or enable a microphone and check Chrome’s default input device.',
      NotReadableError: 'The microphone is unavailable. Check the device, other applications and OS input settings.',
      OverconstrainedError: 'Choose an available microphone in Chrome input settings.',
    }[error.name] || 'Check this website’s microphone permission, device and browser audio support.';
    return `Microphone capture unavailable: ${recovery} Click the field mic to retry. (${error.message || error})`;
  };
  class WebVoiceCapture {
    constructor(send, fail) {
      this.send = send; this.fail = fail; this.sequence = 0; this.pending = new Map();
    }
    acquire() {
      // Called synchronously in the trusted mic click, before any messaging or await.
      try {
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('Use HTTPS or localhost; this page is not a supported secure microphone context.');
        const policy = document.permissionsPolicy || document.featurePolicy;
        if (policy && !policy.allowsFeature('microphone')) throw new DOMException('The site’s Permissions Policy forbids microphone capture.', 'SecurityError');
        this.context = new AudioContext({ sampleRate: 16000 });
        const resumed = this.context.resume(); void resumed.catch(() => {});
        const media = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        this.ready = media.then(async stream => {
          if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
          this.stream = stream;
          const tracks = stream.getAudioTracks();
          if (!tracks.length || tracks.some(track => track.readyState !== 'live')) throw Error('No live microphone track.');
          for (const track of tracks) track.onended = () => this.fail('Microphone ended or permission was removed. Check this website’s permission and click the mic to retry.');
          // Track ended is the primary signal; PermissionStatus also catches revocation.
          try {
            const permission = await navigator.permissions.query({ name: 'microphone' });
            if (!this.closed) {
              this.permission = permission;
              this.changed = () => { if (permission.state === 'denied') this.fail('Microphone permission removed for this website. Allow it in Chrome site settings and click the mic to retry.'); };
              permission.addEventListener('change', this.changed); this.changed();
            }
          } catch { /* Track lifecycle remains authoritative on older Chrome. */ }
          await resumed;
        }).catch(error => { if (!this.closed) this.fail(errorMessage(error)); });
      } catch (error) { this.ready = Promise.resolve(); this.fail(errorMessage(error)); }
      return this.ready;
    }
    async start() {
      await this.ready;
      if (this.closed || this.started) return;
      this.started = true;
      if (this.context.sampleRate !== 16000) throw Error('This browser cannot create a 16 kHz microphone AudioContext.');
      this.clockBase = performance.timeOrigin + performance.now() - this.context.currentTime * 1000;
      this.source = this.context.createMediaStreamSource(this.stream);
      if (this.context.audioWorklet) {
        const url = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
        try {
          await this.context.audioWorklet.addModule(url);
          if (this.closed) return;
          this.node = new AudioWorkletNode(this.context, 'web-voice-capture');
          this.node.port.onmessage = ({ data }) => {
            if (data === 'flushed') this.flushed?.();
            else if (data === 'overflow') this.fail('Microphone audio relay is too slow. Close busy tasks and click the mic to retry.');
            else this.chunk(data.audio, this.clockBase + data.time * 1000);
          };
        } catch { /* Some contexts prohibit worklet modules. Use bounded native fallback. */ }
        finally { URL.revokeObjectURL(url); }
      }
      if (this.closed) return;
      if (!this.node) {
        // No page-world script, eval or CSP workaround; supported native fallback.
        this.node = this.context.createScriptProcessor(1024, 1, 1);
        this.partial = new Float32Array(size); this.used = 0;
        this.node.onaudioprocess = ({ inputBuffer }) => {
          if (this.closed || this.stopping) return;
          const data = inputBuffer.getChannelData(0);
          for (const sample of data) {
            this.partial[this.used++] = sample;
            if (this.used === size) { this.chunk(this.partial.slice()); this.used = 0; }
          }
        };
      }
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
      this.watchdog = setInterval(() => {
        if ([...this.pending.values()].some(time => Date.now() - time > 3000)) this.fail('Microphone audio runtime stopped responding. Click the mic to retry.');
      }, 1000);
    }
    chunk(audio, capturedAt = performance.timeOrigin + performance.now()) {
      if (this.closed || !audio.length) return;
      if (this.pending.size >= windowSize) { this.fail('Microphone audio relay is too slow. Close busy tasks and click the mic to retry.'); return; }
      const sequence = this.sequence++;
      this.pending.set(sequence, Date.now());
      const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      this.send({ type: 'pcm', sequence, pcm: btoa(binary), capturedAt });
    }
    ack(sequence) {
      if (!this.pending.delete(sequence)) return;
      this.node?.port?.postMessage('ack');
      if (!this.pending.size) this.drained?.();
    }
    stop(flush = false) {
      if (!flush) {
        this.closed = true; this.flushed?.(); this.drained?.();
        this.release();
      }
      return this.stopped ??= this.finish(flush);
    }
    release() {
      clearInterval(this.watchdog);
      this.permission?.removeEventListener('change', this.changed);
      this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      this.source?.disconnect(); this.node?.disconnect(); this.gain?.disconnect();
      if (this.node?.port) this.node.port.onmessage = null;
      if (this.node) this.node.onaudioprocess = null;
    }
    async finish(flush) {
      this.stopping = true;
      // Release physical capture immediately, retaining only the final worklet buffer.
      this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      try {
        if (flush && !this.closed) {
          if (this.node?.port) await this.waitFor('flushed', () => this.node.port.postMessage('flush'));
          else if (this.used) this.chunk(this.partial.slice(0, this.used));
          if (this.pending.size && !this.closed) await this.waitFor('drained');
        }
      } finally {
        this.closed = true; this.release();
        if (this.context && this.context.state !== 'closed') await this.context.close();
      }
    }
    waitFor(name, begin = () => {}) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { this[name] = null; reject(Error('Microphone audio drain timed out. Click the mic to retry.')); }, 3000);
        this[name] = () => { clearTimeout(timeout); this[name] = null; resolve(); }; begin();
      });
    }
  }
  globalThis.WebVoiceCapture = WebVoiceCapture;
})();
