import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from benchmark.dataset import (BenchmarkError, audio_info, load_manifest, manifest_hashes, prepare,
                               read_json, validate_samples, write_new)
from fixtures import make_fixture


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.draft, _ = make_fixture(self.root / "source")
        self.path = self.root / "dataset" / "manifest.json"

    def build(self):
        return prepare(self.draft, self.path.parent)

    def edit_draft(self, edit):
        draft = read_json(self.draft)
        edit(draft["samples"])
        self.draft.write_text(json.dumps(draft), encoding="utf-8")

    def test_import_validate_and_moving_dataset_preserve_digests(self):
        manifest = self.build()
        self.assertEqual(load_manifest(self.path), manifest)
        moved = self.root / "moved"
        self.path.parent.rename(moved)
        self.assertEqual(load_manifest(moved / "manifest.json"), manifest)
        self.assertEqual(manifest["samples"][0]["durationSeconds"], 0.1)

    def test_references_splits_and_preprocessing_are_hashed(self):
        original = self.build()
        for key, replacement in [("reference", "changed"), ("split", "train"), ("condition", "unknown")]:
            changed = copy.deepcopy(original)
            changed["samples"][0][key] = replacement
            self.assertNotEqual(manifest_hashes(changed), manifest_hashes(original))
        changed = copy.deepcopy(original)
        changed["preprocessing"]["sampleRate"] = 8000
        self.assertNotEqual(manifest_hashes(changed), manifest_hashes(original))

    def test_modified_audio_is_rejected(self):
        manifest = self.build()
        audio = self.path.parent / manifest["samples"][0]["audio"]
        data = bytearray(audio.read_bytes()); data[-1] ^= 1; audio.write_bytes(data)
        with self.assertRaises(BenchmarkError): load_manifest(self.path)

    def test_modified_reference_and_unknown_metric_are_rejected(self):
        manifest = self.build()
        manifest["samples"][0]["reference"] += "changed"
        self.path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(BenchmarkError): load_manifest(self.path)
        manifest["metric"]["id"] = "another-metric"
        with self.assertRaises(BenchmarkError): load_manifest(self.path)

    def test_duplicate_ids_rejected(self):
        self.edit_draft(lambda samples: samples.append(samples[0]))
        with self.assertRaises(BenchmarkError): self.build()

    def test_session_prompt_reference_and_group_leakage_rejected(self):
        original = read_json(self.draft)["samples"]
        for key in ("sessionID", "promptID", "reference", "groupID"):
            samples = copy.deepcopy(original)
            samples[2][key] = samples[0][key]
            with self.subTest(key=key), self.assertRaises(BenchmarkError):
                validate_samples(samples, False)

    def test_pcm_duplicate_with_different_wav_header_is_detected(self):
        # Different filenames/header bytes cannot hide identical audio across splits.
        source = self.root / "source"
        data = (source / "t1.wav").read_bytes()
        (source / "e1.wav").write_bytes(data + b"different trailing metadata")
        self.assertNotEqual(audio_info(source / "t1.wav")["audioSHA256"], audio_info(source / "e1.wav")["audioSHA256"])
        self.assertEqual(audio_info(source / "t1.wav")["pcmSHA256"], audio_info(source / "e1.wav")["pcmSHA256"])
        with self.assertRaises(BenchmarkError): self.build()

    def test_wrong_format_and_truncated_wav_rejected(self):
        audio = self.root / "source" / "t1.wav"
        original = audio.read_bytes()
        audio.write_bytes(original[:-2])
        with self.assertRaises(BenchmarkError): audio_info(audio)
        with wave.open(str(audio), "wb") as stream:
            stream.setparams((2, 2, 8000, 0, "NONE", "not compressed")); stream.writeframes(b"\0" * 16)
        with self.assertRaises(BenchmarkError): audio_info(audio)

    def test_duplicate_pcm_within_one_group_is_rejected(self):
        source = self.root / "source"
        (source / "e3.wav").write_bytes((source / "e2.wav").read_bytes())
        with self.assertRaises(BenchmarkError): self.build()

    def test_absolute_paths_in_sealed_manifests_rejected(self):
        manifest = self.build()
        manifest["samples"][0]["audio"] = str(self.root / "source" / "e1.wav")
        manifest["datasetDigest"], manifest["evaluationDigest"] = manifest_hashes(manifest)
        self.path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(BenchmarkError): load_manifest(self.path)

    def test_outputs_and_datasets_never_overwrite_existing_files(self):
        original = self.build()
        with self.assertRaises(BenchmarkError): self.build()
        with self.assertRaises(FileExistsError): write_new(self.path, {})
        self.assertEqual(load_manifest(self.path), original)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for text in ('{"samples": [], "samples": []}', '{"samples": NaN}'):
            self.draft.write_text(text, encoding="utf-8")
            with self.assertRaises(BenchmarkError): read_json(self.draft)
