import { Transcriber } from './vendor/optional-asr/moonshine/transcriber.js';
import { ModelArch } from './vendor/optional-asr/moonshine/enums.js';
import { moonshineManifest, optionalAsrFiles } from '../extension/optional-asr-cache.js';
import { MoonshineMediumStream } from './moonshine-medium-stream.js';

let transcriber, stream, session, failed = false, chain = Promise.resolve();
const send = (type, values = {}) => postMessage({ type, ...(session === undefined ? {} : { session }), ...values });
self.onmessage = ({ data }) => {
  chain = chain.then(() => { if (!failed) return handle(data); }).catch(error => {
    failed = true;
    // Cleanup failures must not hide the inference error or skip peer cleanup.
    try { stream?.dispose(); } catch {}
    try { transcriber?.close(); } catch {}
    send('error', { message: error.message || String(error) });
  });
};
async function handle(data) {
  if (data.type === 'load') {
    send('progress', { message: 'Checking verified Moonshine Medium English Streaming cache…' });
    const files = await optionalAsrFiles(await moonshineManifest(), 'Moonshine Medium English Streaming');
    transcriber = await Transcriber.load({ files, modelArch: ModelArch.MediumStreaming, options: { identify_speakers: 'false', return_audio_data: 'false' } });
    files.clear();
    send('configuration', { model: 'medium-streaming-en/quantized_26_07_30', modelArch: ModelArch.MediumStreaming, backend: 'CPU WASM', updateIntervalSeconds: 0.5 });
    send('ready');
  } else if (data.type === 'start') {
    session = data.session;
    stream = new MoonshineMediumStream(transcriber, event => send(event.type, event));
  } else if (data.session === session && data.type === 'audio') {
    stream.push(data.audio); send('consumed', { sequence: data.sequence });
  } else if (data.session === session && data.type === 'stop') {
    stream.finish(); stream = null; send('stopped');
  }
}
