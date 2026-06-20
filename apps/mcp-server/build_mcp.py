"""
PyInstaller entry point for the MCP server.

Build a standalone .exe:
    uv run pyinstaller --onefile --noconsole --name local-kb-mcp --paths src --paths .venv/Lib/site-packages build_mcp.py
"""
import sys
from pathlib import Path

# Force UTF-8 for stdout/stderr — the MCP protocol uses JSON over stdout,
# and PyInstaller on Windows defaults to cp936 which corrupts non-ASCII
# characters (e.g. Chinese/Japanese/Korean text in tool responses).
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

_base = Path(__file__).resolve().parent

# Ensure the src directory AND venv site-packages are on the path
_src = _base / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

_venv_sp = _base / ".venv" / "Lib" / "site-packages"
if _venv_sp.exists() and str(_venv_sp) not in sys.path:
    sys.path.insert(0, str(_venv_sp))

from knowledge_mcp.server import main

if __name__ == "__main__":
    main()
