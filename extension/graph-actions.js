import { buttonLabel } from '../web/button-node.js';

function actionReason(owner, reachable, running) {
  if (!running || owner?.pipeline?.state !== 'running') return 'Start a session to use graph actions.';
  if ([...reachable].some(target => target.failed)) return 'Action path unavailable; start a fresh session.';
  if ([...(owner.actions?.values() || [])].some(action => [...reachable].some(target => action.has(target)))) {
    return 'Action busy; waiting for downstream work.';
  }
  return '';
}

export function graphActions(graph, owner, running) {
  return (graph?.nodes || []).filter(node => node.type === 'Button')
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(spec => {
      const reachable = owner?.pipeline?.entries.get(spec.id)?.reachable || new Set();
      const reason = actionReason(owner, reachable, running);
      return { id: spec.id, label: buttonLabel(spec.settings.label), disabled: !!reason, reason };
    });
}

export async function pressGraphButton(owner, id, { running, owns, onChange }) {
  const entry = owner?.pipeline?.entries.get(id);
  if (owner?.description.nodes.find(node => node.id === id)?.type !== 'Button'
      || !entry?.active || entry.closed || entry.failed || actionReason(owner, entry.reachable, running)) return false;
  owner.actions ??= new Map();
  owner.actions.set(id, entry.reachable);
  onChange();
  try {
    if (!entry.node.press()) return false;
    // Wait for the reachable queues and owned async work to settle. While they
    // drain, independent paths can accept clicks and overlapping ones cannot.
    let previous;
    while (owns() && owner.pipeline.state !== 'disposed') {
      const queues = [...entry.reachable].flatMap(target => [target.queue, ...[...target.work].map(work => work.done)]);
      if (previous && queues.length === previous.length && queues.every((queue, i) => queue === previous[i])) break;
      previous = queues;
      await Promise.allSettled(queues);
    }
    return true;
  } finally {
    owner.actions.delete(id);
    if (owns()) onChange();
  }
}
