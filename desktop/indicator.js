const state = document.getElementById('state');
const text = document.getElementById('floating-text');
const stop = document.getElementById('stop');
const dismiss = document.getElementById('dismiss');
window.indicator.onUpdate(view => {
  if (text.textContent !== view.text) {
    text.textContent = view.text;
    text.hidden = !view.text;
    text.scrollTop = 0;
  }
  document.body.dataset.recording = String(view.microphone);
  state.textContent = view.error || ({ preparing: 'Preparing…', running: view.microphone ? 'Recording' : 'Running',
    stopping: 'Finishing…', canceling: 'Canceling…' })[view.phase] || '';
  stop.hidden = view.phase === 'idle' || view.phase === 'canceling';
  stop.disabled = view.phase === 'stopping';
  stop.textContent = view.phase === 'preparing' ? 'Cancel' : 'Stop';
  dismiss.hidden = !view.error || view.phase !== 'idle';
});
stop.onclick = window.indicator.stop;
dismiss.onclick = window.indicator.dismiss;
