// Frozen persisted descriptions: intentionally independent of current defaults.
export function legacyGraph({ enabled = true, direction = 'ja-en' } = {}, version = 3) {
  const node = (type, id, x, y, settings = {}) => ({ id, type, settings, position: { x, y } });
  const graph = { version, nodes: [node('ChromeTabAudio', 'audio', 20, 30), node('SpeechToText', 'speech', 270, 30), node('TranscriptView', 'transcript', 530, 30, { direction })], edges: [
    { from: ['audio', 'audio'], to: ['speech', 'audio'] },
    ...['provisional', 'final'].map(port => ({ from: ['speech', port], to: ['transcript', port] })),
  ] };
  if (enabled) {
    graph.nodes.push(node(direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn', 'translation', 270, 230), node('TranslationView', 'translated', 530, 230));
    for (const port of ['provisional', 'final']) graph.edges.push({ from: ['speech', port], to: ['translation', port === 'final' && version >= 4 ? 'text' : port] });
    if (version >= 5) {
      for (const port of ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisional', 'provisionalSource', 'provisionalStatus', 'provisionalError']) graph.edges.push({ from: ['translation', port], to: ['translated', port === 'provisional' ? 'provisionalText' : port] });
    } else for (const port of ['provisional', 'final']) graph.edges.push({ from: ['translation', version === 4 ? (port === 'final' ? 'finalResult' : 'provisionalResult') : port], to: ['translated', port] });
  }
  return graph;
}
export const legacyAdapter = (translated, id = 'text') => ({ id, type: translated ? 'TranslatedFinalText' : 'FinalText', settings: {}, position: { x: 20, y: 20 } });
