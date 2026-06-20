"""MinerU Precise API client for the MCP server.

Parses documents (PDF, DOCX, PPTX, XLSX, images, HTML, etc.) via
the MinerU v4 precise extraction API.

Flow:
  1. POST /api/v4/file-urls/batch  →  get upload URL + batch_id
  2. PUT  <upload_url>             →  upload the file
  3. GET  /api/v4/extract-results/batch/{batch_id}  →  poll
  4. Download ZIP from full_zip_url  →  extract full.md

Progress is written to *progress* (a callable receiving str) so callers
can forward it to MCP logs or a UI.
"""

import os
import socket
import ssl
import sys
import time
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import httpx

MINERU_API = "https://mineru.net"
MAX_POLL_SECONDS = 300  # 5 minutes — generous but not infinite
POLL_INTERVAL = 3  # seconds between polls
SUPPORTED_EXTENSIONS = frozenset({
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
    ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tiff", ".tif",
    ".html", ".htm",
})

# Model selection by file category (per MinerU API docs)
_OFFICE_EXTS = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})
_PDF_IMAGE_EXTS = frozenset({".pdf", ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tiff", ".tif"})
_HTML_EXTS = frozenset({".html", ".htm"})


class MinerUError(Exception):
    """Raised when MinerU parsing fails."""


def is_supported(file_path: str | Path) -> bool:
    """Check whether *file_path* has a supported extension."""
    return Path(file_path).suffix.lower() in SUPPORTED_EXTENSIONS


def parse_document(
    file_path: str | Path,
    token: str,
    *,
    timeout: int = MAX_POLL_SECONDS,
    http: httpx.Client | None = None,
    progress: "callable[[str], None] | None" = None,
) -> str:
    """Parse *file_path* via MinerU Precise API, returning markdown text.

    Args:
        file_path: Path to the local file to parse.
        token: MinerU API token (Bearer auth).
        timeout: Maximum seconds to wait for parsing to complete.
        http: Optional httpx client (created if not provided).
        progress: Optional callback(str) for progress messages.

    Returns:
        The parsed markdown content.

    Raises:
        MinerUError: On any API or parse failure.
        FileNotFoundError: If *file_path* does not exist.
    """
    if progress is None:
        progress = lambda msg: print(f"[MinerU] {msg}", file=sys.stderr, flush=True)

    fp = Path(file_path)
    if not fp.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    if not is_supported(fp):
        raise MinerUError(
            f"Unsupported file type: {fp.suffix}. "
            f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )

    progress(f"Starting parse of {fp.name} ({_format_size(fp.stat().st_size)})")

    own_client = http is None
    if own_client:
        http = httpx.Client(timeout=120.0)  # upload timeout

    try:
        file_name = fp.name

        # 1. Request upload URL
        progress("Requesting upload URL...")
        batch_id, upload_url = _request_upload_url(http, token, file_name)
        progress(f"Got upload URL (batch: {batch_id[:12]}...)")

        # 2. Upload file
        progress("Uploading file to MinerU...")
        _upload_file(http, upload_url, fp)
        progress("Upload complete, waiting for parsing...")

        # 3. Poll for results
        md = _poll_results(http, token, batch_id, file_name, timeout, progress)
        progress(f"Parse complete — {len(md)} characters of markdown")
        return md
    finally:
        if own_client and http is not None:
            http.close()


def parse_document_agent(
    file_path: str | Path,
    *,
    timeout: int = 120,
    http: httpx.Client | None = None,
    progress: "callable[[str], None] | None" = None,
) -> str:
    """Parse *file_path* via MinerU **Agent** API (no token needed).

    Lightweight, uses native Office API for Word/PPT parsing. Limited to
    10 MB and 20 pages.  Good fallback when the Precise API is slow or
    unavailable.

    Args:
        file_path: Path to the local file.
        timeout: Maximum seconds to wait.
        http: Optional httpx client.
        progress: Optional callback(str) for progress messages.

    Returns:
        Parsed markdown text.

    Raises:
        MinerUError: On any API or parse failure.
        FileNotFoundError: If *file_path* does not exist.
    """
    if progress is None:
        progress = lambda msg: print(f"[MinerU Agent] {msg}", file=sys.stderr, flush=True)

    fp = Path(file_path)
    if not fp.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    if not is_supported(fp):
        raise MinerUError(f"Unsupported file type: {fp.suffix}")

    size_mb = fp.stat().st_size / (1024 * 1024)
    if size_mb > 10:
        raise MinerUError(
            f"File too large for Agent API ({size_mb:.1f} MB > 10 MB). "
            "Use the Precise API instead."
        )

    own_client = http is None
    if own_client:
        http = httpx.Client(timeout=60.0)

    try:
        # 1. Request signed upload URL
        progress(f"Agent API: requesting upload URL for {fp.name}")
        body = {
            "file_name": fp.name,
            "language": "ch",
        }
        resp = http.post(
            f"{MINERU_API}/api/v1/agent/parse/file",
            json=body,
        )
        data = resp.json()
        if data.get("code") != 0:
            raise MinerUError(
                f"Agent API: failed to get upload URL — {data.get('msg', 'unknown')}"
            )

        task_id = data["data"]["task_id"]
        file_url = data["data"]["file_url"]
        progress(f"Agent API: task_id={task_id}")

        # 2. Upload file
        progress("Agent API: uploading...")
        with open(fp, "rb") as f:
            put_resp = http.put(file_url, content=f.read())
        if put_resp.status_code not in (200, 201):
            raise MinerUError(
                f"Agent API: upload failed (HTTP {put_resp.status_code})"
            )
        progress("Agent API: upload complete, waiting...")

        # 3. Poll
        poll_url = f"{MINERU_API}/api/v1/agent/parse/{task_id}"
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL)
            r = http.get(poll_url)
            d = r.json()
            state = d.get("data", {}).get("state", "unknown")
            elapsed = int(time.monotonic() - (deadline - timeout))

            if state == "done":
                md_url = d["data"]["markdown_url"]
                progress("Agent API: downloading markdown...")
                return _download_with_retry(http, md_url).decode("utf-8")
            elif state == "failed":
                err = d["data"].get("err_msg", "Unknown error")
                raise MinerUError(f"Agent API parse failed: {err}")

            if elapsed % 15 == 0:
                progress(f"Agent API: {state} (elapsed {elapsed}s)")

        raise MinerUError(
            f"Agent API: timed out after {timeout}s for {fp.name}"
        )
    finally:
        if own_client and http is not None:
            http.close()


# ── Internal helpers ──


def _choose_model(file_name: str) -> str:
    """Pick the right MinerU model based on file extension.

    Per MinerU docs:
    - PDF / images → ``vlm`` (recommended for best accuracy)
    - Office docs (doc, docx, ppt, pptx, xls, xlsx) → ``pipeline``
      (these need internal conversion to PDF first; vlm may hang)
    - HTML → ``MinerU-HTML``
    """
    ext = Path(file_name).suffix.lower()
    if ext in _HTML_EXTS:
        return "MinerU-HTML"
    if ext in _OFFICE_EXTS:
        return "pipeline"
    return "vlm"  # PDF + images


def _request_upload_url(
    http: httpx.Client, token: str, file_name: str
) -> tuple[str, str]:
    """Get a pre-signed upload URL and batch_id."""
    model = _choose_model(file_name)

    body = {
        "files": [
            {"name": file_name, "data_id": f"mcp-{_short_uuid()}"}
        ],
        "model_version": model,
    }

    resp = http.post(
        f"{MINERU_API}/api/v4/file-urls/batch",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        json=body,
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("code") != 0:
        raise MinerUError(
            f"Upload URL request failed: {data.get('msg', 'unknown')}"
        )

    batch_id = data["data"]["batch_id"]
    upload_url = data["data"]["file_urls"][0]
    return batch_id, upload_url


def _upload_file(http: httpx.Client, url: str, file_path: Path):
    """Upload the file to the pre-signed URL."""
    with open(file_path, "rb") as f:
        resp = http.put(url, content=f.read())
    if not resp.is_success:
        raise MinerUError(f"File upload failed: HTTP {resp.status_code}")


def _poll_results(
    http: httpx.Client,
    token: str,
    batch_id: str,
    file_name: str,
    timeout: int,
    progress: "callable[[str], None]",
) -> str:
    """Poll for batch results with progress logging, download and extract markdown."""
    url = f"{MINERU_API}/api/v4/extract-results/batch/{batch_id}"
    deadline = time.monotonic() + timeout
    attempt = 0
    last_state = ""

    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL)
        attempt += 1
        elapsed = int(time.monotonic() - (deadline - timeout))

        try:
            resp = http.get(url, headers={"Authorization": f"Bearer {token}"})
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            progress(f"Poll #{attempt} failed ({exc}), retrying...")
            continue

        code = data.get("code")
        if code != 0:
            msg = data.get("msg", "unknown")
            # Permanent errors should not be retried
            if isinstance(msg, str) and ("not found" in msg.lower() or "invalid" in msg.lower()):
                raise MinerUError(f"Batch lookup failed: {msg}")
            # Transient — keep polling
            if attempt % 5 == 0:
                progress(f"Waiting... (code={code}, elapsed={elapsed}s)")
            continue

        extract_results = data.get("data", {}).get("extract_result")
        if not isinstance(extract_results, list) or not extract_results:
            if attempt % 5 == 0:
                progress(f"Waiting for results... (elapsed={elapsed}s)")
            continue

        for item in extract_results:
            state = item.get("state", "unknown")

            # Log state changes
            if state != last_state:
                progress(f"Status: {state} (elapsed {elapsed}s)")
                last_state = state

            if state == "done":
                zip_url = item.get("full_zip_url")
                if not zip_url:
                    raise MinerUError("Missing full_zip_url in result")
                progress("Downloading result ZIP...")
                return _download_and_extract(http, zip_url)

            elif state == "failed":
                err = item.get("err_msg", "Unknown parse error")
                raise MinerUError(f"Parse failed: {err}")

            # "running" / "processing" — keep polling
            if attempt % 10 == 0:
                progress(f"Still {state}... (elapsed {elapsed}s, file: {file_name})")

    raise MinerUError(
        f"Parse timed out after {timeout}s for file: {file_name}"
    )


def _build_cdn_ssl_context() -> "ssl.SSLContext":
    """Build an SSL context compatible with the MinerU CDN.

    The CDN requires ``@SECLEVEL=1`` and Python's ``create_default_context``
    does not propagate this correctly through httpx/urllib.  We use
    ``PROTOCOL_TLS_CLIENT`` directly, which works with raw sockets.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
    return ctx


def _download_with_retry(http: httpx.Client, url: str, max_retries: int = 5) -> bytes:
    """Download from the MinerU CDN with retries.

    Uses raw-socket SSL (``PROTOCOL_TLS_CLIENT`` + ``@SECLEVEL=1``) which
    is required for the MinerU CDN.  Falls back to plain HTTP.
    """
    last_error = None

    for attempt in range(max_retries):
        # Strategy 1: raw-socket HTTPS with custom SSL context
        try:
            ctx = _build_cdn_ssl_context()
            parsed = urlparse(url)
            sock = socket.create_connection((parsed.hostname, parsed.port or 443), timeout=30)
            try:
                ssock = ctx.wrap_socket(sock, server_hostname=parsed.hostname)
                path = parsed.path + ("?" + parsed.query if parsed.query else "")
                req = f"GET {path} HTTP/1.1\r\nHost: {parsed.hostname}\r\nConnection: close\r\n\r\n"
                ssock.sendall(req.encode())
                # Read response
                data = b""
                while True:
                    chunk = ssock.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                ssock.close()
                # Split headers from body
                parts = data.split(b"\r\n\r\n", 1)
                if len(parts) != 2:
                    raise MinerUError("Invalid HTTP response from CDN")
                header, raw_body = parts
                status_line = header.split(b"\r\n")[0].decode()
                if not status_line.startswith("HTTP/1.1 200"):
                    raise MinerUError(f"CDN returned: {status_line}")

                # Dechunk if necessary (CDN often uses chunked encoding)
                if b"Transfer-Encoding: chunked" in header:
                    body = b""
                    pos = 0
                    while pos < len(raw_body):
                        nl = raw_body.find(b"\r\n", pos)
                        if nl < 0:
                            break
                        try:
                            chunk_size = int(raw_body[pos:nl], 16)
                        except ValueError:
                            break
                        if chunk_size == 0:
                            break
                        body += raw_body[nl + 2 : nl + 2 + chunk_size]
                        pos = nl + 2 + chunk_size + 2
                else:
                    body = raw_body

                return body
            finally:
                sock.close()
        except Exception as exc:
            last_error = exc

        # Strategy 2: HTTP fallback
        try:
            http_url = url.replace("https://", "http://", 1)
            resp = http.get(http_url, timeout=60.0)
            resp.raise_for_status()
            return resp.content
        except Exception:
            pass

        if attempt < max_retries - 1:
            time.sleep(2 ** attempt)

    raise MinerUError(
        f"CDN download failed after {max_retries} retries: {last_error}"
    )


def _download_and_extract(http: httpx.Client, zip_url: str) -> str:
    """Download the result ZIP and extract full.md."""
    data = _download_with_retry(http, zip_url)

    with zipfile.ZipFile(BytesIO(data)) as zf:
        for name in zf.namelist():
            if name.endswith("full.md") or name == "full.md":
                return zf.read(name).decode("utf-8")

    raise MinerUError("full.md not found in result archive")


def _short_uuid() -> str:
    import uuid
    return str(uuid.uuid4())[:8]


def _format_size(n: int) -> str:
    """Human-readable file size."""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.0f} GB"
