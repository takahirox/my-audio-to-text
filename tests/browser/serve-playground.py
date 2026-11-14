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


class PagesServer(ThreadingHTTPServer):
    # Parallel browser engines open bursts of module/worker connections. The
    # default five-slot listen backlog can reset a module request during boot.
    request_queue_size = 128


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2] / "web"
    PagesServer(
        ("127.0.0.1", 8000), partial(PagesHandler, directory=str(root))
    ).serve_forever()
