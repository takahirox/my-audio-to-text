import { portContract } from './pipeline.js';
// Shared identities, without payload envelopes or model/runtime dependencies.
export const TEXT = portContract('text');
export const TRANSCRIPT = portContract('transcript { text, id }');
