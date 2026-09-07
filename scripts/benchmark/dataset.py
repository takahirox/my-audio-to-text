"""Immutable local audio datasets. No third-party dependencies or network operations."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unicodedata
import wave


class BenchmarkError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise BenchmarkError(message)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key: " + key)
        result[key] = value
    return result


def read_json(path):
    def invalid(value):
        raise BenchmarkError("non-finite JSON number")
    with open(path, encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=_object, parse_constant=invalid)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_new(path, value):
    """Publish complete files without replacing existing results/manifests."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".benchmark-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value if isinstance(value, bytes) else canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


METRIC = {"id": "ja-cer-codepoint-v1", "unicodeVersion": unicodedata.unidata_version,
          "normalization": "NFKC, casefold, NFC, alphanumeric codepoints only"}
PREPROCESSING = {"id": "pcm16-mono-16khz-no-transform-v1", "sampleRate": 16000,
                 "channels": 1, "sampleWidthBytes": 2}
CONDITIONS = ("normal", "quiet", "whisper", "unknown")
IDS = ("id", "speakerID", "sessionID", "groupID", "promptID")
DRAFT_FIELDS = set(IDS) | {"split", "condition", "reference", "audio"}
AUDIO_FIELDS = {"audioSHA256", "pcmSHA256", "frames", "durationSeconds"}


def normalize(text):
    text = unicodedata.normalize("NFC", unicodedata.normalize("NFKC", text).casefold())
    return "".join(c for c in text if c.isalnum())


def audio_info(path):
    try:
        with wave.open(str(path), "rb") as audio:
            require((audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype())
                    == (1, 2, 16000, "NONE"), "audio must be uncompressed PCM16 mono 16000 Hz WAV")
            frames = audio.getnframes()
            require(frames > 0, "audio has no frames")
            h, size = hashlib.sha256(), 0
            while True:
                data = audio.readframes(65536)
                if not data:
                    break
                h.update(data)
                size += len(data)
            require(size == frames * 2, "truncated WAV data")
    except (wave.Error, EOFError) as error:
        raise BenchmarkError("invalid WAV") from error
    return {"audioSHA256": file_hash(path), "pcmSHA256": h.hexdigest(),
            "frames": frames, "durationSeconds": frames / 16000}


def validate_samples(samples, sealed):
    require(isinstance(samples, list) and samples, "dataset samples must be a nonempty list")
    seen, pcm_seen, links, group_splits = set(), set(), {}, {}
    for sample in samples:
        require(isinstance(sample, dict), "sample must be an object")
        require(set(sample) == DRAFT_FIELDS | (AUDIO_FIELDS if sealed else set()), "unexpected/missing sample fields")
        for key in IDS:
            require(isinstance(sample[key], str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", sample[key]),
                    "invalid " + key)
        require(sample["id"] not in seen, "duplicate sample ID: " + sample["id"])
        seen.add(sample["id"])
        require(sample["split"] in ("train", "eval"), "split must be train or eval")
        require(sample["condition"] in CONDITIONS, "invalid speech condition")
        require(isinstance(sample["reference"], str) and len(sample["reference"]) <= 10000, "invalid/oversized reference")
        require(isinstance(sample["audio"], str) and sample["audio"], "audio path is required")
        group = sample["groupID"]
        require(group_splits.setdefault(group, sample["split"]) == sample["split"], "group crosses train/eval: " + group)
        # Shared sessions, parallel prompts and normalized references must have one leakage group.
        # Thus whole-group learning-curve subsets also preserve these relationships.
        relations = [("session", sample["sessionID"]), ("prompt", sample["promptID"])]
        if normalize(sample["reference"]):
            relations.append(("reference", normalize(sample["reference"])))
        if sealed:
            require(sample["pcmSHA256"] not in pcm_seen, "duplicate PCM audio would double-count an utterance")
            pcm_seen.add(sample["pcmSHA256"])
            relations.append(("pcm", sample["pcmSHA256"]))
        for relation in relations:
            require(links.setdefault(relation, group) == group,
                    "linked samples must share groupID (" + relation[0] + ")")
    require(any(s["split"] == "eval" for s in samples), "dataset has no evaluation samples")


def manifest_hashes(manifest):
    body = {k: v for k, v in manifest.items() if k not in ("datasetDigest", "evaluationDigest")}
    evaluation = {"schemaVersion": body["schemaVersion"], "metric": body["metric"],
                  "preprocessing": body["preprocessing"],
                  "samples": [s for s in body["samples"] if s["split"] == "eval"]}
    return digest(body), digest(evaluation)


def prepare(draft_path, destination):
    draft_path, destination = Path(draft_path), Path(destination)
    require(not destination.exists(), "destination already exists")
    draft = read_json(draft_path)
    require(set(draft) == {"samples"}, "draft must contain only samples")
    validate_samples(draft["samples"], sealed=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".dataset-") as temporary:
        staging = Path(temporary) / "dataset"
        (staging / "audio").mkdir(parents=True)
        samples = []
        for sample in sorted(draft["samples"], key=lambda s: s["id"]):
            source = draft_path.parent / sample["audio"]
            target = staging / "audio" / (sample["id"] + ".wav")
            shutil.copyfile(source, target)
            samples.append(dict(sample, audio="audio/" + target.name, **audio_info(target)))
        validate_samples(samples, sealed=True)
        manifest = {"schemaVersion": 1, "metric": dict(METRIC), "preprocessing": dict(PREPROCESSING), "samples": samples}
        manifest["datasetDigest"], manifest["evaluationDigest"] = manifest_hashes(manifest)
        write_new(staging / "manifest.json", manifest)
        require(not destination.exists(), "destination already exists")
        staging.rename(destination)
    return manifest


def load_manifest(path):
    path = Path(path).resolve()
    manifest = read_json(path)
    require(set(manifest) == {"schemaVersion", "metric", "preprocessing", "samples", "datasetDigest", "evaluationDigest"},
            "invalid manifest fields")
    require(manifest["schemaVersion"] == 1 and manifest["metric"] == METRIC
            and manifest["preprocessing"] == PREPROCESSING, "unsupported schema/metric/preprocessing version")
    validate_samples(manifest["samples"], sealed=True)
    require(manifest["samples"] == sorted(manifest["samples"], key=lambda s: s["id"]), "samples must be sorted by ID")
    require(manifest_hashes(manifest) == (manifest["datasetDigest"], manifest["evaluationDigest"]), "manifest digest mismatch")
    for sample in manifest["samples"]:
        relative = Path(sample["audio"])
        audio = (path.parent / relative).resolve()
        require(not relative.is_absolute() and ".." not in relative.parts and audio.is_relative_to(path.parent),
                "audio must stay inside the dataset directory")
        require(audio_info(audio) == {key: sample[key] for key in AUDIO_FIELDS}, "audio changed: " + sample["id"])
    return manifest
