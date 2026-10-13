import { portContract } from './pipeline.js';
// Shared identities, without model/runtime dependencies.
export const TEXT = portContract('text');
// An indivisible result for paired views across asynchronous work. Ordinary
// text consumers use TEXT; they never need this optional diagnostic output.
export const TEXT_RESULT = portContract('text result { source, text, status, index, error }');
