export const WEB_VOICE_KEY = 'web-voice-typing-v1';
export const WEB_VOICE_ORIGINS = ['http://*/*', 'https://*/*'];
export const WEB_VOICE_POSITION_KEY = 'web-microphone-position-v1';
export const WEB_VOICE_POSITIONS = ['auto', 'left', 'right'];
export function voicePosition(value) { return WEB_VOICE_POSITIONS.includes(value) ? value : 'auto'; }
export async function readVoicePosition() { return voicePosition((await chrome.storage.local.get(WEB_VOICE_POSITION_KEY))[WEB_VOICE_POSITION_KEY]); }
export async function setVoicePosition(position) {
  if (!WEB_VOICE_POSITIONS.includes(position)) throw Error('Invalid microphone position.');
  await chrome.storage.local.set({ [WEB_VOICE_POSITION_KEY]: position });
}
// Assignment and consent deliberately have separate stores and lifetimes.
export function voiceEnabled(value) { return value?.version === 1 && value.enabled === true; }
export async function readVoiceEnabled() { return voiceEnabled((await chrome.storage.local.get(WEB_VOICE_KEY))[WEB_VOICE_KEY]); }
export async function setVoiceEnabled(enabled, operationId) {
  if (typeof enabled !== 'boolean') throw Error('Invalid Web voice typing preference.');
  await chrome.storage.local.set({ [WEB_VOICE_KEY]: { version: 1, enabled, ...(operationId ? { operationId } : {}) } });
}
