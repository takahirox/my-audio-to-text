/* global OnlineRecognizer */
let recognizer, segments, session;
const send = (type, values = {}) => postMessage({ type, session, ...values });
let sequence = Promise.resolve(), failed = false;
self.onmessage = ({ data }) => {
  sequence = sequence.then(() => { if (!failed) return handle(data); }).catch(error => {
    failed = true; segments?.dispose(); recognizer?.free();
    send('error', { message: error.message || String(error) });
  });
};
async function load() {
  const base = new URL('./vendor/zipformer-en/', self.location.href);
  const script = new URL('sherpa-onnx-wasm-main-asr.js', base).href;
  await new Promise((resolve, reject) => {
    self.Module = { noInitialRun: true, locateFile: file => new URL(file, base).href,
      mainScriptUrlOrBlob: script,
      setStatus: message => send('progress', { message }),
      printErr: message => send('progress', { message }),
      onAbort: message => reject(new Error(String(message))), onRuntimeInitialized: resolve };
    importScripts(new URL('sherpa-onnx-asr.js', base).href, script);
  });
  recognizer = new OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: './encoder.onnx', decoder: './decoder.onnx', joiner: './joiner.onnx' },
      tokens: './tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: 'zipformer' },
    decodingMethod: 'greedy_search', enableEndpoint: 0,
  }, self.Module);
  if (!recognizer.handle) throw Error('English Zipformer online recognizer initialization failed');
  send('configuration', { model: 'zipformer-en-20M-2023-02-17', numThreads: 1, wasmHeapBytes: self.Module.HEAPU8.buffer.byteLength });
}
async function handle(data) {
  if (data.type === 'load') { await load(); send('ready'); }
  else if (data.type === 'start') {
    session = data.session; segments?.dispose();
    const { ZipformerSegments } = await import('./zipformer-segments.js');
    segments = new ZipformerSegments(recognizer, event => send(event.type, event));
  } else if (data.session === session && data.type === 'audio') {
    segments.push(data.audio); send('consumed', { sequence: data.sequence });
  } else if (data.session === session && data.type === 'stop') {
    segments.finish(); segments.dispose(); segments = null; send('stopped', { wasmHeapBytes: self.Module.HEAPU8.buffer.byteLength });
  }
}
