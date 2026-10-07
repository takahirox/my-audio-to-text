import { Pipeline } from './pipeline.js';
import { MicrophoneAudioNode, BrowserTabAudioNode, SpeechToTextNode, TranscriptOutputNode } from './transcription-nodes.js';
const $ = (id) => document.getElementById(id);
let flow, state = 'booting', startedAt, stopAt, captured = 0, queued = 0, loadAt, generation = 0;
let firstText = false, firstPartial = false, peakRms = 0, speechStarted = 0, speechCompleted = 0, partialCount = 0, finalCount = 0;
function diagnostics() {
  $('speech').textContent = `${speechStarted} Silero VAD utterance(s) accepted; ${speechCompleted} completed. ${speechStarted ? 'Speech detected.' : 'Waiting for speech.'}`;
  $('asr-events').textContent = `${partialCount} nonempty partial(s); ${finalCount} nonempty final(s).`;
}
const time = (ms) => `${(ms / 1000).toFixed(2)} s`;
function setState(next, message) {
  state = next; $('status').textContent = message;
  $('load').disabled = !['idle', 'error'].includes(state);
  $('start').disabled = state !== 'ready';
  $('stop').disabled = state !== 'recording';
  $('cancel').disabled = !flow;
  $('source').disabled = ['booting', 'loading', 'unavailable'].includes(state);
}
function resetOutput() {
  for (const id of ['init', 'first-partial', 'first-text', 'latency', 'audio']) $(id).textContent = '—';
  $('partial').textContent = 'Waiting for speech…';
  $('final').textContent = ''; $('progress').textContent = ''; $('errors').textContent = '';
  captured = queued = peakRms = speechStarted = speechCompleted = partialCount = finalCount = 0;
  firstText = firstPartial = false; $('signal').textContent = 'No capture yet.'; diagnostics();
}
function createFlow(speech = new SpeechToTextNode()) {
  const session = ++generation;
  const isCurrent = () => generation === session;
  speech.onEvent = event => { if (isCurrent()) receive(event); };
  const SourceNode = $('source').value === 'tab' ? BrowserTabAudioNode : MicrophoneAudioNode;
  const source = new SourceNode({
    onAudio: chunk => { if (isCurrent()) audio(chunk); },
    onEnded: () => { if (isCurrent()) void stop(); },
  });
  const transcript = new TranscriptOutputNode((port, value) => {
    if (isCurrent()) receiveTranscript(port, value);
  });
  const pipeline = new Pipeline({ nodes: { source, speech, transcript }, connections: [
    { from: ['source', 'audio'], to: ['speech', 'audio'] },
    { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
    { from: ['speech', 'final'], to: ['transcript', 'final'] },
  ], onError: error => { if (isCurrent()) void fail(error); } });
  return { pipeline, speech, isCurrent };
}
async function release() {
  const session = ++generation;
  const previous = flow; flow = null;
  $('reazon-model').textContent = '—'; $('level').value = 0;
  try { await previous?.pipeline.dispose(); }
  catch (error) {
    if (generation === session) $('errors').textContent += `${new Date().toISOString()} Pipeline cleanup: ${error.message || error}\n`;
  }
  return session;
}
async function fail(error) {
  setState('booting', 'Releasing after error…');
  $('errors').textContent += `${new Date().toISOString()} ${error.message || error}\n`;
  const session = await release();
  if (generation === session) setState('error', 'Error. See runtime errors below; load again to retry.');
}
function audio(audio) {
  if (!flow || !['starting', 'recording', 'stopping'].includes(state)) return;
  if (!captured) startedAt = performance.now();
  captured += audio.length;
  const rms = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
  peakRms = Math.max(peakRms, rms); $('level').value = rms;
  const db = (value) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS';
  $('signal').textContent = `RMS ${db(rms)}; session peak RMS ${db(peakRms)}. ${peakRms > 0 ? `Nonzero ${$('source').value === 'tab' ? 'tab audio' : 'microphone'} signal reached the app (may be noise).` : 'Audio frames received, but signal is zero.'}`;
  audioDiagnostics();
}
function audioDiagnostics() {
  $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
}
function receive(data) {
  // Before Start there is no active node context to report preload errors.
  if (data.type === 'error') { if (flow?.pipeline.state === 'idle') void fail(new Error(data.message)); return; }
  if (data.type === 'configuration') $('reazon-model').textContent = `${data.modelName} (${data.model}); ${data.numThreads} thread(s)`;
  else if (data.type === 'progress') $('progress').textContent = data.message;
  else if (data.type === 'diagnostics') {
    queued = data.pendingSamples; audioDiagnostics();
  } else if (data.type === 'speech') {
    if (data.event === 'started') speechStarted++;
    else if (data.event === 'completed') speechCompleted++;
    diagnostics();
  }
}
function receiveTranscript(port, data) {
  const type = port === 'provisional' ? 'partial' : 'final';
  if (type === 'partial' && state === 'stopping') return;
  if (data.text.trim()) {
    if (type === 'partial') partialCount++; else finalCount++;
    diagnostics();
  }
  if (data.text.trim() && !firstText) { firstText = true; $('first-text').textContent = time(performance.now() - startedAt); }
  if (type === 'partial') {
    if (data.text.trim() && !firstPartial) { firstPartial = true; $('first-partial').textContent = time(performance.now() - startedAt); }
    $('partial').textContent = data.text;
  } else {
    if (data.text.trim()) $('final').textContent += `${data.text}\n`;
    $('partial').textContent = '';
  }
}
$('load').onclick = async () => {
  setState('loading', 'Loading model…');
  const session = await release();
  if (generation !== session) return;
  resetOutput(); loadAt = performance.now();
  let active;
  try {
    flow = active = createFlow();
    setState('loading', 'Loading model…');
    await active.speech.load();
    if (!active.isCurrent()) return;
    $('init').textContent = time(performance.now() - loadAt);
    $('progress').textContent = 'Model loaded.';
    setState('ready', 'Ready. Choose an audio source and tap Start.');
  } catch (error) { if (active?.isCurrent() ?? generation === session) await fail(error); }
};
$('start').onclick = async () => {
  const tab = $('source').value === 'tab', active = flow;
  setState('starting', tab ? 'Choose a browser tab and share its audio…' : 'Requesting microphone…');
  const init = $('init').textContent; resetOutput(); $('init').textContent = init;
  try {
    startedAt = performance.now();
    await active.pipeline.start();
    if (active.isCurrent() && state === 'starting') setState('recording', tab ? 'Listening to tab audio. Stop to finalize, or stop sharing in the browser.' : 'Listening. Speak the test utterance, pause, then Stop.');
  } catch (error) { if (active.isCurrent()) await fail(error); }
};
async function stop() {
  if (!['starting', 'recording'].includes(state)) return;
  stopAt = performance.now(); setState('stopping', 'Finalizing…');
  const active = flow;
  let current = active;
  try {
    await active.pipeline.stop();
    if (!active.isCurrent()) return;
    $('latency').textContent = time(performance.now() - stopAt); $('level').value = 0;
    // Each run gets fresh nodes/contexts, retaining the loaded models through
    // the speech adapter only after every final output has reached the sink.
    flow = createFlow(active.speech.nextSession());
    current = flow;
    await active.pipeline.dispose();
    if (current.isCurrent()) setState('ready', 'Stopped. Results are final; tap Start to repeat.');
  } catch (error) { if (current.isCurrent()) await fail(error); }
}
$('stop').onclick = () => void stop();
async function cancel(message) {
  setState('booting', 'Releasing…');
  const session = await release();
  if (generation === session) { resetOutput(); setState('idle', message); }
}
$('cancel').onclick = () => cancel('Canceled. Load a model to continue.');
$('source').onchange = () => {
  if (flow) void cancel('Audio source changed. Load a model to continue.');
};
window.addEventListener('pagehide', () => { void release(); });
window.addEventListener('unhandledrejection', (event) => void fail(event.reason));

async function boot() {
  resetOutput();
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone requires HTTPS or localhost and browser audio capture support.');
  if (!crossOriginIsolated) {
    if (!navigator.serviceWorker) throw new Error('This browser cannot enable the isolation required by the WASM runtimes. Use a server with COOP/COEP headers.');
    await navigator.serviceWorker.register('./isolation-worker.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    const key = `asr-isolation:${location.pathname}`;
    if (sessionStorage.getItem(key)) throw new Error('Browser isolation did not activate. Close other playground tabs, reload, or use a server with COOP/COEP headers.');
    sessionStorage.setItem(key, '1'); location.reload(); return;
  }
  sessionStorage.removeItem(`asr-isolation:${location.pathname}`);
  setState('idle', 'Load a model to begin.');
}
boot().catch(async (error) => {
  await fail(error);
  setState('unavailable', 'Browser setup failed. See runtime errors below.');
});
