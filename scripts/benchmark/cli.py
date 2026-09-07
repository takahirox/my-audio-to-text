import argparse
from pathlib import Path
import sys
from .dataset import (BenchmarkError, METRIC, canonical, load_manifest, prepare,
                      read_json, require, write_new)
from .runner import learning_curve, run_baseline
from .scoring import compare, markdown, score, seal_run


def output_directory(path):
    directory = Path(path)
    directory.mkdir(parents=True, exist_ok=False)
    return directory


def curve_markdown(result):
    lines = ["# Contextual learning curve", "", "Primary raw baseline and Clean control are separate below.",
             "Training subsets are nested whole groups; all steps use the same evaluation digest.", "",
             "| System | Training seconds | Condition | CER | Errors / characters |",
             "|---|---:|---|---:|---:|"]
    entries = [("raw baseline", 0, result["rawBaseline"]), ("clean control", 0, result["cleanControl"])]
    entries += [("contextual groups=" + str(s["groups"]), s["trainingSeconds"], s["report"]) for s in result["steps"]]
    for name, duration, report in entries:
        if not report["complete"]:
            lines.append(f"| {name} | {duration:.3f} | INCOMPLETE | n/a | n/a |")
            continue
        for condition, metrics in [("all", report["overall"])] + list(report["byCondition"].items()):
            cer = "n/a" if metrics["CER"] is None else f'{100 * metrics["CER"]:.2f}%'
            lines.append(f'| {name} | {duration:.3f} | {condition} | {cer} | {metrics["errors"]} / {metrics["referenceCharacters"]} |')
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local real-audio benchmark (no uploads)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare", help="validate and import draft WAV samples into a new immutable dataset directory")
    p.add_argument("draft"); p.add_argument("destination")
    p = sub.add_parser("validate")
    p.add_argument("manifest")
    p = sub.add_parser("run", help="run the current Swift/whisper.cpp baseline without personalization")
    p.add_argument("manifest"); p.add_argument("config"); p.add_argument("output")
    p.add_argument("--bridge", default=".build/release/AudioBenchmarkBridge")
    p.add_argument("--hardware", required=True, help="machine/chip/RAM description for latency provenance")
    p.add_argument("--include-training", action="store_true")
    p.add_argument("--timeout", type=float, default=660)
    for command in ("score", "import-results"):
        p = sub.add_parser(command)
        p.add_argument("manifest"); p.add_argument("run"); p.add_argument("output")
        p.add_argument("--layer", choices=("raw", "clean", "text"), default="raw")
    p = sub.add_parser("template", help="write an unsealed external-adapter result template")
    p.add_argument("manifest"); p.add_argument("output")
    p = sub.add_parser("compare")
    p.add_argument("manifest"); p.add_argument("baseline"); p.add_argument("candidate"); p.add_argument("output")
    p.add_argument("--baseline-layer", default="raw", choices=("raw", "clean", "text"))
    p.add_argument("--candidate-layer", default="text", choices=("raw", "clean", "text"))
    p = sub.add_parser("curve")
    p.add_argument("manifest"); p.add_argument("baseline"); p.add_argument("output")
    p.add_argument("--groups", required=True, help="ascending whole-group counts, e.g. 0,1,2")
    p.add_argument("--bridge", default=".build/release/AudioBenchmarkBridge")
    p.add_argument("--timeout", type=float, default=660)
    args = parser.parse_args(argv)
    try:
        if hasattr(args, "timeout"):
            require(0 < args.timeout <= 3600, "timeout must be >0 and <=3600 seconds")
        if args.command == "prepare":
            manifest = prepare(args.draft, args.destination)
            print("Prepared dataset " + manifest["datasetDigest"])
            return 0
        manifest = load_manifest(args.manifest)
        if args.command == "validate":
            print("Validated dataset " + manifest["datasetDigest"])
            return 0
        if args.command == "template":
            template = {"schemaVersion": 1, "datasetDigest": manifest["datasetDigest"], "metric": METRIC,
                        "evaluationDigest": manifest["evaluationDigest"],
                        "system": {"id": "replace-system-name", "kind": "adapted", "backend": "replace-backend",
                                   "modelSHA256": "replace-model-hash", "backendSHA256": "replace-backend-hash",
                                   "evaluatorCommit": "replace-commit", "settings": {}, "hardware": {}, "trainingSampleIDs": []},
                        "predictions": [{"sampleID": s["id"], "status": "error", "errorType": "not_run"}
                                        for s in manifest["samples"] if s["split"] == "eval"]}
            write_new(args.output, template)
            return 0
        # Never spend ASR time before discovering that a result destination already exists.
        require(not Path(args.output).exists(), "output directory already exists")
        if args.command == "run":
            require(args.hardware.strip(), "hardware description cannot be empty")
            run = run_baseline(args.manifest, args.config, args.bridge, args.hardware, args.include_training, args.timeout)
            report = score(manifest, run, "raw")
            destination = output_directory(args.output)
            write_new(destination / "run.json", run)
            write_new(destination / "report.json", report)
            write_new(destination / "report.md", markdown(report).encode())
            write_new(destination / "clean-control.json", score(manifest, run, "clean"))
        elif args.command in ("score", "import-results"):
            run = read_json(args.run)
            if args.command == "import-results":
                require("runDigest" not in run, "import expects unsealed results; use score for sealed runs")
                run = seal_run(manifest, run)
            report = score(manifest, run, args.layer)
            destination = output_directory(args.output)
            write_new(destination / "run.json", run)
            write_new(destination / "report.json", report)
            write_new(destination / "report.md", markdown(report).encode())
        elif args.command == "compare":
            result = compare(manifest, read_json(args.baseline), read_json(args.candidate), args.baseline_layer, args.candidate_layer)
            destination = output_directory(args.output)
            write_new(destination / "comparison.json", result)
            summary = f'# Comparison\n\nImproved: {result["improvedSamples"]}; regressed: {result["regressedSamples"]}.\n\n'
            write_new(destination / "comparison.md", (summary + markdown(result["baseline"]) + "\n" + markdown(result["candidate"])).encode())
            return 0
        elif args.command == "curve":
            counts = [int(c) for c in args.groups.split(",")]
            result = learning_curve(manifest, read_json(args.baseline), args.bridge, counts, args.timeout)
            require(load_manifest(args.manifest) == manifest, "dataset changed during curve")
            destination = output_directory(args.output)
            write_new(destination / "curve.json", result)
            write_new(destination / "curve.md", curve_markdown(result).encode())
            for step in result["steps"]:
                write_new(destination / ("groups-" + str(step["groups"]) + ".json"), step["run"])
            return 0 if all(s["report"]["complete"] for s in result["steps"]) else 2
        return 0 if report["complete"] else 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Exceptions here concern paths/schema, never backend stderr or reference text.
        print("Benchmark error: " + str(error), file=sys.stderr)
        return 1
