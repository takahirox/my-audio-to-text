import { Qwen3TtsNode } from '../../qwen3-tts-node.js';
import { mountStreamingTtsPage } from '../streaming-tts-page.js';
mountStreamingTtsPage(Qwen3TtsNode, () => ({ language: document.getElementById('language').value, voice: document.getElementById('voice').value }));
