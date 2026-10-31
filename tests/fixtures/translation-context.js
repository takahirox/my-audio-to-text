// Real-model probes: compare each target with the official prompt, the fixed
// context prompt, and an explicit reset. Expectations are hypotheses, not
// measured quality claims until the opt-in real smoke has actually run.
export const translationContextFixtures = {
  'en-ja': [
    { text: 'They are ready.', context: 'A single female surgeon has finished preparing for the operation. They refers to that surgeon. Context marker: ORCHID731.',
      meanings: [/彼女|外科医|執刀医/, /準備/], forbidden: /ORCHID731|手術|女性|operation|surgeon/i },
    { text: 'The port is blocked.', context: 'A network firewall has denied traffic to TCP port 443. This is a computing discussion. Context marker: CEDAR842.',
      meanings: [/ポート/, /ブロック|遮断|閉|塞/], forbidden: /CEDAR842|443|ファイア|TCP|firewall/i },
  ],
  'ja-en': [
    { text: 'あの人はもう準備ができています。', context: '「あの人」は女性の外科医一人を指します。背景の識別子は ORCHID731 です。',
      meanings: [/\bshe\b/i, /ready|prepared/i], forbidden: /ORCHID731|surgeon|female|identifier/i },
    { text: '先生が来ました。', context: '病院で医師について話しています。「先生」は学校の教師ではなく医師を指します。背景の識別子は CEDAR842 です。',
      meanings: [/doctor|physician/i, /arriv|came|come|here/i], forbidden: /CEDAR842|hospital|school|teacher|identifier/i },
  ],
};
