# Japanese speech smoke fixture

`moonshine-japanese.wav` is synthetic Japanese speech generated offline with the
installed macOS Kyoko Japanese voice at rate 160, then wrapped with one second
of leading silence and two seconds of trailing silence. It is mono 16 kHz,
16-bit PCM. The known spoken text, exact bytes and SHA-256 are recorded in
`moonshine-speech.json`. It requires no platform speech engine at test time.
It tests actual Japanese model decoding; it does not establish human dictation accuracy.
