import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

// Evidence deliberately includes proposals, a correction, repetition, a changed
// task state, and an owner that must remain unknown. Speaker labels stay
// identical across languages: transliteration alone does not establish identity.
// These are not gold outputs.
export const meetingBatches = [
  'Mika: We could launch the pilot on November 12 with a budget of 300,000 yen. This is only a proposal. Someone should check accessibility; I do not know who. Ken: We still need approval.',
  'Mika: Correction: the proposed budget is 250,000 yen, not 300,000. Ken: Approved. We have decided to launch the pilot on November 12 with a 250,000 yen budget. Mika: I will send the invitations by Friday. Ken: We still need approval for the venue, not for the pilot.',
  'Mika: 招待状は送信済みです。Ken: 会場は承認済みではありません。アクセシビリティの確認担当者は不明です。Ken: 会場は承認済みではありません。',
];
export function meetingGraph(type) {
  const nodes = [graphNode('Text', 'input'), graphNode(type, 'summary'), graphNode('LiveTextDisplay', 'notes'), graphNode('LiveTextDisplay', 'transcript')];
  nodes[0].settings.value = meetingBatches[0];
  nodes[2].settings = { label: 'Meeting notes', language: 'ja' };
  return { version: GRAPH_VERSION, nodes, edges: [edge('input', 'value', 'summary', 'text'), edge('summary', 'summary', 'notes', 'replace'), edge('input', 'value', 'transcript', 'append')] };
}

// Objective regression checks for the recorded #130 failures, not a quality
// score. Accept spelling/spacing variants and the original three-section format.
export function meetingFactChecks(summary, batch) {
  summary = summary.replace(/[ \t]/g, '');
  const sections = {};
  let section;
  for (const line of summary.split('\n')) {
    const heading = line.replace(/^[#*\s]+|[*\s]+$/g, '');
    if (['議論の要点', '決定事項', '完了事項', '未解決の質問・対応事項'].includes(heading)) {
      section = heading; sections[section] = '';
    } else if (section) sections[section] += line + '\n';
  }
  const decisions = sections['決定事項'] || '', completed = sections['完了事項'] || '', open = sections['未解決の質問・対応事項'] || '';
  const completionClaim = summary.split('\n').some(line =>
    /(?:完了|完遂)(?:した|しました|している|しています|されました|された|済)/.test(line)
    && !/(?:未完了|未完遂|していない|されていない|作業はありません)/.test(line));
  const checks = {
    readableSections: ['議論の要点', '決定事項', '未解決の質問・対応事項'].every(key => key in sections),
    unknownAccessibilityOwner: /(?:アクセシビリティ|アクセス性|アクセスチェック)[^\n]*(?:不明|分からない|わからない)|不明[^\n]*(?:アクセシビリティ|アクセス性|アクセスチェック)/.test(summary),
    noRecordedInventedNames: !/米田|山田|山本/.test(summary),
  };
  if (batch === 0) Object.assign(checks, {
    proposalNotDecision: /なし|None|未決定|未確定|未定|承認待|未承認/.test(decisions) && !/11月12|30万|300,000/.test(decisions),
    noInventedCompletedWork: !completionClaim && (!completed || /^[-*]*(?:なし|None|無)[。.]?\s*$/.test(completed.trim())),
    proposalRetained: /11月12日/.test(summary) && /300,?000|30万/.test(summary),
  });
  else Object.assign(checks, {
    correctedBudget: /250,?000|25万/.test(summary) && !/300,?000|30万/.test(decisions),
    pilotApproved: /パイロット|試験|pilot/i.test(decisions) && /11月12日/.test(summary) && !/未承認|承認待|追加承認/.test(decisions),
    venuePending: /会場[^\n]*(?:未承認|承認待|承認が必要|承認は未|未.*承認|承認済みでは(?:ありません|ない))/.test(open),
    venueNotConfirmed: !/会場/.test(decisions),
    invitations: batch === 1
      ? /招待[^\n]*(?:金曜|Friday)|(?:金曜|Friday)[^\n]*招待/.test(summary) && !/招待[^\n]*(?:送信済|送付済|送信.*完了|送付.*完了)/.test(summary)
      : /招待[^\n]*(?:送信済|送付済|送信.*完了|送付.*完了)/.test(summary) && !/招待/.test(open),
  });
  return checks;
}
