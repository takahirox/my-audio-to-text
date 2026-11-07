export async function selectWhisper(page, language) {
  await page.evaluate(async language => {
    const { graphNode, edge } = await import('./graph.js'); const { readLiveGraphData, saveLiveGraphData } = await import('./graph-library.js');
    const graph = readLiveGraphData(localStorage); graph.nodes.find(n => n.id === 'speech').type = 'SpeechToTextWhisper';
    graph.edges = graph.edges.filter(route => !(route.from[0] === 'speech' && ['provisional', 'provisionalId'].includes(route.from[1])));
    if (language !== undefined) {
      graph.nodes.push(graphNode('Text', 'language')); graph.nodes.at(-1).settings.value = language;
      graph.edges.push(edge('language', 'value', 'speech', 'language'));
    }
    await saveLiveGraphData(localStorage, graph);
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function(context) { window.capture = context; };
    ExtensionTabAudioNode.prototype.stop = function() {};
  }, language);
  await page.editor.reload();
}
