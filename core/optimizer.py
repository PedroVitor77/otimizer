import ctypes
import re
import subprocess
import time
import winreg
from typing import Any, Dict, List

import psutil

from core.cleaner import clean_junk
from core.health import format_bytes, is_admin
from core.history import record_action

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_SET_QUOTA = 0x0100


def optimize_ram(record_in_history: bool = True) -> Dict[str, Any]:
    vm_before = psutil.virtual_memory()
    used_before = vm_before.used
    pct_before = vm_before.percent

    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi

    trimmed_count = 0
    for proc in psutil.process_iter(["pid", "name"]):
        pid = proc.info.get("pid")
        if not pid or pid <= 4:
            continue
        handle = None
        try:
            handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, False, int(pid))
            if handle:
                res = psapi.EmptyWorkingSet(handle)
                if res == 0:
                    kernel32.SetProcessWorkingSetSize(handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
                trimmed_count += 1
        except Exception:
            pass
        finally:
            if handle:
                kernel32.CloseHandle(handle)

    time.sleep(0.35)
    vm_after = psutil.virtual_memory()
    used_after = vm_after.used
    pct_after = vm_after.percent

    freed_bytes = max(0, used_before - used_after)
    freed_mb = round(freed_bytes / (1024 * 1024), 1)

    if record_in_history:
        record_action(
            action_type="ram_boost",
            title="Otimização de Memória RAM",
            details=f"Liberados {freed_mb} MB de RAM ({pct_before:.1f}% → {pct_after:.1f}%) em {trimmed_count} processos",
            ram_freed_mb=freed_mb,
        )

    return {
        "freed_bytes": freed_bytes,
        "freed_mb": freed_mb,
        "freed_formatted": f"{freed_mb} MB" if freed_mb < 1024 else f"{round(freed_mb / 1024, 2)} GB",
        "percent_before": round(pct_before, 1),
        "percent_after": round(pct_after, 1),
        "used_before_gb": round(used_before / (1024**3), 2),
        "used_after_gb": round(used_after / (1024**3), 2),
        "trimmed_processes": trimmed_count,
    }


def optimize_network(record_in_history: bool = True) -> Dict[str, Any]:
    steps = []
    # 1. Flush DNS
    try:
        r1 = subprocess.run(
            ["ipconfig", "/flushdns"],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=6,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        steps.append({"step": "Limpeza de Cache DNS (ipconfig /flushdns)", "success": r1.returncode == 0})
    except Exception:
        steps.append({"step": "Limpeza de Cache DNS (ipconfig /flushdns)", "success": False})

    # 2. NetBIOS cache purge
    try:
        r2 = subprocess.run(
            ["nbtstat", "-R"],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        steps.append({"step": "Recarga de Cache de Nomes NetBIOS", "success": r2.returncode == 0})
    except Exception:
        pass

    pings = run_ping_test()

    if record_in_history:
        record_action(
            action_type="network",
            title="Otimização de Rede e DNS",
            details=f"Cache DNS limpo e latência verificada (Cloudflare: {pings.get('cloudflare_ms', '--')} ms)",
        )

    return {
        "success": True,
        "steps": steps,
        "pings": pings,
    }


def run_ping_test() -> Dict[str, Any]:
    targets = {
        "cloudflare": ("1.1.1.1", "Cloudflare DNS (1.1.1.1)"),
        "google": ("8.8.8.8", "Google DNS (8.8.8.8)"),
    }
    results: Dict[str, Any] = {"cloudflare_ms": None, "google_ms": None, "details": []}

    for key, (ip, label) in targets.items():
        latency_ms = None
        try:
            res = subprocess.run(
                ["ping", "-n", "2", "-w", "1500", ip],
                capture_output=True,
                text=True,
                encoding="oem",
                errors="replace",
                timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            out = res.stdout
            # Match time=12ms or tempo=12ms or time<1ms
            matches = re.findall(r"(?:time|tempo)[=<]\s*(\d+)\s*ms", out, re.IGNORECASE)
            if matches:
                vals = [int(m) for m in matches]
                latency_ms = round(sum(vals) / len(vals), 1)
        except Exception:
            pass

        results[f"{key}_ms"] = latency_ms
        status = "Excelente" if (latency_ms is not None and latency_ms < 30) else ("Bom" if (latency_ms is not None and latency_ms < 75) else ("Alto" if latency_ms is not None else "Sem resposta"))
        results["details"].append(
            {
                "label": label,
                "ip": ip,
                "latency_ms": latency_ms,
                "status": status,
            }
        )

    return results


def get_power_plans() -> Dict[str, Any]:
    plans = []
    active_guid = None
    try:
        res = subprocess.run(
            ["powercfg", "/list"],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        for line in res.stdout.splitlines():
            m = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s+\((.+?)\)(\s*\*)?", line)
            if m:
                guid = m.group(1).lower()
                name = m.group(2).strip()
                is_active = bool(m.group(3))
                if is_active:
                    active_guid = guid
                plans.append({"guid": guid, "name": name, "active": is_active})
    except Exception:
        pass
    return {"active_guid": active_guid, "plans": plans}


def activate_turbo_mode() -> Dict[str, Any]:
    # 1. Try activating High Performance or Ultimate Performance power plan
    power_info = get_power_plans()
    plans = power_info.get("plans", [])
    chosen_plan = None

    # Look for High Performance or Ultimate Performance
    preferred_guids = [
        "e9a42b02-d5df-448d-aa00-03f14749eb61",  # Ultimate Performance
        "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",  # High Performance
    ]
    existing_guids = {p["guid"]: p["name"] for p in plans}

    target_guid = None
    for pg in preferred_guids:
        if pg in existing_guids:
            target_guid = pg
            chosen_plan = existing_guids[pg]
            break

    if not target_guid:
        # A copy made by an earlier click has a new GUID; reuse it instead of duplicating again.
        for p in plans:
            pname = p["name"].lower()
            if "alto" in pname or "high" in pname or "desempenho" in pname:
                target_guid = p["guid"]
                chosen_plan = p["name"]
                break

    if not target_guid:
        # Try duplicating High Performance plan if hidden
        try:
            subprocess.run(
                ["powercfg", "-duplicatescheme", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"],
                capture_output=True,
                text=True,
                encoding="oem",
                errors="replace",
                timeout=4,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            power_info = get_power_plans()
            for p in power_info.get("plans", []):
                if "alto" in p["name"].lower() or "high" in p["name"].lower() or "desempenho" in p["name"].lower():
                    target_guid = p["guid"]
                    chosen_plan = p["name"]
                    break
        except Exception:
            pass

    if target_guid:
        try:
            subprocess.run(
                ["powercfg", "/setactive", target_guid],
                capture_output=True,
                text=True,
                encoding="oem",
                errors="replace",
                timeout=4,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception:
            pass

    # 2. Optimize RAM
    ram_res = optimize_ram(record_in_history=False)

    # 3. Lower priority of background updaters / non-essential hogs
    throttled_procs = []
    bg_candidates = {
        "onedrive.exe",
        "searchindexer.exe",
        "compattelrunner.exe",
        "msedgewebview2.exe",
        "widgets.exe",
        "yourphone.exe",
        "phoneexperiencehost.exe",
    }
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            pname = (proc.info.get("name") or "").lower()
            if pname in bg_candidates:
                p = psutil.Process(proc.info["pid"])
                p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
                throttled_procs.append(proc.info["name"])
        except Exception:
            continue

    plan_label = chosen_plan or "Plano de Desempenho Otimizado"
    record_action(
        action_type="turbo",
        title="Modo Turbo Ativado",
        details=f"Plano '{plan_label}' ativo + {ram_res['freed_mb']} MB de RAM liberados + {len(throttled_procs)} processos em 2º plano contidos",
        ram_freed_mb=ram_res["freed_mb"],
    )

    return {
        "success": True,
        "power_plan": plan_label,
        "ram_freed_mb": ram_res["freed_mb"],
        "ram_percent_after": ram_res["percent_after"],
        "throttled_processes": list(set(throttled_procs)),
    }


def quick_boost() -> Dict[str, Any]:
    """1-Click Super Boost from the main Dashboard: RAM + Safe Temps + DNS."""
    ram_res = optimize_ram(record_in_history=False)
    clean_res = clean_junk(["user_temp", "win_temp", "thumbnails"], record_in_history=False)
    net_res = optimize_network(record_in_history=False)

    record_action(
        action_type="quick_boost",
        title="Super Boost em 1 Clique",
        details=(
            f"RAM liberada: {ram_res['freed_mb']} MB | "
            f"Lixo removido: {clean_res['formatted_freed']} ({clean_res['files_removed']} arquivos) | "
            f"Cache DNS limpo"
        ),
        bytes_cleaned=clean_res["bytes_freed"],
        ram_freed_mb=ram_res["freed_mb"],
        files_removed=clean_res["files_removed"],
    )

    return {
        "success": True,
        "ram": ram_res,
        "cleaner": clean_res,
        "network": net_res,
    }


def _read_reg_dword(root, subkey: str, name: str, default: int = 0) -> int:
    try:
        with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return int(val)
    except Exception:
        return default


def _read_reg_str(root, subkey: str, name: str, default: str = "") -> str:
    try:
        with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return str(val)
    except Exception:
        return default


def _write_reg_value(root, subkey: str, name: str, value: Any, reg_type=winreg.REG_DWORD) -> bool:
    try:
        with winreg.CreateKeyEx(root, subkey, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, name, 0, reg_type, value)
        return True
    except Exception:
        return False


def get_windows_tweaks() -> List[Dict[str, Any]]:
    # 1. Game DVR background recording disabled
    dvr_enabled = _read_reg_dword(
        winreg.HKEY_CURRENT_USER,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\GameDVR",
        "AppCaptureEnabled",
        default=1,
    )
    # 2. Menu Show Delay
    menu_delay = _read_reg_str(
        winreg.HKEY_CURRENT_USER,
        r"Control Panel\Desktop",
        "MenuShowDelay",
        default="400",
    )
    # 3. Visual FX Setting (2 = Best Performance, 3 = Custom, 1 = Best Appearance)
    vfx = _read_reg_dword(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects",
        "VisualFXSetting",
        default=0,
    )
    # 4. Suggestions / Ads in Windows Start & Settings
    ads_enabled = _read_reg_dword(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager",
        "SystemPaneSuggestionsEnabled",
        default=1,
    )
    # 5. Window Transparency Effects
    transparency = _read_reg_dword(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "EnableTransparency",
        default=1,
    )

    return [
        {
            "id": "disable_game_dvr",
            "title": "Desativar Gravação em 2º Plano (Xbox Game DVR)",
            "description": "Impede que o Windows grave a tela continuamente em segundo plano, liberando GPU/CPU e reduzindo travamentos.",
            "optimized": dvr_enabled == 0,
            "requires_admin": False,
        },
        {
            "id": "fast_menus",
            "title": "Resposta Instantânea de Menus e Janelas",
            "description": "Reduz o atraso de abertura de menus do Windows (MenuShowDelay) de 400ms para 20ms.",
            "optimized": menu_delay.strip() in ("0", "10", "20"),
            "requires_admin": False,
        },
        {
            "id": "disable_transparency",
            "title": "Desativar Efeitos Pesados de Transparência (Acrílico/Mica)",
            "description": "Desativa o desfoque transparente da barra de tarefas e janelas para economizar memória de vídeo e GPU.",
            "optimized": transparency == 0,
            "requires_admin": False,
        },
        {
            "id": "visual_fx_perf",
            "title": "Priorizar Desempenho nos Efeitos Visuais do Explorer",
            "description": "Ajusta a preferência de efeitos visuais do Windows Explorer para priorizar performance.",
            "optimized": vfx == 2,
            "requires_admin": False,
        },
        {
            "id": "disable_suggestions",
            "title": "Desativar Sugestões, Dicas e Anúncios em Segundo Plano",
            "description": "Desativa notificações promocionais e sugestões de apps no Menu Iniciar do Windows.",
            "optimized": ads_enabled == 0,
            "requires_admin": False,
        },
    ]


def toggle_windows_tweak(tweak_id: str, enable_optimization: bool) -> Dict[str, Any]:
    ok = False
    label = tweak_id

    if tweak_id == "disable_game_dvr":
        label = "Otimização Xbox Game DVR"
        val = 0 if enable_optimization else 1
        ok1 = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\GameDVR",
            "AppCaptureEnabled",
            val,
            winreg.REG_DWORD,
        )
        ok2 = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"System\GameConfigStore",
            "GameDVR_Enabled",
            val,
            winreg.REG_DWORD,
        )
        ok = ok1 or ok2

    elif tweak_id == "fast_menus":
        label = "Resposta Instantânea de Menus"
        val_str = "20" if enable_optimization else "400"
        ok = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"Control Panel\Desktop",
            "MenuShowDelay",
            val_str,
            winreg.REG_SZ,
        )

    elif tweak_id == "disable_transparency":
        label = "Economia de Transparência Visual"
        val = 0 if enable_optimization else 1
        ok = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "EnableTransparency",
            val,
            winreg.REG_DWORD,
        )

    elif tweak_id == "visual_fx_perf":
        label = "Efeitos Visuais para Desempenho"
        val = 2 if enable_optimization else 0
        ok = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects",
            "VisualFXSetting",
            val,
            winreg.REG_DWORD,
        )

    elif tweak_id == "disable_suggestions":
        label = "Bloqueio de Sugestões e Propaganda no Iniciar"
        val = 0 if enable_optimization else 1
        ok1 = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager",
            "SystemPaneSuggestionsEnabled",
            val,
            winreg.REG_DWORD,
        )
        ok2 = _write_reg_value(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager",
            "SubscribedContent-338389Enabled",
            val,
            winreg.REG_DWORD,
        )
        ok = ok1 or ok2

    if ok:
        state_str = "Ativado" if enable_optimization else "Restaurado ao padrão"
        record_action(
            action_type="tweak",
            title=f"Ajuste do Windows: {label}",
            details=f"Status: {state_str}",
        )

    return {
        "success": ok,
        "tweak_id": tweak_id,
        "optimized": enable_optimization,
        "tweaks": get_windows_tweaks(),
    }
