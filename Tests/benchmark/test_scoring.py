import copy
from pathlib import Path
import sys
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from benchmark.dataset import BenchmarkError, METRIC, prepare
from benchmark.scoring import compare, edit_counts, score, seal_run, validate_run
from benchmark.runner import group_subsets
from fixtures import make_fixture


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        draft, _ = make_fixture(self.root / "source")
        self.manifest = prepare(draft, self.root / "dataset")
        self.run = seal_run(self.manifest, dict(schemaVersion=1, metric=METRIC,
            datasetDigest=self.manifest["datasetDigest"], evaluationDigest=self.manifest["evaluationDigest"],
            system=dict(id="fixture", kind="baseline", backend="fake", modelSHA256="a"*64, backendSHA256="b"*64,
                        evaluatorCommit="fixture", settings={"textPersonalization": False}, hardware={}, trainingSampleIDs=[]),
            predictions=[dict(sampleID=s["id"], status="ok", raw=s["reference"], clean=s["reference"], elapsedSeconds=0.01)
                         for s in self.manifest["samples"] if s["split"] == "eval"]))

    def test_cer_edits_normalization_and_zero_denominator(self):
        self.assertEqual(edit_counts("ＧＰＴ Sol。", "gpt sol")["errors"], 0)
        self.assertEqual(edit_counts("カ\u3099", "ガ")["errors"], 0)
        self.assertEqual(edit_counts("", "音声")["deletions"], 2)
        self.assertEqual(edit_counts("音声", "")["insertions"], 2)
        self.assertEqual(edit_counts("京都", "今日と")["errors"], 3)
        self.assertEqual(edit_counts("ABX", "ABC")["substitutions"], 1)

    def test_complete_aggregate_condition_and_per_utterance_metrics(self):
        report = score(self.manifest, self.run)
        self.assertTrue(report["complete"])
        self.assertEqual(report["overall"]["CER"], 0)
        self.assertEqual(report["overall"]["exactMatchRate"], 1)
        self.assertEqual(report["byCondition"]["normal"]["samples"], 2)
        self.assertIsNone(report["byCondition"]["unknown"]["CER"])
        self.assertAlmostEqual(report["overall"]["realTimeFactor"], 0.1)
        self.assertEqual(len(report["utterances"]), 4)

    def test_missing_duplicate_and_unexpected_predictions_rejected(self):
        for mode in ("missing", "duplicate", "unexpected"):
            run = copy.deepcopy(self.run)
            if mode == "missing": run["predictions"].pop()
            if mode == "duplicate": run["predictions"].append(run["predictions"][0])
            if mode == "unexpected": run["predictions"][0]["sampleID"] = "other"
            with self.subTest(mode=mode), self.assertRaises(BenchmarkError): seal_run(self.manifest, run)

    def test_failure_makes_run_incomplete_but_empty_success_is_scored(self):
        run = copy.deepcopy(self.run)
        run["predictions"][0] = dict(sampleID="e1", status="error", errorType="TimeoutExpired")
        seal_run(self.manifest, run)
        report = score(self.manifest, run)
        self.assertFalse(report["complete"])
        self.assertIsNone(report["overall"])
        self.assertEqual(report["failedSampleIDs"], ["e1"])
        with self.assertRaises(BenchmarkError): compare(self.manifest, self.run, run, "raw", "raw")
        run["predictions"][0] = dict(sampleID="e1", status="ok", raw="")
        seal_run(self.manifest, run)
        report = score(self.manifest, run)
        self.assertTrue(report["complete"])
        self.assertGreater(report["overall"]["deletions"], 0)
        self.assertEqual(report["expectedSamples"], 4)

    def test_baseline_clean_and_candidate_layers_do_not_fall_back(self):
        run = copy.deepcopy(self.run)
        for p in run["predictions"]: p["clean"] = ""
        seal_run(self.manifest, run)
        self.assertEqual(score(self.manifest, run, "raw")["overall"]["errors"], 0)
        self.assertGreater(score(self.manifest, run, "clean")["overall"]["errors"], 0)
        with self.assertRaises(BenchmarkError): score(self.manifest, run, "text")

    def test_tampered_runs_incompatible_datasets_and_training_leakage_rejected(self):
        run = copy.deepcopy(self.run); run["predictions"][0]["raw"] = "tampered"
        with self.assertRaises(BenchmarkError): validate_run(self.manifest, run)
        run = copy.deepcopy(self.run); run["datasetDigest"] = "different"
        with self.assertRaises(BenchmarkError): seal_run(self.manifest, run)
        run = copy.deepcopy(self.run); run["system"]["kind"] = "adapted"
        run["system"]["trainingSampleIDs"] = ["e1"]
        with self.assertRaises(BenchmarkError): seal_run(self.manifest, run)

    def test_comparison_inspects_regressions(self):
        run = copy.deepcopy(self.run)
        for p in run["predictions"]: p["text"] = ""
        seal_run(self.manifest, run)
        comparison = compare(self.manifest, self.run, run)
        self.assertEqual(comparison["regressedSamples"], 4)
        self.assertEqual(comparison["improvedSamples"], 0)
        self.assertIsNone(comparison["relativeErrorReduction"])

    def test_nested_whole_group_subsets(self):
        subsets = group_subsets(self.manifest, [0, 1, 2])
        self.assertEqual([len(s) for s in subsets], [0, 1, 2])
        self.assertTrue(set(s["id"] for s in subsets[1]) <= set(s["id"] for s in subsets[2]))
        for counts in ([1], [0, 2, 1], [0, 0], [0, 3]):
            with self.assertRaises(BenchmarkError): group_subsets(self.manifest, counts)
