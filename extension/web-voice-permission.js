const allow = document.getElementById('allow-microphone'), status = document.getElementById('permission-status');
let ended = false;
async function result(error = '') {
  if (ended) return;
  ended = true; allow.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'web-voice-permission-result', error });
    if (response?.error) status.textContent = response.error;
  } catch { status.textContent = 'Extension disconnected. Close this setup tab and click the original field mic to retry.'; }
}
allow.onclick = async () => {
  allow.disabled = true; status.textContent = 'Choose Allow in Chrome’s microphone permission request.';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Setup never runs inference or retains a recording stream, including late
    // permission resolutions after cancellation/navigation.
    stream.getTracks().forEach(track => track.stop());
    if (!ended) await result();
  } catch (error) {
    await result(`${error.name}: Microphone setup failed. Allow the extension in Chrome microphone settings, check the device and OS privacy settings, then click the original field mic to retry.`);
  }
};
document.getElementById('cancel').onclick = () => { void result('Microphone setup canceled. Click the field mic to retry.'); };
window.addEventListener('pagehide', () => { ended = true; });
