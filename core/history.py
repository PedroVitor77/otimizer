import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import sys

def get_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            p = Path(local_app) / "PulsePC" / "data"
            p.mkdir(parents=True, exist_ok=True)
            return p
    p = Path(__file__).resolve().parent.parent / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p

DATA_DIR = get_data_dir()
HISTORY_FILE = DATA_DIR / "history.json"

# API routes run in a thread pool, so two actions finishing together must not interleave
# their read-modify-write of history.json.
_history_lock = threading.RLock()

DEFAULT_HISTORY: Dict[str, Any] = {
    "total_bytes_cleaned": 0,
    "total_ram_freed_mb": 0.0,
    "total_files_removed": 0,
    "optimizations_count": 0,
    "last_optimization": None,
    "actions": []
}


def load_history() -> Dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not HISTORY_FILE.exists():
        save_history(DEFAULT_HISTORY)
        return dict(DEFAULT_HISTORY)
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            merged = dict(DEFAULT_HISTORY)
            merged.update(data)
            return merged
    except Exception:
        return dict(DEFAULT_HISTORY)


def save_history(data: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def record_action(
    action_type: str,
    title: str,
    details: str,
    bytes_cleaned: int = 0,
    ram_freed_mb: float = 0.0,
    files_removed: int = 0,
) -> Dict[str, Any]:
    with _history_lock:
        return _record_action_locked(action_type, title, details, bytes_cleaned, ram_freed_mb, files_removed)


def _record_action_locked(
    action_type: str,
    title: str,
    details: str,
    bytes_cleaned: int,
    ram_freed_mb: float,
    files_removed: int,
) -> Dict[str, Any]:
    history = load_history()
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    history["total_bytes_cleaned"] = int(history.get("total_bytes_cleaned", 0)) + max(0, int(bytes_cleaned))
    history["total_ram_freed_mb"] = round(float(history.get("total_ram_freed_mb", 0.0)) + max(0.0, float(ram_freed_mb)), 2)
    history["total_files_removed"] = int(history.get("total_files_removed", 0)) + max(0, int(files_removed))
    history["optimizations_count"] = int(history.get("optimizations_count", 0)) + 1
    history["last_optimization"] = now_str

    entry = {
        "timestamp": now_str,
        "type": action_type,
        "title": title,
        "details": details,
        "bytes_cleaned": bytes_cleaned,
        "ram_freed_mb": round(ram_freed_mb, 1),
        "files_removed": files_removed,
    }
    actions: List[Dict[str, Any]] = history.get("actions", [])
    actions.insert(0, entry)
    history["actions"] = actions[:50]
    save_history(history)
    return history
