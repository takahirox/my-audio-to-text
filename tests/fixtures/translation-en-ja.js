// Semantic regressions for real inference, not merely Japanese-script output.
// Accept equivalent wording while requiring the key meaning of each sentence.
export const ordinaryEnglishFixtures = [
  { text: 'Hello.', meanings: [/こんにちは|こんにちわ/] },
  { text: 'The meeting starts at ten.', meanings: [/会議|集会|ミーティング/, /10|１０|十/, /始|開始|スタート/] },
  { text: 'Please send me the report.', meanings: [/報告書|レポート/, /送|寄越/] },
  { text: 'Where is the train station?', meanings: [/駅/, /どこ|何処/] },
  { text: 'We need to finish this project by Friday.', meanings: [/金曜/, /プロジェクト/, /完了|終/] },
].flatMap(fixture => [fixture, { ...fixture, text: fixture.text.toUpperCase() }]);
