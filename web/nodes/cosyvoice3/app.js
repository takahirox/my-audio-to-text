import { CosyVoice3Node } from '../../cosyvoice3-node.js';
import { mountStreamingTtsPage } from '../streaming-tts-page.js';
mountStreamingTtsPage(CosyVoice3Node, () => ({ language: document.getElementById('language').value, voice: document.getElementById('voice').value }));
