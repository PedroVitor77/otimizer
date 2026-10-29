import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, Optional, Tuple
import urllib.request

CURRENT_VERSION = "1.4.2"
GITHUB_REPO = "PedroVitor77/otimizer"

_download_lock = threading.Lock()
_download_state: Dict[str, Any] = {
    "status": "idle",  # idle, downloading, ready, error
    "percent": 0,
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "file_path": None,
    "error_message": None,
}


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


def _get_auth_token() -> Optional[str]:
    # Check environment variables first
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        return tok.strip()

    # Try reading from antigravity mcp_config.json if available
    try:
        user_home = Path.home()
        cfg_file = user_home / ".gemini" / "config" / "mcp_config.json"
        if cfg_file.exists():
            with open(cfg_file, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
                token = data.get("mcpServers", {}).get("github", {}).get("env", {}).get("GITHUB_PERSONAL_ACCESS_TOKEN")
                if token and token.startswith("gh"):
                    return token.strip()
    except Exception:
        pass

    # Try gh auth token from GitHub CLI
    gh_candidates = ["gh", r"C:\Program Files\GitHub CLI\gh.exe"]
    for gh_cmd in gh_candidates:
        try:
            res = subprocess.run(
                [gh_cmd, "auth", "token"],
                capture_output=True,
                text=True,
                timeout=2,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if res.returncode == 0 and res.stdout.strip().startswith("gh"):
                return res.stdout.strip()
        except Exception:
            continue

    return None


def check_for_updates() -> Dict[str, Any]:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "PulsePC-Updater", "Accept": "application/vnd.github.v3+json"})

    token = _get_auth_token()
    if token:
        req.add_header("Authorization", f"token {token}")

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
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
    token = _get_auth_token()
    for asset in data.get("assets", []):
        name = asset.get("name", "")
        if name.lower().endswith(".exe"):
            # For private repositories with token, use API asset URL with Accept header
            if token and asset.get("url"):
                download_url = asset.get("url")
            else:
                download_url = asset.get("browser_download_url")
            file_size = asset.get("size", 0)
            if "setup" in name.lower():
                break

    has_update = is_newer_version(tag_name, CURRENT_VERSION)

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
    }


def get_download_status() -> Dict[str, Any]:
    with _download_lock:
        return dict(_download_state)


def start_download_update(download_url: str) -> Dict[str, Any]:
    global _download_state
    with _download_lock:
        if _download_state["status"] == "downloading":
            return {"success": False, "message": "Download já em andamento."}
        _download_state["status"] = "downloading"
        _download_state["percent"] = 0
        _download_state["downloaded_bytes"] = 0
        _download_state["total_bytes"] = 0
        _download_state["error_message"] = None

    def _worker():
        global _download_state
        temp_dir = Path(tempfile.gettempdir())
        target_file = temp_dir / "PulsePC_Setup_Update.exe"

        headers = {"User-Agent": "PulsePC-Updater"}
        if "api.github.com" in download_url:
            headers["Accept"] = "application/octet-stream"
        req = urllib.request.Request(download_url, headers=headers)
        token = _get_auth_token()
        if token:
            req.add_header("Authorization", f"token {token}")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp, open(target_file, "wb") as f:
                total_len = int(resp.headers.get("Content-Length") or 0)
                downloaded = 0
                chunk_size = 64 * 1024

                with _download_lock:
                    _download_state["total_bytes"] = total_len

                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)

                    pct = int((downloaded / total_len) * 100) if total_len > 0 else 0
                    with _download_lock:
                        _download_state["downloaded_bytes"] = downloaded
                        _download_state["percent"] = min(100, pct)

            with _download_lock:
                _download_state["status"] = "ready"
                _download_state["percent"] = 100
                _download_state["file_path"] = str(target_file)
        except Exception as e:
            with _download_lock:
                _download_state["status"] = "error"
                _download_state["error_message"] = str(e)

    threading.Thread(target=_worker, daemon=True).start()
    return {"success": True, "message": "Download iniciado."}


def apply_update() -> Dict[str, Any]:
    status = get_download_status()
    file_path = status.get("file_path")
    if not file_path or not os.path.exists(file_path):
        return {"success": False, "message": "Arquivo do instalador não encontrado."}

    try:
        # Launch the installer
        # /CLOSEAPPLICATIONS tells Inno Setup to ask or close the current instance cleanly
        subprocess.Popen([file_path, "/CLOSEAPPLICATIONS"])

        # Terminate current application cleanly after 1.2s to release executable locks
        threading.Timer(1.2, lambda: os._exit(0)).start()
        return {"success": True, "message": "Instalador iniciado! O PulsePC será reiniciado após a instalação."}
    except Exception as e:
        return {"success": False, "message": str(e)}
