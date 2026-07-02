"""Manage llama.cpp server lifecycle for local embedding and reranking.

llama.cpp requires separate server instances for embedding and reranking:
  - Embedding: --embedding --model <emb> on port P
  - Rerank:    --rerank    --model <rer> on port P+1
"""

import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

import atexit

# ── Globals ──

_EMB_PROCESS: Optional[subprocess.Popen] = None
_EMB_PORT: int = 0
_EMB_STARTING: bool = False

_RERANK_PROCESS: Optional[subprocess.Popen] = None
_RERANK_PORT: int = 0
_RERANK_STARTING: bool = False


# ── Binary / model discovery ──

def _find_llama_server() -> Optional[Path]:
    project_root = Path(__file__).resolve().parents[4]
    exe_dir = Path(sys.executable).parent if hasattr(sys, "executable") else None
    for c in [
        project_root / "llama-b9821-bin-win-cpu-x64" / "llama-server.exe",
        project_root / "llama-b9821-bin-win-cpu-x64" / "llama-server",
        exe_dir / "llama-server.exe" if exe_dir else None,
        exe_dir / "llama-server" if exe_dir else None,
        Path("llama-b9821-bin-win-cpu-x64/llama-server.exe"),
        Path("llama-b9821-bin-win-cpu-x64/llama-server"),
    ]:
        if c and c.exists():
            return c
    return None


def _find_model(model_name: str) -> Optional[Path]:
    if not model_name:
        return None
    p = Path(model_name)
    if p.is_absolute() and p.exists():
        return p
    project_root = Path(__file__).resolve().parents[4]
    exe_dir = Path(sys.executable).parent if hasattr(sys, "executable") else None
    for c in [
        project_root / "models" / model_name,
        project_root / model_name,
        exe_dir / "models" / model_name if exe_dir else None,
        exe_dir / model_name if exe_dir else None,
    ]:
        if c and c.exists():
            return c
    return None


# ── Process helpers ──

def _start_instance(port: int, flag: str, model_name: str, threads: int) -> subprocess.Popen:
    """Start a single llama-server instance. Returns the Popen object."""
    server_bin = _find_llama_server()
    if not server_bin:
        raise FileNotFoundError("llama-server binary not found")

    model_path = _find_model(model_name)
    if not model_path:
        raise FileNotFoundError(f"Model file not found: {model_name}")

    cmd = [
        str(server_bin),
        "--port", str(port),
        "--host", "127.0.0.1",
        "--threads", str(threads),
        "--ctx-size", "2048",
        "--batch-size", "512",
        flag,
        "--model", str(model_path),
        *(["--pooling", "mean"] if flag == "--embedding" else []),
        "--no-webui",
        "--log-disable",
    ]

    startupinfo = None
    creationflags = 0
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        creationflags = subprocess.CREATE_NO_WINDOW

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        startupinfo=startupinfo,
        creationflags=creationflags,
    )

    # Wait for ready
    for _ in range(20):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            break
        except Exception:
            time.sleep(0.5)

    return proc


def _stop_instance(proc: Optional[subprocess.Popen]):
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _is_running(proc: Optional[subprocess.Popen], port: int) -> bool:
    if proc is None or proc.poll() is not None:
        return False
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
        return True
    except Exception:
        return False


# ── Public API ──

def start_embedding_server(model: str, port: int = 8081, threads: int = 4) -> str:
    """Start the embedding server. Returns base URL. Idempotent."""
    global _EMB_PROCESS, _EMB_PORT, _EMB_STARTING
    if _is_running(_EMB_PROCESS, _EMB_PORT) and _EMB_PORT == port:
        return f"http://127.0.0.1:{port}"
    _stop_instance(_EMB_PROCESS)
    _EMB_STARTING = True
    try:
        _EMB_PROCESS = _start_instance(port, "--embedding", model, threads)
        _EMB_PORT = port
    finally:
        _EMB_STARTING = False
    return f"http://127.0.0.1:{port}"


def start_rerank_server(model: str, port: int = 8082, threads: int = 4) -> str:
    """Start the rerank server. Returns base URL. Idempotent."""
    global _RERANK_PROCESS, _RERANK_PORT, _RERANK_STARTING
    if _is_running(_RERANK_PROCESS, _RERANK_PORT) and _RERANK_PORT == port:
        return f"http://127.0.0.1:{port}"
    _stop_instance(_RERANK_PROCESS)
    _RERANK_STARTING = True
    try:
        _RERANK_PROCESS = _start_instance(port, "--rerank", model, threads)
        _RERANK_PORT = port
    finally:
        _RERANK_STARTING = False
    return f"http://127.0.0.1:{port}"


def stop_all():
    """Stop both servers."""
    global _EMB_PROCESS, _EMB_PORT, _RERANK_PROCESS, _RERANK_PORT
    _stop_instance(_EMB_PROCESS)
    _stop_instance(_RERANK_PROCESS)
    _EMB_PROCESS = None
    _EMB_PORT = 0
    _RERANK_PROCESS = None
    _RERANK_PORT = 0


def is_llama_running() -> bool:
    """Check if either server is running."""
    return _is_running(_EMB_PROCESS, _EMB_PORT) or _is_running(_RERANK_PROCESS, _RERANK_PORT)


def status() -> dict:
    """Return detailed status of both servers."""
    emb_running = _is_running(_EMB_PROCESS, _EMB_PORT)
    rer_running = _is_running(_RERANK_PROCESS, _RERANK_PORT)
    return {
        "embedding": {
            "running": emb_running,
            "starting": _EMB_STARTING,
            "port": _EMB_PORT,
        },
        "rerank": {
            "running": rer_running,
            "starting": _RERANK_STARTING,
            "port": _RERANK_PORT,
        },
    }


# Legacy alias for backward compatibility with config.py
# ponytail: remove when config.py updated to use start_embedding_server/start_rerank_server directly
def start_llama_server(embedding_model: str = "", rerank_model: str = "", port: int = 8081, threads: int = 4) -> str:
    """Legacy wrapper — starts both servers if models provided. Returns embedding base URL."""
    url = ""
    if embedding_model:
        url = start_embedding_server(embedding_model, port, threads)
    if rerank_model:
        start_rerank_server(rerank_model, port + 1, threads)
    return url


atexit.register(stop_all)
