// Real-model probes: compare each target with the official prompt, the fixed
// context prompt, and an explicit reset. Check target meaning and absence of
// background details. The official-aligned #190 prompt does not reliably add
// the female subject requested by context; retain those raw negative results
// in docs/evidence/translation-190-prompts.json rather than requiring gender
// insertion as a translation contract. Domain disambiguation remains checked.
export const translationContextFixtures = {
  'en-ja': [
    { text: 'They are ready.', context: 'A single female surgeon has finished preparing for the operation. They refers to that surgeon. Context marker: ORCHID731.',
      meanings: [/準備/], forbidden: /ORCHID731|手術|女性|operation|surgeon/i },
    { text: 'The port is blocked.', context: 'A network firewall has denied traffic to TCP port 443. This is a computing discussion. Context marker: CEDAR842.',
      meanings: [/ポート/, /ブロック|遮断|閉|塞/], forbidden: /CEDAR842|443|ファイア|TCP|firewall/i },
  ],
  'ja-en': [
    { text: 'あの人はもう準備ができています。', context: '「あの人」は女性の外科医一人を指します。背景の識別子は ORCHID731 です。',
      meanings: [/\b(?:she|that person)\b/i, /ready|prepared/i], forbidden: /ORCHID731|surgeon|female|identifier/i },
    { text: '先生が来ました。', context: '病院で医師について話しています。「先生」は学校の教師ではなく医師を指します。背景の識別子は CEDAR842 です。',
      meanings: [/doctor|physician/i, /arriv|came|come|here/i], forbidden: /CEDAR842|hospital|school|teacher|identifier/i },
  ],
};
