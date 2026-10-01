class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2048); this.used = 0;
    this.port.onmessage = () => { this.flush(); this.port.postMessage('flushed'); };
  }
  flush() {
    if (this.used) {
      const block = this.buffer.slice(0, this.used);
      this.port.postMessage(block, [block.buffer]); this.used = 0;
    }
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      this.buffer[this.used++] = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('capture', Capture);
