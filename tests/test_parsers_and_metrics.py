"""Unit tests for parsers, telemetry helpers, history persistence, and FPS estimation."""

import inspect
import threading
import time
from unittest.mock import patch

from core import fps_capture, games, health, history, software_updater


def test_winget_parser_handles_ansi_cr_and_truncated_ids():
    raw = (
        "\x1b[?25l-\r\\\r|\r/\r   \r"
        "Nome                           ID                             Versão         Disponível     Origem\n"
        "---------------------------------------------------------------------------------------------------\n"
        "Mozilla Firefox (pt-BR)        Mozilla.Firefox                130.0          131.0.3        winget\n"
        "Microsoft Visual Studio Code   Microsoft.VisualStudioCode     1.93.0         1.94.2         winget\n"
        "Some Very Long Truncated Pkg   Publisher.VeryLongPackageId…   1.0.0          1.1.0          winget\n"
        "2 atualizações disponíveis.\n"
    )
    items = software_updater.parse_winget_upgrade_output(raw)
    ids = [it["id"] for it in items]
    assert ids == ["Mozilla.Firefox", "Microsoft.VisualStudioCode"]
    assert items[0]["available_version"] == "131.0.3"
    assert items[1]["name"] == "Microsoft Visual Studio Code"


def test_fps_capture_stats_and_lows():
    now = 100.0
    # 100 frames at 10ms each (= 100 FPS avg) + 1 slow frame at 50ms (= 20 FPS 1% low)
    frames = [(now - 0.5 + i * 0.004, 10.0) for i in range(99)]
    frames.append((now - 0.1, 50.0))

    stats = fps_capture.compute_stats(frames, now)
    assert stats["fps"] is not None and 90 <= stats["fps"] <= 105
    assert stats["fps_1pct_low"] == 20
    assert stats["frame_time_ms"] is not None

    # Stale frames must return None
    stale = fps_capture.compute_stats(frames, now + fps_capture.STALE_S + 1.0)
    assert stale == {"fps": None, "frame_time_ms": None, "fps_1pct_low": None}


def test_games_estimator_returns_expected_bounds():
    cs2 = next(g for g in games.GAMES if g["id"] == "cs2")
    res_low = games.estimate_game(cs2, gpu_score=100, gpu_vram=8, cpu_score=100, ram_gb=16, resolution="1080p", preset="low")
    res_ultra = games.estimate_game(cs2, gpu_score=100, gpu_vram=8, cpu_score=100, ram_gb=16, resolution="4k", preset="ultra")
    assert res_low["fps"] > res_ultra["fps"]
    assert res_low["fps_low"] <= res_low["fps"] <= res_low["fps_high"]


def test_history_thread_safety_and_50_cap(tmp_path):
    temp_hist = tmp_path / "history.json"
    with patch.object(history, "DATA_DIR", tmp_path), patch.object(history, "HISTORY_FILE", temp_hist):
        errors = []

        def _worker(tid: int):
            try:
                for j in range(15):
                    history.record_action(
                        action_type="test",
                        title=f"Worker {tid}-{j}",
                        details="ok",
                        bytes_cleaned=100,
                        ram_freed_mb=1.5,
                        files_removed=1,
                    )
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_worker, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        data = history.load_history()
        assert data["optimizations_count"] == 60
        assert data["total_bytes_cleaned"] == 6000
        assert len(data["actions"]) == 50


def test_non_nvidia_gpu_metrics_never_copy_acpi_thermal():
    with patch("core.health.shutil.which", return_value=None), \
         patch.object(health._pdh_sampler, "sample", return_value=(12.5, 512 * 1024 * 1024, 58.0)):
        health._gpu_live_cache["last_check"] = 0.0
        health._gpu_live_cache["temp"] = 99.0
        gpu = health._query_gpu_metrics()
        assert gpu["temp"] is None
        assert gpu["load"] == 12.5
        assert gpu["mem_used_mb"] == 512.0
