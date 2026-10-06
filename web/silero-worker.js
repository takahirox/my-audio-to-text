/* global createVad */
let session, vad;
let vadTail = new Float32Array();
let running = false;
const send = (type, values = {}) => postMessage({ type, session, ...values });
const fail = (error) => send('error', { message: error.message || String(error) });
let sequence = Promise.resolve();
self.onmessage = ({ data }) => { sequence = sequence.then(() => handle(data)).catch(fail); };

// Reuse the pinned Silero runtime in its own worker. No ASR recognizer is created.
async function load() {
  const base = new URL('./vendor/sherpa-ja-en/', self.location.href);
  const script = new URL('sherpa-onnx-wasm-main-vad-asr.js', base).href;
  await new Promise((resolve, reject) => {
    self.Module = {
      noInitialRun: true,
      locateFile: (file) => new URL(file, base).href,
      mainScriptUrlOrBlob: script,
      setStatus: (message) => send('progress', { message }),
      printErr: (message) => send('progress', { message }),
      onAbort: (message) => reject(new Error(String(message))),
      onRuntimeInitialized: resolve,
    };
    importScripts(new URL('sherpa-onnx-vad.js', base).href, script);
  });
  vad = createVad(self.Module, {
    sileroVad: { model: './silero_vad.onnx', threshold: 0.5, windowSize: 512,
      minSpeechDuration: 1 / 16000, minSilenceDuration: 1 / 16000, maxSpeechDuration: 12 },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 2,
  });
  if (!vad.handle) throw new Error('Silero VAD initialization failed');
}
function classify(audio, flush = false) {
  const input = new Float32Array(vadTail.length + audio.length);
  input.set(vadTail); input.set(audio, vadTail.length);
  const frames = []; let offset = 0;
  while (offset + 512 <= input.length || (flush && offset < input.length)) {
    const frame = input.slice(offset, offset + 512);
    const padded = new Float32Array(512); padded.set(frame);
    vad.acceptWaveform(padded);
    frames.push({ audio: frame, speaking: vad.isDetected() });
    // Avoid retaining duplicate native utterance buffers during long speech.
    // flush/clear do not reset the Silero model's recurrent or threshold state.
    vad.flush(); vad.clear(); offset += frame.length;
  }
  vadTail = input.slice(offset);
  if (frames.length) postMessage({ type: 'vad', session, frames }, frames.map(frame => frame.audio.buffer));
}
async function handle(data) {
  if (data.type === 'load') {
    await load(); send('ready');
  } else if (data.type === 'vad-start') {
    session = data.session; vad.reset(); vadTail = new Float32Array(); running = true;
  } else if (running && data.session === session) {
    if (data.type === 'vad-audio') classify(data.audio);
    else if (data.type === 'vad-stop') {
      // Publish the final short frame before acknowledging Stop. The page drains ASR.
      classify(new Float32Array(), true);
      running = false; vad.reset(); send('vad-stopped');
    }
  }
}
