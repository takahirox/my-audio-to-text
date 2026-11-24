const state = document.getElementById('state');
const stop = document.getElementById('stop');
const dismiss = document.getElementById('dismiss');
window.indicator.onUpdate(view => {
  document.body.dataset.recording = String(view.microphone);
  state.textContent = view.error || ({ preparing: 'Preparing…', running: view.microphone ? 'Recording' : 'Running', stopping: 'Finishing…' })[view.phase] || '';
  stop.hidden = view.phase === 'idle' || view.phase === 'canceling';
  stop.disabled = view.phase === 'stopping';
  stop.textContent = view.phase === 'preparing' ? 'Cancel' : 'Stop';
  dismiss.hidden = !view.error || view.phase !== 'idle';
});
stop.onclick = window.indicator.stop;
dismiss.onclick = window.indicator.dismiss;
