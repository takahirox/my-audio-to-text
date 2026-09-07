"""Versioned CER scoring and exact-set comparison. Failures never improve a denominator."""
import math
from .dataset import CONDITIONS, METRIC, digest, normalize, require


def edit_counts(hypothesis, reference):
    hypothesis, reference = normalize(hypothesis), normalize(reference)
    # Each cell is (total, substitutions, deletions, insertions). Ties prefer diagonal,
    # then deletion, then insertion; decomposition is deterministic.
    previous = [(j, 0, j, 0) for j in range(len(reference) + 1)]
    for i, char in enumerate(hypothesis):
        current = [(i + 1, 0, 0, i + 1)]
        for j, expected in enumerate(reference):
            cost = int(char != expected)
            old = previous[j]
            diagonal = (old[0] + cost, old[1] + cost, old[2], old[3])
            old = current[j]
            deletion = (old[0] + 1, old[1], old[2] + 1, old[3])
            old = previous[j + 1]
            insertion = (old[0] + 1, old[1], old[2], old[3] + 1)
            current.append(min((diagonal, deletion, insertion), key=lambda cell: cell[0]))
        previous = current
    errors, substitutions, deletions, insertions = previous[-1]
    return dict(errors=errors, substitutions=substitutions, deletions=deletions,
                insertions=insertions, referenceCharacters=len(reference))


def run_digest(run):
    return digest({k: v for k, v in run.items() if k != "runDigest"})


def validate_run(manifest, run, sealed=True):
    require(isinstance(run, dict), "run must be an object")
    require(run.get("schemaVersion") == 1 and run.get("metric") == METRIC, "unsupported run/metric version")
    require(run.get("datasetDigest") == manifest["datasetDigest"]
            and run.get("evaluationDigest") == manifest["evaluationDigest"], "run/dataset digest mismatch")
    if sealed:
        require(run.get("runDigest") == run_digest(run), "run digest mismatch")
    system = run.get("system", {})
    require(isinstance(system, dict), "system must be an object")
    for field in ("id", "backend", "modelSHA256", "backendSHA256", "evaluatorCommit"):
        require(isinstance(system.get(field), str) and system[field], "missing system identity: " + field)
    for field in ("modelSHA256", "backendSHA256"):
        require(len(system[field]) == 64 and all(c in "0123456789abcdef" for c in system[field]), "invalid " + field)
    require(isinstance(system.get("settings"), dict) and isinstance(system.get("hardware"), dict), "missing system settings/hardware")
    train_ids = {s["id"] for s in manifest["samples"] if s["split"] == "train"}
    declared = system.get("trainingSampleIDs")
    require(isinstance(declared, list) and len(set(declared)) == len(declared)
            and set(declared) <= train_ids, "declared training samples overlap evaluation or are unknown")
    selected_groups = {s["groupID"] for s in manifest["samples"] if s["id"] in declared}
    require(set(declared) == {s["id"] for s in manifest["samples"] if s["split"] == "train" and s["groupID"] in selected_groups},
            "training selection splits a leakage group")
    require(system.get("kind") in ("baseline", "contextual", "adapted"), "invalid system kind")
    if system["kind"] == "baseline":
        require(not declared and system["settings"].get("textPersonalization") is False,
                "baseline must disable text personalization and use no adaptation samples")
    evaluation = {s["id"] for s in manifest["samples"] if s["split"] == "eval"}
    for key, expected, exact in (("predictions", evaluation, True), ("trainingPredictions", train_ids, False)):
        predictions = run.get(key, [])
        require(isinstance(predictions, list), "predictions must be a list")
        require(all(isinstance(p, dict) and isinstance(p.get("sampleID"), str) for p in predictions), "invalid prediction object")
        ids = [p.get("sampleID") for p in predictions]
        require(len(set(ids)) == len(ids), "duplicate prediction ID")
        require(set(ids) == expected if exact else set(ids) <= expected, "missing or unexpected prediction IDs")
        for prediction in predictions:
            require(prediction.get("status") in ("ok", "error"), "unknown prediction status")
            if prediction["status"] == "error":
                require(isinstance(prediction.get("errorType"), str) and prediction["errorType"], "failure needs errorType")
            else:
                require(any(isinstance(prediction.get(k), str) for k in ("raw", "clean", "text")), "successful prediction needs text")
            elapsed = prediction.get("elapsedSeconds")
            if elapsed is not None:
                require(isinstance(elapsed, (int, float)) and math.isfinite(elapsed) and elapsed >= 0, "invalid latency")


