import { portContract } from './pipeline.js';
// Shared identities, without model/runtime dependencies.
export const TEXT = portContract('text');
export const NUMBER = portContract('number');
// Portable complete text-row snapshots; see view.js and docs/view.md.
export const VIEW = portContract('view');
// Native inert DOM snapshots; page main thread only, never Worker messages.
export const DOM = portContract('dom');
