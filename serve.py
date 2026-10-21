#!/usr/bin/env python3
"""Dev serving moved to Vite. Bare `three` imports are resolved by the dev server, not by this file."""
import sys
print('This game is built with Vite. From the repo root run: npm run dev', file=sys.stderr)
print('Then open http://127.0.0.1:8910', file=sys.stderr)
sys.exit(1)
