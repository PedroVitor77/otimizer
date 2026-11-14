"""Compatibility facade re-exporting process, startup, uninstaller, and repair modules."""

from core.processes import CRITICAL_PROCESSES, get_processes, kill_process
from core.repair import create_restore_point, run_repair_tool
from core.startup import DISABLED_KEY_PATH, RUN_KEY_PATH, _read_reg_startup, get_startup_items, toggle_startup_item
from core.uninstaller import (
    GENERIC_WORDS_LEFTOVERS,
    PROTECTED_NAMES_LEFTOVERS,
    STOPWORDS_LEFTOVERS,
    UNINSTALL_REGISTRY_ROOTS,
    _allowed_leftovers,
    _delete_reg_key_recursive,
    _extract_leftover_keywords,
    _extract_uninstaller_exe,
    _is_ghost_program,
    _is_safe_leftover_target,
    _norm_path,
    _norm_reg,
    _reg_key_exists,
    _remember_leftover_scan,
    clean_app_leftovers,
    get_installed_programs,
    launch_uninstaller,
    scan_app_leftovers,
)

__all__ = [
    "CRITICAL_PROCESSES",
    "get_processes",
    "kill_process",
    "RUN_KEY_PATH",
    "DISABLED_KEY_PATH",
    "get_startup_items",
    "toggle_startup_item",
    "UNINSTALL_REGISTRY_ROOTS",
    "get_installed_programs",
    "launch_uninstaller",
    "scan_app_leftovers",
    "clean_app_leftovers",
    "create_restore_point",
    "run_repair_tool",
]
