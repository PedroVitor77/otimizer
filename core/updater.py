import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit
import urllib.error
import urllib.request

CURRENT_VERSION = "1.6.0"
GITHUB_REPO = "PedroVitor77/otimizer"

# The installer is only ever downloaded from GitHub. Release assets redirect to GitHub's CDN hosts.
_API_HOST = "api.github.com"
_ALLOWED_DOWNLOAD_HOSTS = {
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}

_download_lock = threading.Lock()
_download_state: Dict[str, Any] = {
    "status": "idle",  # idle, downloading, ready, error
    "percent": 0,
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "file_path": None,
    "verified": False,
    "error_message": None,
}

# The release found by the last check. The download URL and hash come from here, never from the
# client, so the API cannot be used to fetch or run an arbitrary file.
_pending_release: Dict[str, Any] = {}


def parse_version(v_str: str) -> Tuple[int, ...]:
    cleaned = re.sub(r"^[vV]", "", v_str.strip())
    parts = []
    for p in cleaned.split("."):
        m = re.match(r"^(\d+)", p)
        if m:
            parts.append(int(m.group(1)))
        else:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_newer_version(latest_str: str, current_str: str) -> bool:
    return parse_version(latest_str) > parse_version(current_str)


_token_cache: Dict[str, Optional[str]] = {}


