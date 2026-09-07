import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from benchmark.dataset import BenchmarkError, prepare, read_json
from benchmark.runner import learning_curve, recognize, run_baseline, session_uuid
from benchmark.scoring import score
from fixtures import make_fixture

BRIDGE = ROOT / ".build" / "release" / "AudioBenchmarkBridge"
CLI = ROOT / "scripts" / "audio-benchmark.py"


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.draft, self.config = make_fixture(self.root / "source")
        self.manifest_path = self.root / "dataset" / "manifest.json"
        self.manifest = prepare(self.draft, self.manifest_path.parent)
        self.assertTrue(BRIDGE.exists(), "build AudioBenchmarkBridge before integration tests")

    def run_fixture(self):
        return run_baseline(self.manifest_path, self.config, BRIDGE, "synthetic fixture; no acoustic quality claim", True)

    def test_real_swift_bridge_and_fake_asr_support_fixed_learning_curve(self):
        run = self.run_fixture()
        report = score(self.manifest, run)
        self.assertTrue(report["complete"])
        self.assertGreater(report["overall"]["errors"], 0)
        self.assertFalse(run["system"]["settings"]["textPersonalization"])
        self.assertEqual(run["system"]["trainingSampleIDs"], [])
        self.assertEqual(len(run["trainingPredictions"]), 2)
        curve = learning_curve(self.manifest, run, BRIDGE, [0, 1, 2])
        steps = curve["steps"]
        self.assertEqual([step["trainingSeconds"] for step in steps], [0, 0.1, 0.2])
        self.assertEqual(steps[0]["report"]["overall"]["errors"], curve["cleanControl"]["overall"]["errors"])
        self.assertEqual(steps[1]["report"]["overall"]["errors"], steps[0]["report"]["overall"]["errors"])
        self.assertEqual(steps[2]["report"]["overall"]["errors"], 0)
        self.assertTrue(all(step["report"]["evaluationDigest"] == self.manifest["evaluationDigest"] for step in steps))
        self.assertEqual(steps[2]["run"]["system"]["trainingSampleIDs"], ["t1", "t2"])
        self.assertEqual(steps[2]["run"]["memoryAudits"]["speaker1"]["ruleCount"], 1)

    def test_same_session_utterances_do_not_inflate_independent_support(self):
        draft = read_json(self.draft)
        draft["samples"][1].update(sessionID="session-t1", groupID="g1")
        self.draft.write_text(json.dumps(draft), encoding="utf-8")
        path = self.root / "one-session" / "manifest.json"
        manifest = prepare(self.draft, path.parent)
        run = run_baseline(path, self.config, BRIDGE, "fixture", True)
        original = copy.deepcopy(run)
        curve = learning_curve(manifest, run, BRIDGE, [0, 1])
        self.assertEqual(run, original)
        self.assertEqual(curve["steps"][1]["run"]["memoryAudits"]["speaker1"]["ruleCount"], 0)
        from benchmark.scoring import seal_run
        candidate = copy.deepcopy(run)
        candidate["system"].update(kind="adapted", trainingSampleIDs=["t1"])
        with self.assertRaises(BenchmarkError): seal_run(manifest, candidate)

    def test_memory_never_crosses_speakers(self):
        draft = read_json(self.draft)
        for sample in draft["samples"]:
            if sample["split"] == "eval": sample["speakerID"] = "speaker2"
        self.draft.write_text(json.dumps(draft), encoding="utf-8")
        path = self.root / "two-speakers" / "manifest.json"
        manifest = prepare(self.draft, path.parent)
        run = run_baseline(path, self.config, BRIDGE, "fixture", True)
        curve = learning_curve(manifest, run, BRIDGE, [0, 1, 2])
        self.assertEqual(curve["steps"][2]["run"]["memoryAudits"]["speaker2"]["ruleCount"], 0)
        self.assertGreater(curve["steps"][2]["report"]["overall"]["errors"], 0)
        self.assertEqual(curve["steps"][2]["trainingSecondsBySpeaker"], {"speaker1": 0.2, "speaker2": 0})

    def test_missing_training_run_and_unknown_group_counts_fail(self):
        run = self.run_fixture()
        run["trainingPredictions"] = []
        from benchmark.scoring import seal_run
        seal_run(self.manifest, run)
        with self.assertRaises(BenchmarkError): learning_curve(self.manifest, run, BRIDGE, [0, 1])

    def test_timeouts_malformed_output_and_nonzero_exit_are_failed_not_empty(self):
        sample = self.manifest["samples"][0]
        for mode, content in [("timeout", "import time; time.sleep(2)"), ("malformed", "print('not JSON')"), ("exit", "raise SystemExit(1)")]:
            bridge = self.root / (mode + ".py")
            bridge.write_text("#!" + sys.executable + "\n" + content + "\n", encoding="utf-8"); bridge.chmod(0o700)
            prediction = recognize(bridge, self.config, self.manifest_path.parent / sample["audio"], sample, 0.05 if mode == "timeout" else 3)
            self.assertEqual(prediction["status"], "error")
            self.assertNotIn("raw", prediction)

    def test_bridge_rejects_training_eval_session_overlap(self):
        run = self.run_fixture()
        from benchmark.runner import feedback
        train_sample = next(s for s in self.manifest["samples"] if s["id"] == "t1")
        train_prediction = next(p for p in run["trainingPredictions"] if p["sampleID"] == "t1")
        request = {"training": [feedback(train_sample, train_prediction)], "segments": train_prediction["segments"]}
        path = self.root / "leak.json"; path.write_text(json.dumps(request), encoding="utf-8")
        result = subprocess.run([str(BRIDGE), "personalize", str(path)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_cli_run_curve_import_compare_and_no_overwrite(self):
        def cli(*args):
            return subprocess.run([sys.executable, str(CLI), *map(str, args)], capture_output=True, text=True)
        baseline = self.root / "baseline"
        result = cli("run", self.manifest_path, self.config, baseline, "--bridge", BRIDGE, "--hardware", "fixture", "--include-training")
        self.assertEqual(result.returncode, 0, result.stderr)
        curve = self.root / "curve"
        result = cli("curve", self.manifest_path, baseline / "run.json", curve, "--bridge", BRIDGE, "--groups", "0,1,2")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = cli("compare", self.manifest_path, baseline / "run.json", curve / "groups-2.json", self.root / "comparison")
        self.assertEqual(result.returncode, 0, result.stderr)
        candidate = read_json(curve / "groups-2.json"); del candidate["runDigest"]
        candidate["system"]["kind"] = "adapted"
        path = self.root / "external.json"; path.write_text(json.dumps(candidate), encoding="utf-8")
        result = cli("import-results", self.manifest_path, path, self.root / "imported", "--layer", "text")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = cli("score", self.manifest_path, baseline / "run.json", baseline)
        self.assertEqual(result.returncode, 1)
        self.assertTrue((curve / "curve.md").exists())

    def test_failed_cli_run_writes_incomplete_report_and_exits_two(self):
        config = read_json(self.config)
        backend = Path(config["whisperExecutable"])
        backend.write_text("#!" + sys.executable + "\nraise SystemExit(1)\n", encoding="utf-8")
        output = self.root / "failed"
        result = subprocess.run([sys.executable, str(CLI), "run", str(self.manifest_path), str(self.config), str(output),
                                 "--bridge", str(BRIDGE), "--hardware", "fixture"], capture_output=True)
        self.assertEqual(result.returncode, 2)
        report = read_json(output / "report.json")
        self.assertFalse(report["complete"])
        self.assertIsNone(report["overall"])
        self.assertEqual(len(report["failedSampleIDs"]), 4)
