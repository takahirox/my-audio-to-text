"""ASR execution and isolated contextual learning curves over immutable audio manifests."""
import copy
from datetime import datetime, timezone
import platform
import math
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from .dataset import (BenchmarkError, METRIC, canonical, digest, file_hash, load_manifest,
                      read_json, require, write_new)
from .scoring import seal_run, score, validate_run

ROOT = Path(__file__).resolve().parents[2]


def source_identity():
    result = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True)
    files = sorted((ROOT / "scripts" / "benchmark").glob("*.py"))
    files += sorted((ROOT / "Sources" / "AudioTextCore").glob("*.swift"))
    files += sorted((ROOT / "Sources" / "AudioBenchmarkBridge").glob("*.swift"))
    return {"evaluatorCommit": result.stdout.strip() if result.returncode == 0 else "unavailable",
            "evaluatorSourcesSHA256": digest([(str(p.relative_to(ROOT)), file_hash(p)) for p in files])}


def session_uuid(sample):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "audio-benchmark/session/" + sample["speakerID"] + "/" + sample["sessionID"])).upper()


def validate_segments(sample, segments):
    require(isinstance(segments, list), "ASR segments must be a list")
    ids = set()
    for index, segment in enumerate(segments):
        require(isinstance(segment, dict) and isinstance(segment.get("id"), str), "invalid ASR segment")
        require(segment["id"] not in ids, "duplicate ASR segment")
        uuid.UUID(segment["id"])
        ids.add(segment["id"])
        require(segment.get("sessionID") == session_uuid(sample) and segment.get("ordinal") == index
                and segment.get("status") == "FINAL" and segment.get("speaker") == "USER", "invalid ASR segment identity")
        require(all(isinstance(segment.get(k), str) and len(segment[k]) <= 10000 for k in ("rawText", "cleanText")), "invalid ASR text")
        start, end = segment.get("startMilliseconds"), segment.get("endMilliseconds")
        require(isinstance(start, int) and isinstance(end, int) and 0 <= start <= end, "invalid ASR offsets")
        confidence = segment.get("confidence")
        if confidence is not None:
            require(isinstance(confidence, (int, float)) and math.isfinite(confidence) and 0 <= confidence <= 1,
                    "invalid ASR confidence")
    require(sum(len(s["rawText"]) for s in segments) <= 10000, "oversized ASR output")


def recognize(bridge, config_path, audio_path, sample, timeout):
    started = time.monotonic()
    try:
        result = subprocess.run([str(bridge), "transcribe", str(config_path), str(audio_path), session_uuid(sample)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=True)
        import json
        segments = json.loads(result.stdout)
        validate_segments(sample, segments)
        return {"sampleID": sample["id"], "status": "ok", "segments": segments,
                "raw": "\n".join(s["rawText"] for s in segments),
                "clean": "\n".join(s["cleanText"] for s in segments if s["cleanText"]),
                "elapsedSeconds": time.monotonic() - started}
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError) as error:
        return {"sampleID": sample["id"], "status": "error", "errorType": type(error).__name__,
                "elapsedSeconds": time.monotonic() - started}


