// Native worker fixtures keep the production nodes, pipeline, PCM transport and
// incremental speaker real, while CI downloads no weights or inference runtime.
export const asrPages = ['whisper', 'zipformer', 'parakeet-v3', 'moonshine-medium'];
export const textPages = ['text-summary-lfm2', 'text-summary-qwen35', 'if-condition'];
export const streamPages = ['qwen3-tts', 'cosyvoice3'];
export const modelPages = ['speech-to-text', ...asrPages, 'opus-mt', 'opus-mt-en-ja', 'translategemma', ...textPages, 'kokoro', 'supertonic3', ...streamPages];

export function wavFixture(seconds = 0.3) {
  const samples = Math.floor(seconds * 16000), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 10) * 5000), 44 + i * 2);
  return { name: 'speech.wav', mimeType: 'audio/wav', buffer: bytes };
}

export async function modelWorkers(page, slug, mode = 'success') {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
      requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 } }),
    } });
  });
  const worker = slug.startsWith('text-summary') ? 'text-summary' : slug;
  await page.context().route(`**/${worker}-worker.js`, route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
      const mode = ${JSON.stringify(mode)};
      let session, chunks = 0, active;
      self.onmessage = ({ data: d }) => {
        if (d.type === 'load') {
          postMessage({ type: 'progress', message: 'Loading fixture weights 50%' });
          if (mode === 'load-error') return postMessage({ type: 'error', id: d.id, message: 'Fixture memory/storage unavailable' });
          if (mode === 'loading') return;
          return postMessage({ type: 'ready', id: d.id });
        }
        if (mode === 'inference-error') return postMessage({ type: 'error', id: d.id, session: d.session, message: 'Fixture inference failed' });
        if (mode === 'inference') return;
        if (d.type === 'start') session = d.session;
        if (d.type === 'audio') {
          if (!(d.audio instanceof Float32Array) || !d.audio.length) throw Error('Missing real decoded PCM');
          if (${JSON.stringify(['zipformer', 'moonshine-medium'].includes(slug))}) postMessage({ type: 'partial', text: 'Streaming preview', session, id: 1 });
          postMessage({ type: 'consumed', sequence: d.sequence, session });
        }
        if (d.type === 'stop') {
          postMessage({ type: 'final', text: 'Recognized speech', session, id: 1 });
          postMessage({ type: 'stopped', session });
        }
        if (d.type === 'decode') {
          postMessage({ type: 'final', text: 'Recognized speech', session: d.session, id: d.id });
          postMessage({ type: 'decoded', session: d.session });
        }
        if (d.type === 'summarize') postMessage({ type: 'result', id: d.id, summary: 'A local summary.' });
        if (d.type === 'decide') postMessage({ type: 'result', id: d.id, branch: d.text.includes('?') ? 'yes' : 'no', confidence: 0.9 });
        if (d.type === 'drain') postMessage({ type: 'drained', id: d.id });
        if (d.type === 'generate') {
          active = d.id; chunks = 0;
          postMessage({ type: 'start', id: active, channels: 1, sampleRate: 24000 });
          postMessage({ type: 'chunk', id: active, sequence: chunks++, samples: new Float32Array(2400).fill(0.01) });
        }
        if (d.type === 'ack') {
          if (d.id !== active || d.sequence !== chunks - 1) throw Error('Invalid chunk acknowledgment');
          if (mode === 'streaming') return;
          if (chunks < 3) setTimeout(() => postMessage({ type: 'chunk', id: active, sequence: chunks++, samples: new Float32Array(2400).fill(0.02) }), 150);
          else postMessage({ type: 'end', id: active, sequence: chunks });
        }
      };`,
  }));
  if (slug === 'whisper') await page.context().route('**/silero-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `self.onmessage = ({ data: d }) => {
      if (d.type === 'load') postMessage({ type: 'ready' });
      if (d.type === 'vad-audio') postMessage({ type: 'vad', session: d.session, frames: [{ audio: d.audio, speaking: true }] });
      if (d.type === 'vad-stop') postMessage({ type: 'vad-stopped', session: d.session });
    };`,
  }));
}

export async function observeModels(page) {
  await page.addInitScript(() => {
    window.modelWorkers = []; window.playedChunks = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.record = { url: String(url), terminated: 0, messages: [] }; window.modelWorkers.push(this.record);
      }
      postMessage(message, ...args) { this.record.messages.push({ type: message.type, language: message.language, voice: message.voice, processor: message.processor, prompt: message.prompt }); super.postMessage(message, ...args); }
      terminate() { this.record.terminated++; super.terminate(); }
    };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source);
        source.start = (...args) => { window.playedChunks.push(source.buffer.length); return start(...args); };
        return source;
      }
    };
  });
}
