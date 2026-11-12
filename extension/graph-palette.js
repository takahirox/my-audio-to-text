// Add Node presentation only. Register every new built-in type here, including
// AI inference types regardless of how their model assets are shared or loaded.
// The exhaustive registry test prevents new types from silently falling into a
// port-count heuristic. Object order is the picker category order.
const categoryTypes = {
  'Sources / inputs': ['ChromeTabAudio', 'MicrophoneAudio', 'Button', 'Text', 'Number'],
  'AI Models / Speech Recognition': [
    'SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn',
    'SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn',
  ],
  'AI Models / Translation': [
    'OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaEnJa', 'TranslateGemmaJaEn',
  ],
  'AI Models / Text': [
    'TextSummaryLfm2', 'TextSummaryQwen35', 'IfCondition',
  ],
  'AI Models / Speech Synthesis': [
    'Supertonic3', 'Kokoro', 'Qwen3TtsStreaming', 'CosyVoice3Streaming',
  ],
  'Processors': [
    'TextFormatter', 'TextAccumulator', 'TextSlidingWindow', 'TextWindow', 'Hold',
    'KeyedTextPair', 'KeyedTextCoalesce', 'KeyedPairedTextAccumulator',
  ],
  'Outputs': ['Display', 'SpeakerOutput', 'StreamingSpeakerOutput', 'AudioOutput', 'FocusedInputTextOutputNode'],
  'Subgraphs': [],
};
export const PALETTE_CATEGORIES = Object.freeze(Object.keys(categoryTypes));
export const NODE_PALETTE_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.entries(categoryTypes).flatMap(([category, types]) => types.map(type => [type, category]))));

const labelCollator = new Intl.Collator('ja-JP', { usage: 'sort', sensitivity: 'base', numeric: true });
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Match Models: equivalent kana/case/numeric labels use exact text, then type
// (the stable subgraph ID for library entries), never registration order.
const compareEntries = ([aType, a], [bType, b]) => labelCollator.compare(a.label, b.label)
  || compareText(a.label, b.label) || compareText(aType, bType);

export function groupPaletteEntries(entries, { query = '', category = 'All categories' } = {}) {
  query = query.trim().toLowerCase();
  const groups = new Map(PALETTE_CATEGORIES.map(name => [name, []]));
  for (const [type, definition] of entries) {
    const name = type.startsWith('Subgraph:') ? 'Subgraphs' : NODE_PALETTE_CATEGORIES[type];
    if (!groups.has(name)) throw new Error(`Missing Add Node category for ${type}`);
    if ((category !== 'All categories' && category !== name) || !`${type} ${definition.label}`.toLowerCase().includes(query)) continue;
    groups.get(name).push([type, definition]);
  }
  return new Map([...groups].filter(([, options]) => options.length).map(([name, options]) => [name, options.sort(compareEntries)]));
}
