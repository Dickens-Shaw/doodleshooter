#!/usr/bin/env python3
"""Tiny dev server for the game (no-cache headers so edits show up on reload)."""
import http.server, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
host = '0.0.0.0'
print(f'serving on {host}:{port}', flush=True)
try:
    http.server.ThreadingHTTPServer((host, port), H).serve_forever()
except KeyboardInterrupt:
    pass
