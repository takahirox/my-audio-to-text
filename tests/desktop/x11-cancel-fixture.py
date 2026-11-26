"""Queue a release on the helper's input pipe during AT-SPI discovery."""
import json
import os
import runpy
import sys

sys.path.insert(0, "desktop")
helper = runpy.run_path("desktop/x11-accessibility.py")
GLib = helper["GLib"]


class Target:
    def __init__(self):
        self.insertions = []

    def insert_text(self, offset, text, length):
        self.insertions.append(text)
        return False


read_fd, write_fd = os.pipe()
with os.fdopen(read_fd) as stdin, os.fdopen(write_fd, "wb", buffering=0) as requests:
    sys.stdin = stdin
    focus = helper["Focus"]()
    target = Target()
    window = object()

    def request(number, action, **fields):
        message = {"request": number, "action": action, "token": "dictation", **fields}
        requests.write(json.dumps(message).encode() + b"\n")

    def locate(_window):
        request(3, "release")
        return None, target

    focus.window = lambda: window
    focus.locate = locate
    focus.verify = lambda *_: None
    focus.caret = lambda _: (0, 0)
    request(1, "authorize")
    request(2, "insert", text="canceled text")
    focus.receive(read_fd, GLib.IO_IN)
    context = GLib.MainContext.default()
    while context.iteration(False):
        pass
    assert not target.insertions, "Canceled text reached AT-SPI"
