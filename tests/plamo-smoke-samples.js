// Shared opt-in real-model checks. No speech recognition or remote inference.
export const plamoSmokeSamples = [
  { text: '会議は来週の月曜日に変更されました。', source: '', target: '', expected: /meeting.*(?:next Monday|Monday next week)/i },
  { text: 'The weather is nice today.', source: '', target: '', expected: /今日.*(?:天気|晴)/ },
  { text: 'The weather is nice today.', source: 'auto', target: 'auto', expected: /今日.*(?:天気|晴)/ },
  { text: '会議は来週の月曜日に変更されました。', source: '', target: 'en', expected: /meeting.*(?:next Monday|Monday next week)/i },
  { text: 'The weather is nice today.', source: 'en', target: 'ja', expected: /今日.*(?:天気|晴)/ },
  { text: 'La réunion aura lieu lundi prochain.', source: 'fr', target: 'ja', expected: /(?:会議|ミーティング).*(?:月曜|月曜日)/ },
  { text: '회의는 다음 주 월요일에 열립니다.', source: 'ko', target: 'en', expected: /meeting.*(?:next Monday|Monday next week)/i },
  { text: '会议将在下周一举行。', source: 'zh-hans', target: 'ja', expected: /(?:会議|ミーティング).*(?:月曜|月曜日)/ },
  { text: '會議將於下週一舉行。', source: 'zh-hant', target: 'ja', expected: /(?:会議|ミーティング).*(?:月曜|月曜日)/ },
  { text: 'Please open the project dashboard.', source: 'auto', target: 'ja', expected: /(?:ダッシュボード|管理画面)/ },
];
