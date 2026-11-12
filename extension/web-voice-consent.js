import { WEB_VOICE_ORIGINS } from './web-voice-preference.js';
const params = new URLSearchParams(location.search), enabled = params.get('enabled') === 'true';
const retry = document.getElementById('retry'), error = document.getElementById('error');
error.textContent = params.get('error') || '';
document.getElementById('consent').hidden = !enabled;
retry.textContent = enabled ? 'Enable' : 'Retry OFF';
retry.hidden = !params.has('enabled');
document.getElementById('close').onclick = () => window.close();
retry.onclick = () => {
  // The explicit button is a fresh Chrome user gesture even when the original
  // context-menu permission request was rejected for lacking activation.
  let permission;
  try { permission = enabled ? chrome.permissions.request({ origins: WEB_VOICE_ORIGINS }) : Promise.resolve(true); }
  catch (failure) { permission = Promise.reject(failure); }
  const attempt = enabled ? chrome.runtime.sendMessage({ type: 'web-voice-consent-begin' }) : Promise.resolve({});
  retry.disabled = true;
  void (async () => {
    const [granted, { token }] = await Promise.all([permission, attempt]);
    if (!granted) throw Error('Website access denied or dismissed. Web microphone remains OFF.');
    const result = await chrome.runtime.sendMessage({ type: 'web-voice-set-enabled', enabled, granted: enabled, token });
    if (!result?.ok) throw Error(result?.error || 'Web microphone did not respond. Retry.');
    window.close();
  })().catch(failure => { error.textContent = failure.message; }).finally(() => { retry.disabled = false; });
};
