#!/usr/bin/env python3
"""Build the pinned desktop app and a reproducible, weight-free tarball."""
import gzip
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tarfile

from graph_assets import copy_graph_resources, inventory

ROOT = Path(__file__).resolve().parents[1]
APP = "my-audio-to-text"
SOURCE = ROOT / "desktop"
TARGET = ROOT / "dist/desktop"
EXTENSION = (
    "app.css graph.css recorder.css models.css graph.js graph-editor.js graph-palette.js graph-wire-router.js "
    "graph-draft-session.js graph-library.js subgraphs.js web-voice-graph.js graph-runtime.js graph-actions.js "
    "graph-model-preparation.js translation-scheduler.js model-definitions.js model-order.js "
    "tab-source.js tab-audio-node.js tab-capture-source.js media-source.js page-output-node.js page-target.js "
    "model-asset-cache.js icons/icon-32.png"
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

            tar.add(directory, arcname=directory.name if directory.suffix == ".app" else APP, filter=normalize)


def mac_bundle(executable):
    bundle = TARGET / "My Audio to Text.app"
    contents = bundle / "Contents"
    shutil.copytree(executable.parents[2], bundle, symlinks=True)
    executable = contents / "MacOS" / executable.name
    binary = executable.with_name(APP)
    executable.rename(binary)
    plist = contents / "Info.plist"
    info = plistlib.loads(plist.read_bytes())
    info.update(
        CFBundleExecutable=APP,
        CFBundleIdentifier="com.takahirox.my-audio-to-text",
        CFBundleName="My Audio to Text",
        CFBundleDisplayName="My Audio to Text",
        CFBundleShortVersionString="0.1.0",
        CFBundleVersion="0.1.0",
        LSUIElement=True,
        NSMicrophoneUsageDescription="Capture audio for the selected local processing graph when you start a session.",
    )
    plist.write_bytes(plistlib.dumps(info))
    helper = contents / "MacOS" / "focused-text"
    subprocess.run([
        "xcrun", "clang", "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror",
        "-mmacosx-version-min=13.0", "-framework", "AppKit",
        "-framework", "ApplicationServices", "-framework", "Carbon",
        "desktop/mac-target.m", "-o", str(helper),
    ], cwd=ROOT, check=True)
    return bundle, binary, contents / "Resources"


def main():
    architectures = {"aarch64": "arm64", "x86_64": "x64"}
    system = platform.system()
    if system == "Darwin" and platform.machine() == "arm64":
        target_name = "macos-arm64"
    elif system == "Linux" and platform.machine() in architectures:
        target_name = f"linux-{architectures[platform.machine()]}"
    else:
        raise SystemExit("Build on Apple Silicon macOS or Linux arm64/x64. See docs/desktop.md.")
    electron = SOURCE / "node_modules/electron"
    if not (electron / "package.json").is_file():
        raise SystemExit("Run npm ci --prefix desktop first.")
    # Electron's pinned npm package verifies its platform distribution.
    executable = Path(subprocess.check_output(
        ["node", "--input-type=module", "-e", "import electron from 'electron'; console.log(electron);"],
        cwd=SOURCE, text=True).strip())
    if not executable.is_file():
        raise SystemExit("Electron binary is missing. Run npm exec --prefix desktop -- install-electron.")
    subprocess.run(["npm", "run", "prepare:graph-assets"], cwd=ROOT, check=True)
    if TARGET.exists():
        shutil.rmtree(TARGET)
    if system == "Darwin":
        bundle, binary, resources = mac_bundle(executable)
    else:
        bundle = TARGET
        shutil.copytree(executable.parent, bundle, symlinks=True)
        binary = bundle / APP
        (bundle / "electron").rename(binary)
        resources = bundle / "resources"
    (resources / "default_app.asar").unlink(missing_ok=True)
    app_root = resources / "app"
    for file in sorted(SOURCE.iterdir()):
        if (file.is_file() and file.name not in {"package.json", "package-lock.json", "mac-target.m"}
                and not (system == "Darwin" and file.suffix == ".py")):
            copy(file, app_root / "desktop" / file.name)
    copy_graph_resources(app_root)
    for name in EXTENSION:
        copy(ROOT / "extension" / name, app_root / "extension" / name)
    for pattern in ("*-assets.json", "*-cache.js"):
        for file in sorted((ROOT / "extension").glob(pattern)):
            copy(file, app_root / "extension" / file.name)
    model_sources = subprocess.check_output(["node", "scripts/desktop-model-sources.mjs"], cwd=ROOT)
    (app_root / "desktop/model-sources.json").write_bytes(model_sources)
    inventory(app_root)
    (app_root / "package.json").write_text(json.dumps({
        "name": APP, "productName": "My Audio to Text", "version": "0.1.0",
        "type": "module", "main": "desktop/main.js",
    }, indent=2) + "\n")
    if system == "Darwin":
        frameworks = bundle / "Contents" / "Frameworks"
        nested = sorted(path for path in frameworks.iterdir() if path.suffix in (".app", ".framework"))
        for path in [*nested, binary.with_name("focused-text"), bundle]:
            subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(path)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
    output = TARGET.with_name(f"{APP}-{target_name}.tar.gz")
    archive(bundle, output)
    print(f"Desktop app: {binary}\nRelease archive: {output}")


if __name__ == "__main__":
    main()