def _get_auth_token() -> Optional[str]:
    """Token used only for the GitHub API (private repository releases).

    Sources: GH_TOKEN / GITHUB_TOKEN, then the GitHub CLI (`gh auth token`). The result is cached
    for the session so the CLI is not spawned on every call."""
    if "v" in _token_cache:
        return _token_cache["v"]

    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok and tok.strip():
        _token_cache["v"] = tok.strip()
        return _token_cache["v"]

    for gh_cmd in ("gh", r"C:\Program Files\GitHub CLI\gh.exe"):
        try:
            res = subprocess.run(
                [gh_cmd, "auth", "token"],
                capture_output=True,
                text=True,
                timeout=2,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if res.returncode == 0 and res.stdout.strip().startswith(("gh", "github_pat_")):
                _token_cache["v"] = res.stdout.strip()
                return _token_cache["v"]
        except Exception:
            continue

    _token_cache["v"] = None
    return None


def _is_allowed_url(url: str) -> bool:
    parts = urlsplit(url or "")
    return parts.scheme == "https" and (parts.hostname or "").lower() in _ALLOWED_DOWNLOAD_HOSTS


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follows redirects only to allowed HTTPS hosts and never forwards the token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_allowed_url(newurl):
            raise urllib.error.URLError(f"Redirecionamento bloqueado para {urlsplit(newurl).hostname}")
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and (urlsplit(newurl).hostname or "").lower() != _API_HOST:
            new_req.remove_header("Authorization")
        return new_req


_opener = urllib.request.build_opener(_SafeRedirectHandler)


def _parse_digest(asset: Dict[str, Any]) -> Optional[str]:
    digest = str(asset.get("digest") or "")
    m = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", digest.strip())
    return m.group(1).lower() if m else None


def check_for_updates() -> Dict[str, Any]:
    global _pending_release
    url = f"https://{_API_HOST}/repos/{GITHUB_REPO}/releases/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "PulsePC-Updater", "Accept": "application/vnd.github.v3+json"})

    token = _get_auth_token()
    if token:
        req.add_header("Authorization", f"token {token}")

    try:
        with _opener.open(req, timeout=5) as resp:
            if resp.status != 200:
                return {
                    "has_update": False,
                    "current_version": CURRENT_VERSION,
                    "error": f"HTTP {resp.status}",
                }
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # If 404 (e.g. no releases yet or private repo without token), return gracefully
        return {
            "has_update": False,
            "current_version": CURRENT_VERSION,
            "error": f"HTTP {e.code}",
        }
    except Exception as e:
        return {
            "has_update": False,
            "current_version": CURRENT_VERSION,
            "error": str(e),
        }

    tag_name = data.get("tag_name", "")
    release_name = data.get("name") or tag_name
    release_notes = data.get("body", "")
    html_url = data.get("html_url", "")

    download_url = None
    file_size = 0
    sha256 = None
    for asset in data.get("assets", []):
        name = asset.get("name", "")
        if name.lower().endswith(".exe"):
            # Private repositories need the API asset URL (with the token); public ones use the direct link.
            candidate = asset.get("url") if token and asset.get("url") else asset.get("browser_download_url")
            if not _is_allowed_url(candidate or ""):
                continue
            download_url = candidate
            file_size = asset.get("size", 0)
            sha256 = _parse_digest(asset)
            if "setup" in name.lower():
                break

    has_update = is_newer_version(tag_name, CURRENT_VERSION)

    _pending_release = (
        {"download_url": download_url, "sha256": sha256, "size": file_size, "tag": tag_name}
        if has_update and download_url
        else {}
    )

    return {
        "has_update": has_update,
        "current_version": CURRENT_VERSION,
        "latest_version": tag_name.lstrip("vV"),
        "tag_name": tag_name,
        "title": release_name,
        "release_notes": release_notes,
        "release_url": html_url,
        "download_url": download_url,
        "file_size": file_size,
        "verifiable": sha256 is not None,
    }


def get_download_status() -> Dict[str, Any]:
    with _download_lock:
        return dict(_download_state)


def start_download_update(download_url: str) -> Dict[str, Any]:
    global _download_state

    release = dict(_pending_release)
    if not release or download_url != release.get("download_url"):
        return {"success": False, "message": "Atualização não reconhecida. Verifique as atualizações de novo."}
    if not release.get("sha256"):
        return {
            "success": False,
            "message": "Esta versão não traz o hash de verificação (SHA-256) e não pode ser instalada com segurança por aqui. Baixe pelo site do projeto.",
        }

    with _download_lock:
        if _download_state["status"] == "downloading":
            return {"success": False, "message": "Download já em andamento."}
        _download_state.update(
            status="downloading", percent=0, downloaded_bytes=0, total_bytes=0,
            file_path=None, verified=False, error_message=None,
        )

    def _fail(msg: str, path: Optional[Path] = None) -> None:
        if path is not None:
            try:
                path.unlink()
            except OSError:
                pass
        with _download_lock:
            _download_state["status"] = "error"
            _download_state["error_message"] = msg

    def _worker():
        # A private folder with a unique name, so no other program can swap the file before it runs.
        temp_dir = Path(tempfile.mkdtemp(prefix="pulsepc_update_"))
        target_file = temp_dir / f"PulsePC_Setup_{re.sub(r'[^0-9A-Za-z._-]', '', release['tag']) or 'update'}.exe"

        headers = {"User-Agent": "PulsePC-Updater"}
        if _API_HOST in download_url:
            headers["Accept"] = "application/octet-stream"
        req = urllib.request.Request(download_url, headers=headers)
        token = _get_auth_token()
        if token and (urlsplit(download_url).hostname or "").lower() == _API_HOST:
            req.add_header("Authorization", f"token {token}")

        try:
            sha = hashlib.sha256()
            with _opener.open(req, timeout=30) as resp, open(target_file, "wb") as f:
                total_len = int(resp.headers.get("Content-Length") or release.get("size") or 0)
                downloaded = 0
                with _download_lock:
                    _download_state["total_bytes"] = total_len

                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    sha.update(chunk)
                    downloaded += len(chunk)
                    pct = int((downloaded / total_len) * 100) if total_len > 0 else 0
                    with _download_lock:
                        _download_state["downloaded_bytes"] = downloaded
                        _download_state["percent"] = min(99, pct)

            if sha.hexdigest() != release["sha256"]:
                _fail("O arquivo baixado não confere com o hash publicado e foi descartado.", target_file)
                return

            with _download_lock:
                _download_state["status"] = "ready"
                _download_state["percent"] = 100
                _download_state["file_path"] = str(target_file)
                _download_state["verified"] = True
        except Exception as e:
            _fail(str(e), target_file)

    threading.Thread(target=_worker, daemon=True).start()
    return {"success": True, "message": "Download iniciado."}


def apply_update() -> Dict[str, Any]:
    status = get_download_status()
    file_path = status.get("file_path")
    if status.get("status") != "ready" or not status.get("verified"):
        return {"success": False, "message": "Nenhuma atualização verificada para instalar."}
    if not file_path or not os.path.exists(file_path):
        return {"success": False, "message": "Arquivo do instalador não encontrado."}

    try:
        # /CLOSEAPPLICATIONS tells Inno Setup to ask or close the current instance cleanly
        subprocess.Popen([file_path, "/CLOSEAPPLICATIONS"])

        # Terminate current application cleanly after 1.2s to release executable locks
        threading.Timer(1.2, lambda: os._exit(0)).start()
        return {"success": True, "message": "Instalador iniciado! O PulsePC será reiniciado após a instalação."}
    except Exception as e:
        return {"success": False, "message": str(e)}