def seal_run(manifest, run):
    validate_run(manifest, run, sealed=False)
    run["runDigest"] = run_digest(run)
    return run


def aggregate(rows):
    result = {key: sum(row[key] for row in rows) for key in
              ("errors", "substitutions", "deletions", "insertions", "referenceCharacters")}
    result["samples"] = len(rows)
    result["CER"] = result["errors"] / result["referenceCharacters"] if result["referenceCharacters"] else None
    result["exactMatchRate"] = sum(r["errors"] == 0 for r in rows) / len(rows) if rows else None
    timed = [r for r in rows if r.get("elapsedSeconds") is not None]
    result["timedSamples"] = len(timed)
    result["realTimeFactor"] = (sum(r["elapsedSeconds"] for r in timed) / sum(r["durationSeconds"] for r in timed)) if timed else None
    return result


def score(manifest, run, layer="raw"):
    validate_run(manifest, run)
    predictions = {p["sampleID"]: p for p in run["predictions"]}
    rows, failures = [], []
    for sample in manifest["samples"]:
        if sample["split"] != "eval":
            continue
        prediction = predictions[sample["id"]]
        row = {key: sample[key] for key in ("id", "speakerID", "condition", "reference", "durationSeconds")}
        row["status"] = prediction["status"]
        if prediction["status"] == "error":
            row["errorType"] = prediction["errorType"]
            failures.append(sample["id"])
        else:
            require(isinstance(prediction.get(layer), str), "missing requested output layer: " + layer)
            row["hypothesis"] = prediction[layer]
            row.update(edit_counts(prediction[layer], sample["reference"]))
            row["elapsedSeconds"] = prediction.get("elapsedSeconds")
        rows.append(row)
    # Successful rows remain inspectable, but incomplete runs have no aggregate CER.
    complete = not failures
    return {"schemaVersion": 1, "datasetDigest": manifest["datasetDigest"],
            "evaluationDigest": manifest["evaluationDigest"], "runDigest": run["runDigest"],
            "metric": METRIC, "system": run["system"], "layer": layer, "complete": complete,
            "expectedSamples": len(rows), "failedSampleIDs": failures,
            "overall": aggregate(rows) if complete else None,
            "byCondition": {condition: aggregate([r for r in rows if r["condition"] == condition]) if complete else None
                            for condition in CONDITIONS},
            "bySpeaker": {speaker: aggregate([r for r in rows if r["speakerID"] == speaker]) if complete else None
                          for speaker in sorted({r["speakerID"] for r in rows})},
            "utterances": rows}


def markdown(report):
    lines = ["# Real-audio benchmark", "", "System: " + report["system"]["id"],
             "Layer: " + report["layer"], "Dataset: `" + report["datasetDigest"] + "`", "",
             "Metric: " + METRIC["id"], ""]
    if not report["complete"]:
        return "\n".join(lines + ["INCOMPLETE: no aggregate score. Failed sample IDs: " + ", ".join(report["failedSampleIDs"]), ""])
    lines += ["| Condition | Samples | Errors / reference characters | CER |", "|---|---:|---:|---:|"]
    for label, metrics in [("all", report["overall"])] + list(report["byCondition"].items()):
        cer = "n/a" if metrics["CER"] is None else f'{100 * metrics["CER"]:.2f}%'
        lines.append(f'| {label} | {metrics["samples"]} | {metrics["errors"]} / {metrics["referenceCharacters"]} | {cer} |')
    return "\n".join(lines) + "\n"


def compare(manifest, baseline, candidate, baseline_layer="raw", candidate_layer="text"):
    before, after = score(manifest, baseline, baseline_layer), score(manifest, candidate, candidate_layer)
    require(before["complete"] and after["complete"], "cannot compare incomplete runs")
    deltas = [{"id": a["id"], "baselineErrors": a["errors"], "candidateErrors": b["errors"],
               "delta": b["errors"] - a["errors"]} for a, b in zip(before["utterances"], after["utterances"])]
    errors = before["overall"]["errors"]
    return {"baseline": before, "candidate": after, "utterances": deltas,
            "regressedSamples": sum(r["delta"] > 0 for r in deltas),
            "improvedSamples": sum(r["delta"] < 0 for r in deltas),
            "relativeErrorReduction": (errors - after["overall"]["errors"]) / errors if errors else None}
