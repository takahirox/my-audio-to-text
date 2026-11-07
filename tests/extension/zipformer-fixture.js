export async function selectZipformer(page) {
  await page.evaluate(async () => {
    const { readLiveGraphData, saveLiveGraphData } = await import('./graph-library.js');
    const graph = readLiveGraphData(localStorage); graph.nodes.find(n => n.id === 'speech').type = 'SpeechToTextZipformerEn';
    await saveLiveGraphData(localStorage, graph);
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function(context) { window.capture = context; };
    ExtensionTabAudioNode.prototype.stop = function() {};
    const { SpeechToTextZipformerEnNode } = await import('../web/zipformer-node.js');
    const receive = SpeechToTextZipformerEnNode.prototype.receiveEvent;
    SpeechToTextZipformerEnNode.prototype.receiveEvent = function(event) {
      window.zipEvents ||= [];
      if (['partial', 'final', 'configuration', 'stopped'].includes(event.type)) window.zipEvents.push({ ...event, ms: performance.now(), fed: window.fedSamples || 0 });
      return receive.call(this, event);
    };
  });
  await page.editor.reload();
}
