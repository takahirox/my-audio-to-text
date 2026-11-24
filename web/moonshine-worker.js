import { moonshineManifest, moonshineJapaneseManifest, optionalAsrFiles } from './optional-model-assets.js';
import { Transcriber } from './vendor/optional-asr/moonshine/transcriber.js';
import { ModelArch } from './vendor/optional-asr/moonshine/enums.js';
import { MoonshineStream } from './moonshine-stream.js';

export function installMoonshineWorker({ japanese = false, loadFiles = (label, report) => (
  (japanese ? moonshineJapaneseManifest() : moonshineManifest()).then(manifest => optionalAsrFiles(manifest, label, report))
) } = {}) {
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
      send('progress', { message: `Checking verified Moonshine ${japanese ? 'Small Japanese' : 'Medium English'} Streaming cache…` });
      const files = await loadFiles(japanese ? 'Moonshine Small Streaming Japanese' : 'Moonshine Medium Streaming English', message => send('progress', { message }));
      transcriber = await Transcriber.load({ files, modelArch: japanese ? ModelArch.SmallStreaming : ModelArch.MediumStreaming, options: { identify_speakers: 'false', return_audio_data: 'false', ...(japanese ? { max_tokens_per_second: '13' } : {}) } });
      files.clear();
      send('configuration', { model: japanese ? 'small-streaming-ja/quantized_26_08_23' : 'medium-streaming-en/quantized_26_07_30', language: japanese ? 'ja' : 'en', modelArch: japanese ? ModelArch.SmallStreaming : ModelArch.MediumStreaming, backend: 'CPU WASM', updateIntervalSeconds: 0.5 });
      send('ready');
    } else if (data.type === 'start') {
      session = data.session;
      stream = new MoonshineStream(transcriber, event => send(event.type, event));
    } else if (data.session === session && data.type === 'audio') {
      stream.push(data.audio); send('consumed', { sequence: data.sequence });
    } else if (data.session === session && data.type === 'stop') {
      stream.finish(); stream = null; send('stopped');
    }
  }
}
