// Expected text is an evaluation reference, not an assertion of model quality.
// Synthetic error cases do not establish actual ASR error-rate improvement.
export const correctionFixtures = [
  { id: 'ja-correct', language: 'ja', kind: 'exact-copy', text: '今日は良い天気です。', expected: '今日は良い天気です。' },
  { id: 'en-correct', language: 'en', kind: 'exact-copy', text: 'There is a cat on the table.', expected: 'There is a cat on the table.' },
  { id: 'ja-error', language: 'ja', kind: 'correction', text: '今日は良い転機です。', expected: '今日は良い天気です。' },
  { id: 'en-error', language: 'en', kind: 'correction', text: 'Their is a cat on the table.', expected: 'There is a cat on the table.' },
  { id: 'ja-lexical-error', language: 'ja', kind: 'correction', text: '明日の天気予法を確認します。', expected: '明日の天気予報を確認します。' },
  { id: 'en-lexical-error', language: 'en', kind: 'correction', text: 'I parked my car in the barking lot.', expected: 'I parked my car in the parking lot.' },
  { id: 'ja-date-time', language: 'ja', kind: 'exact-copy', text: '会議は2026年10月9日の14:30です。', expected: '会議は2026年10月9日の14:30です。' },
  { id: 'en-date-time', language: 'en', kind: 'exact-copy', text: 'The meeting is on October 9, 2026 at 14:30.', expected: 'The meeting is on October 9, 2026 at 14:30.' },
  { id: 'ja-figures', language: 'ja', kind: 'exact-copy', text: '料金は3,500円で、人数は12人です。', expected: '料金は3,500円で、人数は12人です。' },
  { id: 'en-figures', language: 'en', kind: 'exact-copy', text: 'The price is $3,500.50 for 12 people.', expected: 'The price is $3,500.50 for 12 people.' },
  { id: 'ja-names', language: 'ja', kind: 'exact-copy', text: '渡辺さんと田中さんは新宿で会います。', expected: '渡辺さんと田中さんは新宿で会います。' },
  { id: 'en-names', language: 'en', kind: 'exact-copy', text: 'Takahiro Watanabe works with ReazonSpeech in Shinjuku.', expected: 'Takahiro Watanabe works with ReazonSpeech in Shinjuku.' },
  { id: 'ja-negation', language: 'ja', kind: 'exact-copy', text: '私は明日の会議に出席しません。', expected: '私は明日の会議に出席しません。' },
  { id: 'en-negation', language: 'en', kind: 'exact-copy', text: 'I will not attend the meeting tomorrow.', expected: 'I will not attend the meeting tomorrow.' },
];
