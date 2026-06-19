"""
PyInstaller entry point for the knowledge backend.

Build a standalone .exe:
    uv run pyinstaller --onefile --noconsole --name knowledge-backend --paths src --paths .venv/Lib/site-packages build_backend.py
"""
import sys
from pathlib import Path

_base = Path(__file__).resolve().parent

# Ensure the src directory AND venv site-packages are on the path
# so PyInstaller can find all dependencies during analysis and at runtime
_src = _base / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

_venv_sp = _base / ".venv" / "Lib" / "site-packages"
if _venv_sp.exists() and str(_venv_sp) not in sys.path:
    sys.path.insert(0, str(_venv_sp))

from knowledge_backend.main import main

if __name__ == "__main__":
    main()
