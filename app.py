import ctypes
import os
from pathlib import Path
import socket
import sys
import threading
import time
from typing import Any, Dict, List, Optional
import webbrowser

if getattr(sys, "frozen", False):
    BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    local_app = os.environ.get("LOCALAPPDATA")
    LOG_DIR = Path(local_app) / "PulsePC" / "data" if local_app else Path(sys.executable).parent / "data"
else:
    BASE_DIR = Path(__file__).resolve().parent
    LOG_DIR = BASE_DIR / "data"

UI_DIR = BASE_DIR / "ui"
ICON_PATH = BASE_DIR / "assets" / "pulsepc.ico"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Hide console window if launched via python.exe directly, and set AppUserModelID for custom Taskbar icon
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("PulsePC.Otimizador.Pro.1")
    hwnd_console = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd_console:
        ctypes.windll.user32.ShowWindow(hwnd_console, 0)  # SW_HIDE = 0
except Exception:
    pass

# Fix for pythonw.exe where sys.stdout / sys.stderr are None (causes uvicorn to crash)
if sys.stdout is None:
    sys.stdout = open(LOG_DIR / "app.log", "a", encoding="utf-8", buffering=1)
if sys.stderr is None:
    sys.stderr = open(LOG_DIR / "app.log", "a", encoding="utf-8", buffering=1)

from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import psutil
import uvicorn

from core.cleaner import clean_junk, scan_junk, clean_inactive_node_modules, scan_inactive_node_modules
from core.health import format_bytes, get_hardware_specs, get_realtime_metrics, is_admin
from core.games import catalog as games_catalog, estimate_all as estimate_games
from core.history import load_history
from core.jobs import cancel_job, get_job, start_job
from core.manager import (
    clean_app_leftovers,
    create_restore_point,
    get_installed_programs,
    get_processes,
    get_startup_items,
    kill_process,
    launch_uninstaller,
    run_repair_tool,
    scan_app_leftovers,
    toggle_startup_item,
)
from core.optimizer import (
    activate_turbo_mode,
    get_power_plans,
    get_windows_tweaks,
    optimize_network,
    optimize_ram,
    purge_standby_list,
    quick_boost,
    run_ping_test,
    toggle_windows_tweak,
)
from core.game_booster import booster, KNOWN_GAMES
from core.benchmark import benchmark_runner
from core.scanner import (
    get_scan_presets,
    open_in_explorer,
    remove_files_safe,
    scan_duplicates,
    scan_large_files,
)
from core.updater import (
    apply_update,
    check_for_updates,
    get_download_status,
    start_download_update,
)

# Warm up psutil CPU percent so first call isn't 0.0
psutil.cpu_percent(interval=None)
psutil.cpu_percent(interval=None, percpu=True)

app = FastAPI(title="PulsePC Otimizador Pro", version="1.3.4")

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost"}


