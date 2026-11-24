#!/usr/bin/env python3
"""Build the pinned Linux X11 app and a reproducible, weight-free tarball."""
import gzip
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
APP = "my-audio-to-text"
SOURCE = ROOT / "desktop"
TARGET = ROOT / "dist/desktop"
EXTENSION = (
    "app.css graph.css recorder.css graph.js graph-editor.js graph-palette.js graph-wire-router.js "
    "graph-draft-session.js graph-library.js subgraphs.js web-voice-graph.js translation-scheduler.js "
    "moonshine-small-ja-assets.json optional-asr-cache.js model-asset-cache.js icons/icon-32.png"
).split()
WEB = (
    "audio.js audio-stream.js button-node.js capture-worklet.js display-node.js hold-node.js if-condition-policy.js "
    "moonshine-small-ja-node.js moonshine-stream.js moonshine-worker.js number-node.js optional-asr-core.js "
    "optional-asr-node.js optional-model-assets.js paired-text.js pipeline.js port-contracts.js speaker-output.js "
    "synthesized-audio.js text-constant-node.js text-nodes.js text-summary-policy.js text-window-node.js "
    "transcription-nodes.js translation-nodes.js translation-models.js translategemma-languages.js translategemma-context.js plamo-policy.js third-party-notices.txt licenses/moonshine.txt licenses/moonshine-third-party.txt"
).split()


def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def archive(directory, destination):
    with destination.open("wb") as output, gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=6) as stream:
        with tarfile.open(mode="w|", fileobj=stream) as tar:
            def normalize(member):
                member.mtime = 0
                member.uid = member.gid = 0
                member.uname = member.gname = ""
                return member

            tar.add(directory, arcname=APP, filter=normalize)


def main():
    architectures = {"aarch64": "arm64", "x86_64": "x64"}
    if platform.system() != "Linux" or platform.machine() not in architectures:
        raise SystemExit("Build on Linux arm64 or x64. See docs/desktop.md for the container harness.")
    electron = SOURCE / "node_modules/electron"
    if not (electron / "package.json").is_file():
        raise SystemExit("Run npm ci --prefix desktop first.")
    # Electron's pinned npm package verifies its platform distribution.
    executable = Path(subprocess.check_output(
        ["node", "--input-type=module", "-e", "import electron from 'electron'; console.log(electron);"],
        cwd=SOURCE, text=True).strip())
    if not executable.is_file():
        raise SystemExit("Electron binary is missing. Run npm exec --prefix desktop -- electron --version on Linux.")
    subprocess.run(["python3", str(ROOT / "scripts/prepare-optional-asr-assets.py")], check=True)
    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(executable.parent, TARGET, symlinks=True)
    (TARGET / "electron").rename(TARGET / APP)
    resources = TARGET / "resources"
    (resources / "default_app.asar").unlink(missing_ok=True)
    app_root = resources / "app"
    for file in sorted(SOURCE.iterdir()):
        if file.is_file() and file.name not in {"package.json", "package-lock.json"}:
            copy(file, app_root / "desktop" / file.name)
    for source, names in (("extension", EXTENSION), ("web", WEB)):
        for name in names:
            copy(ROOT / source / name, app_root / source / name)
    runtime = json.loads((ROOT / "scripts/optional-asr-runtime.json").read_text())
    for entry in runtime["files"]:
        name = Path("web/vendor/optional-asr") / entry["path"]
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != entry["packagedSha256"]:
            raise SystemExit(f"Invalid packaged Moonshine runtime: {name}")
        copy(ROOT / name, app_root / name)
    (app_root / "package.json").write_text(json.dumps({
        "name": APP, "productName": "My Audio to Text", "version": "0.1.0",
        "type": "module", "main": "desktop/main.js",
    }, indent=2) + "\n")
    output = TARGET.with_name(f"{APP}-linux-{architectures[platform.machine()]}.tar.gz")
    archive(TARGET, output)
    print(f"Desktop app: {TARGET / APP}\nRelease archive: {output}")


if __name__ == "__main__":
    main()
