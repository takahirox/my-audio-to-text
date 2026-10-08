# Ordinary English speech fixture

`ordinary-english.wav` is synthetic speech, not a human recording or an ASR mock.
It was generated offline on macOS using the installed Samantha English voice:

```sh
say -v Samantha -r 145 -o meeting.wav --data-format=LEI16@16000 'The meeting starts at ten.'
say -v Samantha -r 145 -o report.wav --data-format=LEI16@16000 'Please send me the report.'
say -v Samantha -r 145 -o deadline.wav --data-format=LEI16@16000 'We need to finish this project by Friday.'
```

The three WAV PCM streams were concatenated in that order using Python's `wave`
module, with one second of leading silence and two seconds of silence after each
sentence. The committed result is mono, 16 kHz, 16-bit PCM, 403,992 bytes, SHA-256
`21212faed6ae5f5958603d4d7cf60a423f1090fb6542d00e3a826ebe6235a768`.
Voice/platform versions can produce different bytes; tests use the committed
fixture, with no speech-synthesis dependency or network download at test time.

The opt-in MV3 smoke plays this through a real tab and native tab capture, then
runs the production ReazonSpeech and English → Japanese OPUS-MT Node/Worker. It
asserts meeting time, report request and project deadline meanings on the actual
paired final rows, rather than merely requiring Japanese characters. ASR partials
are recorded separately and may contain incomplete words. This fixture and the
separate typed-text checks are evidence of real inference, not human validation.
