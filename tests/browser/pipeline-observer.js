// Observe the production graph and optionally delay its real transcript sink.
export async function observePipeline(page, moduleRoot = '/') {
  await page.evaluate(async moduleRoot => {
    const { Pipeline } = await import(`${moduleRoot}pipeline.js`);
    const { TranscriptOutputNode } = await import(`${moduleRoot}transcription-nodes.js`);
    window.pipelineCalls = [];
    window.pipelineGraphs = [];
    for (const hook of ['start', 'stop', 'dispose']) {
      const original = Pipeline.prototype[hook];
      Pipeline.prototype[hook] = function (...args) {
        let id = window.pipelineGraphs.indexOf(this);
        if (id === -1) id = window.pipelineGraphs.push(this) - 1;
        window.pipelineCalls.push({ hook, id });
        return original.apply(this, args);
      };
    }
    const receive = TranscriptOutputNode.prototype.receive;
    TranscriptOutputNode.prototype.receive = async function (port, value, context) {
      if (port === 'final' && window.holdTranscript) {
        window.heldTranscript = value;
        await new Promise(resolve => { window.releaseTranscript = resolve; });
      }
      if (!context.signal.aborted) return receive.call(this, port, value, context);
    };
  }, moduleRoot);
}

export async function graphTypes(page) {
  return page.evaluate(() => Array.from(window.pipelineGraphs[0].entries.values(), entry => entry.node.constructor.name));
}