def run_baseline(manifest_path, config_path, bridge, hardware, include_training=False, timeout=660):
    manifest_path, config_path, bridge = map(lambda p: Path(p).resolve(), (manifest_path, config_path, bridge))
    manifest = load_manifest(manifest_path)
    config = read_json(config_path)
    require(isinstance(config.get("language"), str) and config["language"].strip(), "language must be explicit")
    model, backend = Path(config["whisperModel"]).resolve(), Path(config["whisperExecutable"]).resolve()
    # This ephemeral config is isolated from later edits of the application's settings.
    config.update(whisperModel=str(model), whisperExecutable=str(backend), personalization=False)
    identities = {str(path): file_hash(path) for path in (model, backend, bridge)}
    system = {"id": "whisper.cpp-raw", "kind": "baseline", "backend": "whisper.cpp",
              "modelName": model.name, "modelSHA256": identities[str(model)],
              "backendSHA256": identities[str(backend)], "bridgeSHA256": identities[str(bridge)],
              "settings": {"language": config["language"], "textPersonalization": False,
                           "decodeArguments": ["-m", "<model>", "-f", "<audio>", "-l", config["language"],
                                               "-ojf", "-of", "<temporary>", "-np", "--suppress-nst"],
                           "otherDecoderSettings": "backend build defaults", "timeoutSeconds": timeout,
                           "unit": "whole utterance, fresh whisper-cli process"},
              "hardware": {"label": hardware, "architecture": platform.machine(), "os": platform.platform(),
                           "python": platform.python_version()},
              "trainingSampleIDs": [], **source_identity()}
    predictions, training = [], []
    with tempfile.TemporaryDirectory(prefix="audio-benchmark-") as directory:
        snapshot = Path(directory) / "config.json"
        write_new(snapshot, config)
        for sample in manifest["samples"]:
            if sample["split"] == "train" and not include_training:
                continue
            prediction = recognize(bridge, snapshot, manifest_path.parent / sample["audio"], sample, timeout)
            (training if sample["split"] == "train" else predictions).append(prediction)
    require(load_manifest(manifest_path) == manifest, "dataset changed during recognition")
    require(all(file_hash(path) == h for path, h in identities.items()), "model/backend/bridge changed during recognition")
    return seal_run(manifest, {"schemaVersion": 1, "datasetDigest": manifest["datasetDigest"],
                              "evaluationDigest": manifest["evaluationDigest"], "metric": METRIC,
                              "createdAt": datetime.now(timezone.utc).isoformat(), "system": system,
                              "predictions": predictions, "trainingPredictions": training})


def group_subsets(manifest, counts):
    groups = sorted({s["groupID"] for s in manifest["samples"] if s["split"] == "train"})
    require(counts == sorted(set(counts)) and counts and counts[0] == 0
            and all(isinstance(c, int) and 0 <= c <= len(groups) for c in counts), "curve counts must be unique ascending group counts starting at 0")
    return [[s for s in manifest["samples"] if s["split"] == "train" and s["groupID"] in groups[:count]] for count in counts]


def feedback(sample, prediction):
    validate_segments(sample, prediction.get("segments"))
    require(prediction["raw"] == "\n".join(s["rawText"] for s in prediction["segments"])
            and prediction["clean"] == "\n".join(s["cleanText"] for s in prediction["segments"] if s["cleanText"]), "cached segments/text disagree")
    return {"schemaVersion": 1, "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "audio-benchmark/feedback/" + sample["id"])),
            "sessionID": session_uuid(sample), "createdAt": "1970-01-01T00:00:00Z",
            "rawTranscript": prediction["raw"], "cleanTranscript": prediction["clean"],
            "correctedTranscript": sample["reference"], "speechCondition": sample["condition"],
            "sourceSegments": copy.deepcopy(prediction["segments"])}


