#!/usr/bin/env python3
"""Serve the existing web assets with isolation headers for browser benchmarks.

WebKit's nested pthread workers need HTTP COEP headers; service-worker-only
isolation stalls the pinned runtime in the automated WebKit environment.
This server is for measurement only, not the Pages deployment.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class IsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent / 'web'
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(IsolatedHandler, directory=str(root)))
    print(f'Isolated benchmark server: http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()
