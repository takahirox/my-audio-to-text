/* global OfflineRecognizer, createVad */
let recognizer, segmenter, session, vad;
let vadTail = new Float32Array();
const send = (type, values = {}) => postMessage({ type, session, ...values });
const fail = (error) => send('error', { message: error.message || String(error) });
let sequence = Promise.resolve();
self.onmessage = ({ data }) => { sequence = sequence.then(() => handle(data)).catch(fail); };

async function load(backend, requestedThreads) {
  const { selectReazonThreads } = await import('./reazon-config.js');
  const base = new URL('./vendor/sherpa/', self.location.href);
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
    importScripts(new URL('sherpa-onnx-asr.js', base).href, script);
    if (backend === 'sherpa-simulated') importScripts(new URL('sherpa-onnx-vad.js', base).href);
  });
  const numThreads = selectReazonThreads({
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedMemory: typeof SharedArrayBuffer !== 'undefined' && self.Module.HEAPU8?.buffer instanceof SharedArrayBuffer,
  }, requestedThreads);
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: './transducer-encoder.onnx', decoder: './transducer-decoder.onnx', joiner: './transducer-joiner.onnx' },
      tokens: './tokens.txt', modelType: 'transducer', numThreads, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
  }, self.Module);
  if (!recognizer.handle) throw new Error('ReazonSpeech recognizer initialization failed');
  send('configuration', { numThreads });
}
function recognize(audio, type = 'final', emitEmpty = false, id) {
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(16000, audio); recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    if (emitEmpty || result.text.trim()) send(type, { text: result.text.trim(), id });
  } finally { stream.free(); }
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
    await load(data.backend, data.numThreads);
    if (data.backend === 'sherpa-simulated') {
      vad = createVad(self.Module, {
        sileroVad: { model: './silero_vad.onnx', threshold: 0.5, windowSize: 512,
          minSpeechDuration: 1 / 16000, minSilenceDuration: 1 / 16000, maxSpeechDuration: 12 },
        sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 2,
      });
      if (!vad.handle) throw new Error('Silero VAD initialization failed');
    }
    send('ready');
  } else if (data.type === 'vad-start') {
    session = data.session; vad.reset(); vadTail = new Float32Array();
  } else if (data.type === 'vad-audio') {
    classify(data.audio);
  } else if (data.type === 'vad-stop') {
    classify(new Float32Array(), true); send('vad-stopped');
  } else if (data.type === 'start') {
    session = data.session;
    const { Segmenter } = await import('./audio.js');
    segmenter = new Segmenter(); send('started');
  } else if (data.type === 'audio') {
    const audio = segmenter.push(data.audio); if (audio) recognize(audio);
    send('ack', { samples: data.audio.length });
  } else if (data.type === 'stop') {
    const audio = segmenter.flush(); if (audio) recognize(audio);
    send('stopped');
  } else if (data.type === 'decode') {
    // Simulated streaming sends one bounded snapshot at a time. The main page
    // owns buffering/coalescing; this remains the existing offline recognizer.
    session = data.session;
    recognize(data.audio, data.final ? 'final' : 'partial', true, data.id);
    send('decoded');
  } else if (data.type === 'utterance') {
    // Two-pass mode sends the complete recording only after Stop, bypassing
    // live segmentation while reusing the same recognizer and stream cleanup.
    session = data.session;
    if (data.audio.length) recognize(data.audio);
    send('stopped');
  }
}