def learning_curve(manifest, baseline, bridge, counts, timeout=660):
    validate_run(manifest, baseline)
    require(baseline["system"]["kind"] == "baseline", "curve requires a raw baseline run")
    require(score(manifest, baseline, "raw")["complete"], "curve requires complete evaluation predictions")
    subsets = group_subsets(manifest, counts)
    training = {p["sampleID"]: p for p in baseline.get("trainingPredictions", [])}
    require(all(s["id"] in training and training[s["id"]]["status"] == "ok" for s in subsets[-1]),
            "selected training recognition is missing or failed; rerun with --include-training")
    evaluation = [s for s in manifest["samples"] if s["split"] == "eval"]
    predictions = {p["sampleID"]: p for p in baseline["predictions"]}
    for sample in evaluation:
        # Validate cached segments, but never pass the reference into the recognizer/memory request.
        validate_segments(sample, predictions[sample["id"]].get("segments"))
        require(predictions[sample["id"]]["clean"] == "\n".join(s["cleanText"] for s in predictions[sample["id"]]["segments"] if s["cleanText"]), "cached evaluation segments/text disagree")
    bridge = Path(bridge).resolve()
    bridge_hash = file_hash(bridge)
    steps = []
    for count, subset in zip(counts, subsets):
        output, audits = [], {}
        for speaker in sorted({s["speakerID"] for s in evaluation}):
            speaker_eval = [s for s in evaluation if s["speakerID"] == speaker]
            segments = [segment for s in speaker_eval for segment in predictions[s["id"]]["segments"]]
            request = {"training": [feedback(s, training[s["id"]]) for s in subset if s["speakerID"] == speaker], "segments": segments}
            # Appends from the same source session must all count as one session vote. The
            # current memory keeps latest session revision; avoid losing earlier utterances
            # by combining aligned segments/references into one feedback record per session.
            combined = {}
            for item in request["training"]:
                previous = combined.get(item["sessionID"])
                if previous:
                    for key in ("rawTranscript", "cleanTranscript", "correctedTranscript"):
                        previous[key] += "\n" + item[key]
                    previous["sourceSegments"] += item["sourceSegments"]
                    if previous["speechCondition"] != item["speechCondition"]:
                        previous["speechCondition"] = "unknown"
                else:
                    combined[item["sessionID"]] = item
            request["training"] = list(combined.values())
            started = time.monotonic()
            try:
                with tempfile.TemporaryDirectory(prefix="audio-memory-") as directory:
                    path = Path(directory) / "request.json"
                    write_new(path, request)
                    result = subprocess.run([str(bridge), "personalize", str(path)], capture_output=True, timeout=timeout, check=True)
                    import json
                    response = json.loads(result.stdout)
                returned = response["segments"]
                require(len(returned) == len(segments) and len({s["segmentID"] for s in returned}) == len(returned), "memory response segment mismatch")
                by_id = {s["segmentID"]: s for s in returned}
                require(set(by_id) == {s["id"] for s in segments}, "memory response segment IDs mismatch")
                for segment in segments:
                    require(by_id[segment["id"]]["baseline"] == segment["cleanText"] and isinstance(by_id[segment["id"]]["text"], str), "memory response baseline mismatch")
                audits[speaker] = {"memoryDigest": response["memoryDigest"], "ruleCount": response["ruleCount"],
                                  "elapsedSeconds": time.monotonic() - started, "segments": returned}
                for sample in speaker_eval:
                    text = "\n".join(by_id[s["id"]]["text"] for s in predictions[sample["id"]]["segments"] if by_id[s["id"]]["text"])
                    output.append({"sampleID": sample["id"], "status": "ok", "text": text})
            except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError) as error:
                output.extend({"sampleID": s["id"], "status": "error", "errorType": type(error).__name__} for s in speaker_eval)
        system = copy.deepcopy(baseline["system"])
        system.update(id="contextual-groups-" + str(count), kind="contextual", trainingSampleIDs=[s["id"] for s in subset],
                      personalizerSHA256=bridge_hash, **source_identity())
        system["settings"]["textPersonalization"] = True
        candidate = seal_run(manifest, {"schemaVersion": 1, "datasetDigest": manifest["datasetDigest"],
                              "evaluationDigest": manifest["evaluationDigest"], "metric": METRIC,
                              "system": system, "parentRunDigest": baseline["runDigest"],
                              "predictions": output, "memoryAudits": audits})
        duration = {speaker: sum(s["durationSeconds"] for s in subset if s["speakerID"] == speaker)
                    for speaker in sorted({s["speakerID"] for s in manifest["samples"]})}
        steps.append({"groups": count, "trainingSecondsBySpeaker": duration,
                      "trainingSeconds": sum(duration.values()), "run": candidate, "report": score(manifest, candidate, "text")})
    require(file_hash(bridge) == bridge_hash, "personalizer changed during curve execution")
    return {"schemaVersion": 1, "datasetDigest": manifest["datasetDigest"], "evaluationDigest": manifest["evaluationDigest"],
            "rawBaseline": score(manifest, baseline, "raw"), "cleanControl": score(manifest, baseline, "clean"), "steps": steps}
