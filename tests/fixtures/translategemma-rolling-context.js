// Synthetic rolling ASR from a project meeting; no private transcript data.
// Different paragraphs keep short fragments amid realistic, long history.
const english = `Thanks for joining. We are reviewing the audio transcription rollout and the support team's notes from yesterday. The pilot group could hear the meeting clearly, but the live captions sometimes arrived after the speaker had already moved on. We should keep the original transcript available so that reviewers can compare it with the translated version.
Maya checked the browser logs this morning. She found that the network connection was stable throughout the call. The delay appeared when someone shared a screen and the laptop was also processing video. We have not established a cause, so please describe that as an observation rather than a confirmed performance problem.
The next demonstration is scheduled for Friday at ten. Ken will bring the updated slides, and Maya will explain the accessibility feedback. They asked whether the captions can remain visible while a participant changes tabs. We need to confirm that behavior on the actual browser before promising it to customers.
For the network test, use the staging service rather than production. The port is blocked on the guest network, and the administrator will review the firewall rules after lunch. That is a separate task from the caption delay. Please keep those findings in separate sections of the report so that the two teams do not confuse them.
We also discussed translation quality. A short sentence may depend on a subject introduced several turns earlier. The history should help interpret that subject, but it should not be added to the new sentence. The support team wants the current speaker's words to remain recognizable, especially when someone interrupts or changes their mind.
Before we close, can everyone check the action list? Ken owns the slides, Maya owns the browser comparison, and I will send the summary after the results are reviewed. We will keep the release date provisional until those checks are complete. If a new issue appears during the pilot, record the exact sentence and the surrounding discussion. Background marker: ROLLING731.`;

const japanese = `参加ありがとうございます。今日は音声文字起こしの導入と、昨日サポートチームから届いたメモを確認します。試験参加者には会議の音声がはっきり聞こえていましたが、話者が次の話題に進んでから字幕が表示される場合がありました。翻訳結果と比較できるように、元の文字起こしも残す必要があります。
今朝、真由さんがブラウザーのログを確認しました。通話中のネットワーク接続は安定していたそうです。画面共有と動画処理を同時に行ったときに遅れが見られました。ただし原因は確定していません。性能の問題が証明されたとは書かず、観察した事実として報告してください。
次のデモは金曜日の午前十時です。健さんが新しいスライドを用意し、真由さんがアクセシビリティに関する意見を説明します。参加者がタブを切り替えている間も字幕を表示できるか質問がありました。お客様に約束する前に、実際のブラウザーで動作を確認する必要があります。
ネットワークの検証には本番環境ではなく検証用サービスを使ってください。ゲスト用ネットワークではポートが遮断されており、管理者が昼食後にファイアウォールの設定を見直す予定です。これは字幕の遅れとは別の作業です。担当する二つのチームが混同しないように、報告書でも項目を分けてください。
翻訳の品質についても話しました。短い文の主語が、数回前の発言で紹介された人物を指すことがあります。履歴はその解釈を助けるためのもので、新しい文に過去の説明を付け足すためのものではありません。特に話を遮ったり言い直したりした場合には、今の話者の発言が分かるようにしたいという要望です。
最後に、作業一覧を確認してください。健さんがスライド、真由さんがブラウザー比較を担当し、結果を確認してから私が要約を送ります。検証が終わるまでは公開日を仮の日程として扱います。試験中に新しい問題が出たら、実際の発言と前後の会話を記録しましょう。背景の識別子は ROLLING731 です。`;

export const rollingContextFixtures = {
  'en-ja': [
    { text: 'But.', meanings: [/しかし|でも|けれど/] },
    { text: 'Right.', meanings: [/はい|そう|正し|わか|かしこまり|承知|その通り/] },
  ].map(probe => ({ ...probe, context: english, forbidden: /字幕|ブラウザ|文字起こし|ネットワーク|ROLLING731/ })),
  'ja-en': [
    { text: 'でも。', meanings: [/\b(?:but|however)\b/i] },
    { text: 'はい。', meanings: [/\b(?:yes|okay|ok|right)\b/i] },
  ].map(probe => ({ ...probe, context: japanese, forbidden: /caption|subtitle|transcription|browser|network|ROLLING731/i })),
};
