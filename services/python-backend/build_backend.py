"""
PyInstaller entry point — unified executable for the knowledge backend.

Supports two modes:
  knowledge-backend.exe          → REST API server (default)
  knowledge-backend.exe mcp      → MCP stdio server

Build a standalone .exe (PyInstaller --onefile):
  uv run pyinstaller --onefile --console --hide-console hide-early ^
      --name knowledge-backend --paths src build_backend.py

The --console flag is required so that MCP-mode can communicate via
stdin/stdout; --hide-console hide-early suppresses the console window
when the REST-API (default) mode runs.
"""
import sys
from pathlib import Path

# Force UTF-8 for stdout/stderr.  The MCP protocol uses JSON over stdout,
# and PyInstaller on Windows defaults to the system codepage (e.g. cp936)
# which corrupts non-ASCII characters.
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

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "mcp":
        from knowledge_backend.mcp_server import main as mcp_main
        mcp_main()
    else:
        from knowledge_backend.main import main as serve_main
        serve_main()
