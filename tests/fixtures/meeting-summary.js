import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

// Evidence deliberately includes proposals, a correction, repetition, a changed
// task state, and an owner that must remain unknown. These are not gold outputs.
export const meetingBatches = [
  'Mika: We could launch the pilot on November 12 with a budget of 300,000 yen. This is only a proposal. Someone should check accessibility; I do not know who. Ken: We still need approval.',
  'Mika: Correction: the proposed budget is 250,000 yen, not 300,000. Ken: Approved. We have decided to launch the pilot on November 12 with a 250,000 yen budget. Mika: I will send the invitations by Friday. Ken: We still need approval for the venue, not for the pilot.',
  'ミカ: 招待状は送信済みです。ケン: 会場はまだ未承認です。アクセシビリティの確認担当者は不明です。ケン: 会場はまだ未承認です。',
];
export function meetingGraph(type) {
  const nodes = [graphNode('Text', 'input'), graphNode(type, 'summary'), graphNode('LiveTextDisplay', 'notes'), graphNode('LiveTextDisplay', 'transcript')];
  nodes[0].settings.value = meetingBatches[0];
  nodes[2].settings = { label: 'Meeting notes', language: 'ja' };
  return { version: GRAPH_VERSION, nodes, edges: [edge('input', 'value', 'summary', 'text'), edge('summary', 'summary', 'notes', 'replace'), edge('input', 'value', 'transcript', 'append')] };
}
