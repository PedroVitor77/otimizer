"""API, UI bundle, game booster, benchmark, and version-sync integration tests."""

from pathlib import Path
import re
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as pulse_app
from core import benchmark, game_booster, updater, version

ROOT = Path(__file__).resolve().parent.parent


def test_version_single_source_of_truth():
    assert pulse_app.app.version == version.APP_VERSION
    assert updater.CURRENT_VERSION == version.APP_VERSION

    iss_text = (ROOT / "installer.iss").read_text(encoding="utf-8")
    m = re.search(r'#define\s+MyAppVersion\s+"([^"]+)"', iss_text)
    assert m is not None
    assert m.group(1) == version.APP_VERSION


def test_local_ui_middleware_blocks_untrusted_host_and_origin():
    client = TestClient(pulse_app.app, base_url="http://127.0.0.1:8765")

    ok = client.get("/api/history")
    assert ok.status_code == 200

    bad_host = client.get("/api/history", headers={"Host": "evil.example:8765"})
    assert bad_host.status_code == 403

    bad_origin = client.post(
        "/api/settings/tray",
        json={"minimize_to_tray": True},
        headers={"Origin": "https://attacker.invalid"},
    )
    assert bad_origin.status_code == 403

    cross_site = client.post(
        "/api/settings/tray",
        json={"minimize_to_tray": True},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert cross_site.status_code == 403


def test_index_and_modular_js_served():
    client = TestClient(pulse_app.app, base_url="http://127.0.0.1:8765")
    resp = client.get("/")
    assert resp.status_code == 200
    assert "/static/app.js" not in resp.text

    expected_modules = [
        "/static/js/core.js",
        "/static/js/dashboard.js",
        "/static/js/cleaner.js",
        "/static/js/games.js",
        "/static/js/peripherals.js",
        "/static/js/optimizer.js",
        "/static/js/manager.js",
        "/static/js/software_updater.js",
        "/static/js/system.js",
        "/static/js/main.js",
    ]
    css_resp = client.get("/static/styles.css")
    assert css_resp.status_code == 200
    assert "--cyan: #38BDF8" in css_resp.text

    for expected_id in (
        "cmd-search-trigger",
        "cmd-modal-backdrop",
        "tile-cpu-spark",
        "tile-ram-spark",
        "tile-gpu-spark",
        "hud-preview-pill",
        "fpsFrametimeCanvas",
        "gamerGpuRingCanvas",
        "scoreRingCanvas",
        "stripCanvas",
        "ringsCanvas",
        "tab-peripherals",
        "mouse-test-pad",
        "mousePollingCanvas",
        "kb-visual-grid",
        "typing-stage",
        "typing-words",
        "gamepadStickLeft",
        "gp-controller-svg",
        "gp-device-select",
        "monitorGhostingCanvas",
        "pixel-test-overlay",
    ):
        assert expected_id in resp.text, f"Missing UI element ID {expected_id}"

    for mod in expected_modules:
        assert mod in resp.text
        js_resp = client.get(mod)
        assert js_resp.status_code == 200, f"Failed to load {mod}"


def test_game_booster_no_hardcoded_personal_paths_and_supports_custom_config(tmp_path):
    src = (ROOT / "core" / "game_booster.py").read_text(encoding="utf-8")
    for personal_token in ("TheWitcher3", "Zero to Apex", "ghost in the sql data.exe", "UFC3Native"):
        assert personal_token not in src

    custom_dir = tmp_path / "CustomGameFolder"
    game_dir = custom_dir / "My Indie Game"
    game_dir.mkdir(parents=True)
    (game_dir / "indie_hero.exe").write_bytes(b"")

    cfg_file = tmp_path / "custom_games.json"
    cfg_file.write_text(
        f'{{"folders": ["{str(custom_dir).replace(chr(92), chr(92)*2)}"], "games": {{"indie_hero.exe": "Indie Hero Custom"}}}}',
        encoding="utf-8",
    )

    with patch.object(game_booster, "CUSTOM_GAMES_FILE", cfg_file):
        discovered = game_booster.discover_installed_games()
        assert discovered.get("indie_hero.exe") == "Indie Hero Custom"


def test_benchmark_cpu_worker_runs_cleanly():
    ops = benchmark._cpu_worker(0.05)
    assert ops > 0
