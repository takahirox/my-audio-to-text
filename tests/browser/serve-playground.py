"""Serve web/ without isolation headers, also under a Pages repository prefix."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class PagesHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Keep the same URLs the browser would request on GitHub Pages while
        # mapping the test alias to the same published artifact directory.
        prefix = "/my-audio-to-text"
        if path.startswith(prefix + "/"):
            path = path[len(prefix):]
        return super().translate_path(path)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2] / "web"
    ThreadingHTTPServer(
        ("127.0.0.1", 8000), partial(PagesHandler, directory=str(root))
    ).serve_forever()
