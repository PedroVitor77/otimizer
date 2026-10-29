"""Software Updater engine via Windows Package Manager (winget).

Allows checking for software upgrades and updating third-party applications
(browsers, utilities, runtimes, development tools) silently in the background.
"""

from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from core.history import record_action

# Global lock & state
_updater_lock = threading.Lock()
_cached_updates: Dict[str, Any] = {
    "items": [],
    "last_check": 0.0,
    "total": 0,
    "available": False,
}

_active_process: Optional[subprocess.Popen] = None
_upgrade_state: Dict[str, Any] = {
    "status": "idle",  # idle, scanning, upgrading, finished, error, cancelled
    "current_package": None,
    "total": 0,
    "current_index": 0,
    "percent": 0,
    "completed": [],
    "failed": [],
    "logs": [],
}


def is_winget_available() -> bool:
    """Check if winget CLI is installed and operational."""
    if not shutil.which("winget"):
        return False
    try:
        res = subprocess.run(
            ["winget", "--version"],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            timeout=3,
        )
        return res.returncode == 0
    except Exception:
        return False


def get_winget_version() -> Optional[str]:
    """Return the installed winget version string."""
    try:
        res = subprocess.run(
            ["winget", "--version"],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            timeout=3,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return None


def scan_software_updates(force: bool = False) -> Dict[str, Any]:
    """Scan winget for available application updates."""
    global _cached_updates

    if not is_winget_available():
        return {
            "available": False,
            "error": "Windows Package Manager (winget) não está instalado ou acessível neste computador.",
            "total": 0,
            "items": [],
            "last_check": time.time(),
        }

    now = time.time()
    if not force and _cached_updates.get("available") and (now - _cached_updates.get("last_check", 0.0)) < 60.0:
        return _cached_updates

    try:
        res = subprocess.run(
            ["winget", "upgrade"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            timeout=25,
        )

        lines = res.stdout.splitlines()
        items: List[Dict[str, str]] = []
        header_idx = -1

        for idx, line in enumerate(lines):
            if line.startswith("---"):
                header_idx = idx - 1
                break

        if header_idx >= 0:
            header = lines[header_idx]
            col_name = header.find("Name")
            col_id = header.find("Id")
            col_ver = header.find("Version")
            col_avail = header.find("Available")
            col_source = header.find("Source")

            for line in lines[header_idx + 2:]:
                sline = line.strip()
                if (
                    not sline
                    or sline.startswith("-")
                    or "upgrades available" in sline
                    or "package(s) have version" in sline
                    or "have pins preventing" in sline
                ):
                    continue

                name = line[:col_id].strip() if col_id != -1 else ""
                pkg_id = line[col_id:col_ver].strip() if col_ver != -1 else ""
                ver = line[col_ver:col_avail].strip() if col_avail != -1 else ""
                avail = (
                    line[col_avail:col_source].strip()
                    if col_source != -1
                    else line[col_avail:].strip()
                )
                source = line[col_source:].strip() if col_source != -1 else "winget"

                if pkg_id and avail:
                    items.append({
                        "name": name,
                        "id": pkg_id,
                        "installed_version": ver,
                        "available_version": avail,
                        "source": source,
                    })

        _cached_updates = {
            "available": True,
            "total": len(items),
            "items": items,
            "last_check": now,
            "winget_version": get_winget_version(),
        }
        return _cached_updates

    except subprocess.TimeoutExpired:
        return {
            "available": True,
            "error": "Tempo limite esgotado ao buscar atualizações pelo winget.",
            "total": 0,
            "items": [],
            "last_check": now,
        }
    except Exception as e:
        return {
            "available": False,
            "error": f"Falha ao consultar winget: {e}",
            "total": 0,
            "items": [],
            "last_check": now,
        }


def start_software_upgrade(package_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    """Start an asynchronous background job to upgrade selected packages (or all)."""
    global _upgrade_state

    with _updater_lock:
        if _upgrade_state["status"] == "upgrading":
            return {
                "success": False,
                "message": "Uma atualização de softwares já está em andamento.",
                "state": _upgrade_state,
            }

        # Resolve packages to upgrade
        scan_data = scan_software_updates()
        all_items = {it["id"]: it for it in scan_data.get("items", [])}

        targets: List[Dict[str, str]] = []
        if package_ids:
            for pid in package_ids:
                if pid in all_items:
                    targets.append(all_items[pid])
                else:
                    targets.append({
                        "id": pid,
                        "name": pid,
                        "installed_version": "--",
                        "available_version": "latest",
                        "source": "winget",
                    })
        else:
            targets = scan_data.get("items", [])

        if not targets:
            return {
                "success": False,
                "message": "Nenhum programa pendente de atualização encontrado.",
                "state": _upgrade_state,
            }

        _upgrade_state = {
            "status": "upgrading",
            "current_package": None,
            "total": len(targets),
            "current_index": 0,
            "percent": 0,
            "completed": [],
            "failed": [],
            "logs": [f"Iniciando atualização de {len(targets)} programa(s)..."],
        }

        thread = threading.Thread(
            target=_run_upgrade_worker,
            args=(targets,),
            daemon=True,
            name="WingetUpgradeWorker",
        )
        thread.start()

        return {
            "success": True,
            "message": f"Atualização iniciada para {len(targets)} programa(s).",
            "total": len(targets),
        }


def _run_upgrade_worker(targets: List[Dict[str, str]]):
    """Background thread sequentially upgrading target packages."""
    global _upgrade_state, _active_process, _cached_updates

    total = len(targets)
    for idx, target in enumerate(targets):
        with _updater_lock:
            if _upgrade_state["status"] == "cancelled":
                _upgrade_state["logs"].append("Atualizações canceladas pelo usuário.")
                break

            _upgrade_state["current_package"] = target["name"]
            _upgrade_state["current_index"] = idx + 1
            _upgrade_state["percent"] = int(round((idx / total) * 100))
            _upgrade_state["logs"].append(
                f"[{idx+1}/{total}] Atualizando {target['name']} ({target['installed_version']} -> {target['available_version']})..."
            )

        cmd = [
            "winget",
            "upgrade",
            "--id",
            target["id"],
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ]

        try:
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            _active_process = p
            output, _ = p.communicate(timeout=300)
            _active_process = None

            # winget returns 0 on success, or -1978335189 (0x8A15002B) if already up to date
            success = p.returncode in (0, -1978335189)
            if success:
                with _updater_lock:
                    _upgrade_state["completed"].append(target)
                    _upgrade_state["logs"].append(f"✓ {target['name']} atualizado com sucesso!")
            else:
                err_summary = "Instalação falhou ou requer permissão elevada"
                for l in output.splitlines():
                    if any(w in l.lower() for w in ["error", "falha", "failed", "exit code"]):
                        err_summary = l.strip()
                        break
                with _updater_lock:
                    _upgrade_state["failed"].append({**target, "error": err_summary})
                    _upgrade_state["logs"].append(f"✕ {target['name']}: {err_summary}")

        except subprocess.TimeoutExpired:
            if _active_process:
                try:
                    _active_process.kill()
                except Exception:
                    pass
                _active_process = None
            with _updater_lock:
                _upgrade_state["failed"].append({**target, "error": "Tempo limite esgotado (5 min)"})
                _upgrade_state["logs"].append(f"✕ {target['name']}: Tempo limite esgotado.")
        except Exception as e:
            with _updater_lock:
                _upgrade_state["failed"].append({**target, "error": str(e)})
                _upgrade_state["logs"].append(f"✕ {target['name']}: Erro {e}")

    with _updater_lock:
        if _upgrade_state["status"] != "cancelled":
            _upgrade_state["status"] = "finished"
        _upgrade_state["current_package"] = None
        _upgrade_state["current_index"] = total
        _upgrade_state["percent"] = 100
        completed_count = len(_upgrade_state["completed"])
        _upgrade_state["logs"].append(
            f"Processo finalizado. {completed_count} de {total} programas atualizados com sucesso."
        )

        # Invalidate scan cache
        _cached_updates["last_check"] = 0.0

        if completed_count > 0:
            record_action(
                action_type="software_update",
                title="Atualização de Softwares Concluída",
                details=f"{completed_count} programa(s) atualizados com sucesso via Winget.",
            )


def cancel_software_upgrade() -> bool:
    """Cancel any in-progress upgrade process."""
    global _upgrade_state, _active_process
    with _updater_lock:
        _upgrade_state["status"] = "cancelled"
        if _active_process:
            try:
                _active_process.terminate()
            except Exception:
                pass
            _active_process = None
        return True


def get_upgrade_status() -> Dict[str, Any]:
    """Retrieve live status of ongoing or completed upgrades."""
    with _updater_lock:
        return dict(_upgrade_state)
