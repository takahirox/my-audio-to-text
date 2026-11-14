// Preserve extension cache-only policy; normal web Workers prepare on explicit Run.
const assets = cache => import(globalThis.location.protocol === 'chrome-extension:'
  ? `../extension/${cache}-cache.js` : './playground-model-assets.js');
export async function parakeetManifest(...args) { return (await assets('optional-asr')).parakeetManifest(...args); }
export async function moonshineManifest(...args) { return (await assets('optional-asr')).moonshineManifest(...args); }
export async function optionalAsrFiles(...args) { return (await assets('optional-asr')).optionalAsrFiles(...args); }
export async function cacheOnlyTextSummaryRuntime(...args) { return (await assets('text-summary')).cacheOnlyTextSummaryRuntime(...args); }
export async function cacheOnlyIfConditionRuntime(...args) { return (await assets('if-condition')).cacheOnlyIfConditionRuntime(...args); }
export async function qwen3TtsAssets(...args) { return (await assets('qwen3-tts')).qwen3TtsAssets(...args); }
export async function cosyVoice3Assets(...args) { return (await assets('cosyvoice3')).cosyVoice3Assets(...args); }
