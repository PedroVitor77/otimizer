"""Security and safety-lock tests for PulsePC deletion and process modules."""

import os
from pathlib import Path
from unittest.mock import patch

from core import cleaner, manager, processes, scanner, uninstaller


def test_scanner_protects_system_paths_and_executables():
    protected_sys, _ = scanner.is_protected_file(r"C:\Users\Test\Downloads\driver.sys")
    assert protected_sys is True

    protected_boot, _ = scanner.is_protected_file(r"C:\Users\Test\Downloads\bootmgr")
    assert protected_boot is True

    protected_win, _ = scanner.is_protected_file(r"C:\Windows\System32\drivers\etc\hosts")
    assert protected_win is True

    allowed_installer, _ = scanner.is_protected_file(r"C:\Users\Test\Downloads\setup.exe")
    assert allowed_installer is False

    allowed, reason = scanner.is_protected_file(r"C:\Users\Test\Downloads\video_backup.mp4")
    assert allowed is False
    assert reason == ""


def test_leftover_target_safety_guards():
    assert uninstaller._is_safe_leftover_target(Path(r"C:\Windows")) is False
    assert uninstaller._is_safe_leftover_target(Path(r"C:\Program Files")) is False
    assert uninstaller._is_safe_leftover_target(Path(r"C:\Users\Test\AppData\Roaming\Microsoft")) is False
    assert uninstaller._is_safe_leftover_target(Path(r"C:\Users\Test\AppData\Roaming\SomeOldApp")) is True


def test_clean_app_leftovers_enforces_scan_allowlist(tmp_path):
    rogue_dir = tmp_path / "RogueApp"
    rogue_dir.mkdir()
    rogue_file = rogue_dir / "keep.txt"
    rogue_file.write_text("important", encoding="utf-8")

    # Never scanned -> clean_app_leftovers must refuse to touch it
    with patch("core.uninstaller.send2trash.send2trash") as mock_trash:
        res = uninstaller.clean_app_leftovers(
            folders=[str(rogue_dir)],
            files=[str(rogue_file)],
            registry_keys=[{"root_name": "HKCU", "subkey": r"Software\RogueApp"}],
            app_name="NonExistentAppTest",
        )
        mock_trash.assert_not_called()
        assert res["removed_folders"] == 0
        assert res["removed_files"] == 0
        assert res["removed_keys"] == 0
        assert len(res["errors"]) == 3


def test_clean_app_leftovers_blocks_unsafe_reg_chars():
    app_name = "TestAppUnsafeChars"
    uninstaller._remember_leftover_scan(
        app_name,
        folders=[],
        files=[],
        keys=[{"root_name": "HKCU", "subkey": 'Software\\Bad"Key'}],
    )
    res = uninstaller.clean_app_leftovers(
        folders=[],
        files=[],
        registry_keys=[{"root_name": "HKCU", "subkey": 'Software\\Bad"Key'}],
        app_name=app_name,
    )
    assert res["removed_keys"] == 0
    assert any("caracteres inválidos" in e for e in res["errors"])


def test_node_modules_cleaner_requires_scan_and_rejects_links(tmp_path):
    nm_dir = tmp_path / "proj" / "node_modules"
    nm_dir.mkdir(parents=True)
    (nm_dir / "dep.js").write_text("console.log(1);", encoding="utf-8")

    with cleaner._node_modules_lock:
        cleaner._allowed_node_modules = None

    with patch("core.cleaner.send2trash.send2trash") as mock_trash:
        res = cleaner.clean_inactive_node_modules([str(nm_dir)])
        mock_trash.assert_not_called()
        assert res["removed_count"] == 0
        assert len(res["errors"]) == 1

    # Simulate an allowlisted path that turns out to be a symlink/junction
    with cleaner._node_modules_lock:
        cleaner._allowed_node_modules = {os.path.normcase(os.path.abspath(str(nm_dir)))}
    with patch("core.cleaner._is_path_link_or_junction", return_value=True), \
         patch("core.cleaner.send2trash.send2trash") as mock_trash:
        res2 = cleaner.clean_inactive_node_modules([str(nm_dir)])
        mock_trash.assert_not_called()
        assert res2["removed_count"] == 0


def test_manager_facade_exports_and_process_protection():
    assert manager.kill_process is processes.kill_process
    assert manager.clean_app_leftovers is uninstaller.clean_app_leftovers

    self_res = processes.kill_process(os.getpid())
    assert self_res["success"] is False

    sys_res = processes.kill_process(4)
    assert sys_res["success"] is False
