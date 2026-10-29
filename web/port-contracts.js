import { portContract } from './pipeline.js';
// Shared identities, without model/runtime dependencies.
export const TEXT = portContract('text');
export const NUMBER = portContract('number');
// Native inert DOM snapshots; page main thread only, never Worker messages.
export const DOM = portContract('dom');
