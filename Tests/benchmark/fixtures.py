"""Generated tones and deterministic fake ASR, explicitly NOT a speech-quality dataset."""
import json
import math
from pathlib import Path
import struct
import sys
import wave


def make_fixture(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    specs = [
        ("t1", "train", "g1", "p1", "normal", "今日はGPTソールを使います", "今日はGPT Solを使います"),
        ("t2", "train", "g2", "p2", "quiet", "明日はGPTソールを使います", "明日はGPT Solを使います"),
        ("e1", "eval", "g3", "p3", "normal", "今夜はGPTソールを使いますよ", "今夜はGPT Solを使いますよ"),
        ("e2", "eval", "g3", "p3", "quiet", "今夜はGPTソールを使いますよ", "今夜はGPT Solを使いますよ"),
        ("e3", "eval", "g3", "p3", "whisper", "今夜はGPTソールを使いますよ", "今夜はGPT Solを使いますよ"),
        ("e4", "eval", "g4", "p4", "normal", "今日は靴のソールを洗います", "今日は靴のソールを洗います"),
    ]
    samples, hypotheses = [], {}
    for index, (sid, split, group, prompt, condition, hypothesis, reference) in enumerate(specs):
        with wave.open(str(directory / (sid + ".wav")), "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"".join(struct.pack("<h", int(2000 * math.sin(2 * math.pi * (200 + 100 * index) * n / 16000))) for n in range(1600)))
        samples.append(dict(id=sid, speakerID="speaker1", sessionID="session-" + sid,
                            groupID=group, promptID=prompt, split=split, condition=condition,
                            audio=sid + ".wav", reference=reference))
        hypotheses[sid] = hypothesis
    draft = directory / "draft.json"
    draft.write_text(json.dumps({"samples": samples}, ensure_ascii=False), encoding="utf-8")
    backend = directory / "fake-whisper.py"
    backend.write_text("#!" + sys.executable + "\n" + '''import json, pathlib, sys
args = sys.argv[1:]
audio = pathlib.Path(args[args.index('-f') + 1])
root = pathlib.Path(args[args.index('-of') + 1] + '.json')
hypotheses = ''' + repr(hypotheses) + '''
text = hypotheses[audio.stem]
root.write_text(json.dumps({'transcription': [{'text': text, 'offsets': {'from': 0, 'to': 100}, 'tokens': [{'p': 0.8}]}]}))
''', encoding="utf-8")
    backend.chmod(0o700)
    model = directory / "fake-model.bin"
    model.write_bytes(b"fake model: not an acoustic model\n")
    config = directory / "config.json"
    config.write_text(json.dumps(dict(whisperExecutable=str(backend.resolve()), whisperModel=str(model.resolve()),
                                     llamaExecutable="", llamaModel="", language="ja", retainAudio=False,
                                     chunkSeconds=8, partialIntervalSeconds=2, synthesisContextTokens=16384,
                                     synthesisOutputTokens=2048, personalization=True)), encoding="utf-8")
    return draft, config

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate non-speech PCM tones and a fake ASR for pipeline checks")
    parser.add_argument("destination")
    args = parser.parse_args()
    if Path(args.destination).exists():
        parser.error("destination already exists")
    draft, config = make_fixture(args.destination)
    print("NON-SPEECH FIXTURE ONLY:", draft, config)
