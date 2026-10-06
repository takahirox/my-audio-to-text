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
}

export function joinAudio(chunks) {
  const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export class Microphone {
  constructor(onAudio, onEnded) { this.onAudio = onAudio; this.onEnded = onEnded; }
  async start() {
    // Resume synchronously from the Start gesture, before permission awaits (Safari).
    this.context = new AudioContext();
    const resumed = this.context.resume();
    try {
      this.media = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (this.canceled) {
        this.media.getTracks().forEach((track) => track.stop());
        throw new DOMException('Capture canceled', 'AbortError');
      }
      await resumed;
      for (const track of this.media.getTracks()) track.onended = this.onEnded;
      this.source = this.context.createMediaStreamSource(this.media);
      this.resampler = new Resampler(this.context.sampleRate);
      const onChunk = (chunk) => {
        const audio = this.resampler.push(chunk);
        if (audio.length) this.onAudio(audio);
      };
      if (this.context.audioWorklet) {
        await this.context.audioWorklet.addModule('./capture-worklet.js');
        this.node = new AudioWorkletNode(this.context, 'capture');
        this.node.port.onmessage = ({ data }) => onChunk(data);
      } else {
        this.node = this.context.createScriptProcessor(2048, 1, 1);
        this.node.onaudioprocess = ({ inputBuffer }) => onChunk(inputBuffer.getChannelData(0));
      }
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.canceled = true;
    // Flush the worklet's last short block before disconnecting.
    if (this.node?.port) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        const previous = this.node.port.onmessage;
        this.node.port.onmessage = (event) => {
          if (event.data === 'flushed') { clearTimeout(timer); resolve(); }
          else previous(event);
        };
        this.node.port.postMessage('flush');
      });
      this.node.port.onmessage = null;
    }
    if (this.node) this.node.onaudioprocess = null;
    this.source?.disconnect(); this.node?.disconnect(); this.gain?.disconnect();
    this.media?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    if (this.context?.state !== 'closed') await this.context?.close();
  }
}