@app.middleware("http")
async def only_local_ui(request: Request, call_next):
    """Block other websites (and DNS rebinding) from driving the API.

    The UI is served from this same server, so its requests are same-origin. A page on any
    other site open in the user's browser could otherwise POST to 127.0.0.1 and delete files,
    kill processes or launch commands.
    """
    if request.url.path.startswith("/api/"):
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in LOCAL_HOSTNAMES:
            return JSONResponse({"detail": "Host não permitido."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != "null":
            if urlsplit(origin).netloc.lower() != (request.headers.get("host") or "").lower():
                return JSONResponse({"detail": "Origem não permitida."}, status_code=403)
        elif origin == "null" or request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Origem não permitida."}, status_code=403)
    return await call_next(request)

app.mount("/static", StaticFiles(directory=str(UI_DIR)), name="static")


# --- Request Models ---
class CleanJunkRequest(BaseModel):
    categories: List[str]


class LargeFilesScanRequest(BaseModel):
    target_path: Optional[str] = None
    min_size_mb: int = 100
    category_filter: Optional[str] = "all"


class FileActionRequest(BaseModel):
    path: str


class RemoveFilesRequest(BaseModel):
    paths: List[str]
    permanent: bool = False


class DuplicatesScanRequest(BaseModel):
    target_path: Optional[str] = None
    min_size_kb: int = 100


class TweakToggleRequest(BaseModel):
    tweak_id: str
    enable: bool


class KillProcessRequest(BaseModel):
    pid: int


class StartupToggleRequest(BaseModel):
    item_id: str
    enable: bool


class UninstallRequest(BaseModel):
    uninstall_string: str
    app_name: str = ""


class RestorePointRequest(BaseModel):
    description: str = "PulsePC Otimizador - Ponto de Segurança"


class RepairToolRequest(BaseModel):
    tool_id: str


class GamesEstimateRequest(BaseModel):
    gpu: Optional[str] = None
    cpu: Optional[str] = None
    ram_gb: Optional[float] = None
    resolution: str = "1080p"
    preset: str = "high"


class UpdateDownloadRequest(BaseModel):
    download_url: str


class GameBoosterToggleRequest(BaseModel):
    enabled: bool


class GameBoosterBoostRequest(BaseModel):
    pid: int
    title: Optional[str] = None


class LeftoversScanRequest(BaseModel):
    app_name: str
    publisher: Optional[str] = ""


class LeftoversCleanRequest(BaseModel):
    folders: List[str] = []
    files: List[str] = []
    registry_keys: List[Dict[str, str]] = []
    app_name: str = ""


class NodeModulesCleanRequest(BaseModel):
    paths: List[str]


# --- Routes ---
@app.get("/")
def serve_index():
    return FileResponse(str(UI_DIR / "index.html"))


@app.get("/api/metrics")
def api_metrics():
    return get_realtime_metrics()


@app.get("/api/battery/report")
def api_battery_report(force: bool = False):
    from core.battery import get_battery_report
    return get_battery_report(force_refresh=force)


@app.post("/api/battery/generate-html")
def api_battery_generate_html():
    from core.battery import generate_battery_html_report
    return generate_battery_html_report()


@app.get("/api/hardware")
def api_hardware(refresh: bool = False):
    return get_hardware_specs(force_refresh=refresh)


@app.get("/api/history")
def api_history():
    h = load_history()
    h["total_bytes_formatted"] = format_bytes(h.get("total_bytes_cleaned", 0))
    return h


@app.get("/api/updater/check")
def api_updater_check():
    return check_for_updates()


@app.post("/api/updater/download")
def api_updater_download(req: UpdateDownloadRequest):
    return start_download_update(req.download_url)


@app.get("/api/updater/status")
def api_updater_status():
    return get_download_status()


@app.post("/api/updater/apply")
def api_updater_apply():
    return apply_update()


@app.post("/api/quick-boost")
def api_quick_boost():
    return quick_boost()


@app.get("/api/cleaner/scan")
def api_cleaner_scan():
    return scan_junk()


@app.post("/api/cleaner/clean")
def api_cleaner_clean(req: CleanJunkRequest):
    return clean_junk(req.categories)


@app.get("/api/scanner/presets")
def api_scanner_presets():
    return {"presets": get_scan_presets()}


@app.post("/api/scanner/large-files")
def api_scanner_large_files(req: LargeFilesScanRequest):
    return scan_large_files(
        target_path=req.target_path,
        min_size_mb=req.min_size_mb,
        category_filter=req.category_filter,
    )


@app.post("/api/scanner/open-explorer")
def api_open_explorer(req: FileActionRequest):
    return open_in_explorer(req.path)


@app.post("/api/scanner/remove-files")
def api_remove_files(req: RemoveFilesRequest):
    return remove_files_safe(req.paths, permanent=req.permanent)


@app.post("/api/scanner/duplicates")
def api_scanner_duplicates(req: DuplicatesScanRequest):
    return scan_duplicates(target_path=req.target_path, min_size_kb=req.min_size_kb)


# --- Background scans (progress + cancel) ---
@app.post("/api/jobs/cleaner-scan")
def api_job_cleaner_scan():
    return start_job("cleaner_scan", scan_junk).to_dict()


@app.post("/api/jobs/large-files")
def api_job_large_files(req: LargeFilesScanRequest):
    return start_job(
        "large_files",
        scan_large_files,
        target_path=req.target_path,
        min_size_mb=req.min_size_mb,
        category_filter=req.category_filter,
    ).to_dict()


@app.post("/api/jobs/duplicates")
def api_job_duplicates(req: DuplicatesScanRequest):
    return start_job(
        "duplicates", scan_duplicates, target_path=req.target_path, min_size_kb=req.min_size_kb
    ).to_dict()


@app.get("/api/jobs/{job_id}")
def api_job_status(job_id: str):
    job = get_job(job_id)
    if not job:
        return JSONResponse({"detail": "Tarefa não encontrada."}, status_code=404)
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def api_job_cancel(job_id: str):
    job = cancel_job(job_id)
    if not job:
        return JSONResponse({"detail": "Tarefa não encontrada."}, status_code=404)
    return job.to_dict()


@app.post("/api/optimizer/ram")
def api_optimize_ram():
    return optimize_ram()


@app.post("/api/optimizer/standby")
def api_purge_standby():
    return purge_standby_list()


@app.post("/api/optimizer/turbo")
def api_activate_turbo():
    return activate_turbo_mode()


@app.get("/api/game-booster/status")
def api_game_booster_status():
    return booster.get_status()


@app.post("/api/game-booster/toggle")
def api_game_booster_toggle(req: GameBoosterToggleRequest):
    return booster.set_enabled(req.enabled)


@app.post("/api/game-booster/boost-now")
def api_game_booster_boost_now(req: GameBoosterBoostRequest):
    return booster.boost_process(req.pid, req.title)


@app.get("/api/game-booster/running-candidates")
def api_game_booster_candidates():
    candidates = []
    for proc in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            pname = (proc.info.get("name") or "").lower()
            if pname in ("idle", "system", "registry", "smss.exe", "csrss.exe", "wininit.exe"):
                continue
            is_game = pname in KNOWN_GAMES
            mem = proc.info.get("memory_info")
            ram_mb = round((mem.rss if mem else 0) / (1024 * 1024), 1)
            if is_game or ram_mb >= 250:
                candidates.append({
                    "pid": proc.info["pid"],
                    "name": KNOWN_GAMES.get(pname, proc.info["name"]),
                    "exe_name": proc.info["name"],
                    "ram_mb": ram_mb,
                    "is_known_game": is_game,
                })
        except Exception:
            continue
    candidates.sort(key=lambda x: (not x["is_known_game"], -x["ram_mb"]))
    return {"candidates": candidates[:20]}


@app.post("/api/benchmark/start")
def api_benchmark_start():
    return benchmark_runner.start()


@app.get("/api/benchmark/status")
def api_benchmark_status():
    return benchmark_runner.get_status()


@app.get("/api/benchmark/history")
def api_benchmark_history():
    return benchmark_runner.load_data()


@app.post("/api/optimizer/network")
def api_optimize_network():
    return optimize_network()


@app.get("/api/optimizer/ping")
def api_ping():
    return run_ping_test()


@app.get("/api/optimizer/tweaks")
def api_get_tweaks():
    return {"tweaks": get_windows_tweaks(), "power": get_power_plans()}


@app.post("/api/optimizer/tweaks")
def api_toggle_tweak(req: TweakToggleRequest):
    return toggle_windows_tweak(req.tweak_id, req.enable)


@app.get("/api/manager/processes")
def api_get_processes(sort_by: str = "ram"):
    return get_processes(sort_by=sort_by)


@app.post("/api/manager/kill-process")
def api_kill_process(req: KillProcessRequest):
    return kill_process(req.pid)


@app.get("/api/manager/startup")
def api_get_startup():
    return {"items": get_startup_items(), "is_admin": is_admin()}


@app.post("/api/manager/startup")
def api_toggle_startup(req: StartupToggleRequest):
    return toggle_startup_item(req.item_id, req.enable)


@app.get("/api/manager/programs")
def api_get_programs():
    return {"programs": get_installed_programs()}


@app.post("/api/manager/uninstall")
def api_uninstall_program(req: UninstallRequest):
    return launch_uninstaller(req.uninstall_string, req.app_name)


@app.post("/api/manager/leftovers/scan")
def api_scan_leftovers(req: LeftoversScanRequest):
    return scan_app_leftovers(req.app_name, req.publisher)


@app.post("/api/manager/leftovers/clean")
def api_clean_leftovers(req: LeftoversCleanRequest):
    return clean_app_leftovers(req.folders, req.files, req.registry_keys, req.app_name)


@app.get("/api/cleaner/dev/node-modules")
def api_scan_node_modules(days_inactive: int = 30):
    return scan_inactive_node_modules(days_inactive=days_inactive)


@app.post("/api/cleaner/dev/node-modules/clean")
def api_clean_node_modules(req: NodeModulesCleanRequest):
    return clean_inactive_node_modules(req.paths)


@app.post("/api/repair/restore-point")
def api_create_restore_point(req: RestorePointRequest):
    return create_restore_point(req.description)


@app.post("/api/repair/run-tool")
def api_run_repair_tool(req: RepairToolRequest):
    return run_repair_tool(req.tool_id)


@app.get("/api/games/catalog")
def api_games_catalog():
    return games_catalog()


@app.post("/api/games/estimate")
def api_games_estimate(req: GamesEstimateRequest):
    return estimate_games(req.gpu, req.cpu, req.ram_gb, req.resolution, req.preset)


@app.post("/api/elevate")
def api_elevate():
    if is_admin():
        return {"success": True, "message": "O programa já está sendo executado como Administrador."}
    try:
        if getattr(sys, "frozen", False):
            exe_path = sys.executable
            res = ctypes.windll.shell32.ShellExecuteW(None, "runas", str(exe_path), "", str(Path(exe_path).parent), 1)
        else:
            exe_launcher = BASE_DIR / "PulsePC.exe"
            if exe_launcher.exists():
                res = ctypes.windll.shell32.ShellExecuteW(None, "runas", str(exe_launcher), "", str(BASE_DIR), 1)
            else:
                pyw = Path(sys.executable).with_name("pythonw.exe")
                target_py = str(pyw) if pyw.exists() else sys.executable
                script_path = os.path.abspath(__file__)
                params = f'"{script_path}"'
                res = ctypes.windll.shell32.ShellExecuteW(None, "runas", target_py, params, str(BASE_DIR), 1)
        if int(res) > 32:
            threading.Timer(0.8, lambda: os._exit(0)).start()
            return {"success": True, "message": "Reiniciando como Administrador..."}
        return {"success": False, "message": "Elevação cancelada pelo usuário."}
    except Exception as e:
        return {"success": False, "message": str(e)}


def find_free_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


def start_server(port: int):
    try:
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", log_config=None)
        server = uvicorn.Server(config)
        server.run()
    except Exception as e:
        import traceback
        with open(LOG_DIR / "app.log", "a", encoding="utf-8") as f:
            f.write(f"[ERRO SERVIDOR] {e}\n{traceback.format_exc()}\n")


def _set_win32_icon(window_title: str):
    if not ICON_PATH.exists():
        return
    try:
        user32 = ctypes.windll.user32
        IMAGE_ICON = 1
        LR_LOADFROMFILE = 0x0010
        LR_DEFAULTSIZE = 0x0040
        WM_SETICON = 0x0080
        ICON_SMALL = 0
        ICON_BIG = 1

        for _ in range(25):
            hwnd = user32.FindWindowW(None, window_title)
            if hwnd:
                hicon_big = user32.LoadImageW(None, str(ICON_PATH), IMAGE_ICON, 64, 64, LR_LOADFROMFILE)
                hicon_small = user32.LoadImageW(None, str(ICON_PATH), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
                if not hicon_big:
                    hicon_big = user32.LoadImageW(None, str(ICON_PATH), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
                if hicon_big:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
                if hicon_small:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
                break
            time.sleep(0.1)
    except Exception:
        pass


def _window_background() -> str:
    """Same color as the UI background, so the window doesn't flash another color while loading."""
    return "#070807"


def main():
    import urllib.request

    # Pre-warm hardware specs in a background thread so UI loads fast
    threading.Thread(target=get_hardware_specs, daemon=True).start()

    # Start background auto game detector
    booster.start()

    port = find_free_port(8765)
    url = f"http://127.0.0.1:{port}"

    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Wait until HTTP server actually responds with HTTP 200 before opening window
    server_ready = False
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"{url}/api/history", timeout=0.5) as resp:
                if resp.status == 200:
                    server_ready = True
                    break
        except Exception:
            time.sleep(0.1)

    print(f"Servidor PulsePC iniciado em: {url} (pronto={server_ready})", flush=True)

    use_browser_only = "--browser" in sys.argv
    if not use_browser_only:
        try:
            import webview

            win_title = "PulsePC - Diagnostico de Saude e Otimizador Pro"
            window = webview.create_window(
                title=win_title,
                url=url,
                width=1340,
                height=860,
                min_size=(1024, 700),
                background_color=_window_background(),
                text_select=False,
            )
            window.events.shown += lambda: threading.Thread(target=_set_win32_icon, args=(win_title,), daemon=True).start()
            webview.start(icon=str(ICON_PATH) if ICON_PATH.exists() else None)
            return
        except Exception as e:
            print(f"[Aviso] Nao foi possivel abrir janela nativa pywebview ({e}). Abrindo no navegador...")

    print(f"Abrindo PulsePC no navegador: {url}")
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
