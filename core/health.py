import ctypes
import json
import os
import platform
import shutil
import subprocess
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import psutil

# State for calculating real-time I/O rates
_last_io_time: float = 0.0
_last_net_io = None
_last_disk_io = None

# Cache for hardware specs & SMART status (expensive WMI calls)
_hw_cache: Optional[Dict[str, Any]] = None
_hw_cache_lock = threading.Lock()
_gpu_live_cache: Dict[str, Any] = {"load": None, "temp": None, "mem_used_mb": None, "mem_total_mb": None, "last_check": 0.0}


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def is_link_or_junction(entry: "os.DirEntry") -> bool:
    """True for symlinks and NTFS junctions. DirEntry.is_dir(follow_symlinks=False) is True for
    junctions, so walking or deleting through one would reach files outside the folder."""
    try:
        if entry.is_symlink():
            return True
        is_junction = getattr(entry, "is_junction", None)
        if is_junction is not None:
            return bool(is_junction())
        return os.path.isjunction(entry.path) if hasattr(os.path, "isjunction") else False
    except OSError:
        return True


def format_bytes(size: float) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(size) < 1024.0:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024.0
    return f"{size:.1f} PB"


def get_uptime_info() -> Dict[str, Any]:
    boot_ts = psutil.boot_time()
    uptime_sec = int(time.time() - boot_ts)
    days = uptime_sec // 86400
    hours = (uptime_sec % 86400) // 3600
    minutes = (uptime_sec % 3600) // 60
    if days > 0:
        formatted = f"{days}d {hours}h {minutes}m"
    elif hours > 0:
        formatted = f"{hours}h {minutes}m"
    else:
        formatted = f"{minutes}m"
    return {
        "seconds": uptime_sec,
        "days": days,
        "hours": hours,
        "minutes": minutes,
        "formatted": formatted,
        "boot_time": datetime.fromtimestamp(boot_ts).strftime("%d/%m/%Y %H:%M"),
    }


def _query_nvidia_gpu() -> Dict[str, Any]:
    now = time.time()
    if now - _gpu_live_cache["last_check"] < 3.0:
        return _gpu_live_cache
    _gpu_live_cache["last_check"] = now
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return _gpu_live_cache
    try:
        res = subprocess.run(
            [
                nvidia_smi,
                "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=1.5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and res.stdout.strip():
            line = res.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 5:
                _gpu_live_cache["load"] = float(parts[0]) if parts[0].replace(".", "").isdigit() else None
                _gpu_live_cache["temp"] = float(parts[1]) if parts[1].replace(".", "").isdigit() else None
                _gpu_live_cache["mem_used_mb"] = float(parts[2]) if parts[2].replace(".", "").isdigit() else None
                _gpu_live_cache["mem_total_mb"] = float(parts[3]) if parts[3].replace(".", "").isdigit() else None
                _gpu_live_cache["name"] = parts[4]
    except Exception:
        pass
    return _gpu_live_cache


def get_disks_info() -> List[Dict[str, Any]]:
    disks = []
    seen_mounts = set()
    for part in psutil.disk_partitions(all=False):
        if "cdrom" in part.opts or not part.fstype:
            continue
        if part.mountpoint in seen_mounts:
            continue
        seen_mounts.add(part.mountpoint)
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disks.append(
                {
                    "device": part.device,
                    "mountpoint": part.mountpoint,
                    "fstype": part.fstype,
                    "total_bytes": usage.total,
                    "used_bytes": usage.used,
                    "free_bytes": usage.free,
                    "total_gb": round(usage.total / (1024**3), 1),
                    "used_gb": round(usage.used / (1024**3), 1),
                    "free_gb": round(usage.free / (1024**3), 1),
                    "percent": usage.percent,
                }
            )
        except Exception:
            continue
    return disks


def get_realtime_metrics() -> Dict[str, Any]:
    global _last_io_time, _last_net_io, _last_disk_io

    # CPU
    cpu_percent = psutil.cpu_percent(interval=None)
    cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
    cpu_freq = psutil.cpu_freq()
    freq_mhz = round(cpu_freq.current, 0) if cpu_freq else 0
    freq_max_mhz = round(cpu_freq.max, 0) if cpu_freq and cpu_freq.max else freq_mhz

    # Memory
    vm = psutil.virtual_memory()
    swap = psutil.swap_memory()

    # I/O Rates (Network & Disk)
    now = time.time()
    net_io = psutil.net_io_counters()
    try:
        disk_io = psutil.disk_io_counters()
    except Exception:
        disk_io = None

    dt = now - _last_io_time if _last_io_time > 0 else 1.0
    if dt <= 0:
        dt = 1.0

    if _last_net_io is not None:
        net_down_bps = max(0.0, (net_io.bytes_recv - _last_net_io.bytes_recv) / dt)
        net_up_bps = max(0.0, (net_io.bytes_sent - _last_net_io.bytes_sent) / dt)
    else:
        net_down_bps = 0.0
        net_up_bps = 0.0

    if _last_disk_io is not None and disk_io is not None:
        disk_read_bps = max(0.0, (disk_io.read_bytes - _last_disk_io.read_bytes) / dt)
        disk_write_bps = max(0.0, (disk_io.write_bytes - _last_disk_io.write_bytes) / dt)
    else:
        disk_read_bps = 0.0
        disk_write_bps = 0.0

    _last_io_time = now
    _last_net_io = net_io
    _last_disk_io = disk_io

    # Disks & Uptime
    disks = get_disks_info()
    uptime = get_uptime_info()

    # Battery
    battery_info = None
    try:
        bat = psutil.sensors_battery()
        if bat is not None:
            battery_info = {
                "percent": round(bat.percent, 0),
                "power_plugged": bool(bat.power_plugged),
                "secsleft": bat.secsleft if bat.secsleft not in (psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN) else None,
            }
    except Exception:
        pass

    # GPU live metrics (if available)
    gpu_live = _query_nvidia_gpu()

    # Calculate Health Score & Alerts
    alerts: List[Dict[str, str]] = []
    score = 100

    # Check RAM
    if vm.percent >= 90:
        score -= 22
        alerts.append({
            "level": "critical",
            "title": "Memória RAM Crítica",
            "message": f"O uso de RAM está em {vm.percent:.0f}%. Use o Otimizador de RAM ou encerre processos pesados."
        })
    elif vm.percent >= 78:
        score -= 10
        alerts.append({
            "level": "warning",
            "title": "Uso Elevado de Memória RAM",
            "message": f"Sua RAM está em {vm.percent:.0f}% ({round(vm.used / (1024**3), 1)} GB em uso). Recomendado liberar memória ociosa."
        })

    # Check CPU
    if cpu_percent >= 90:
        score -= 18
        alerts.append({
            "level": "critical",
            "title": "Processador Sobrecarregado",
            "message": f"A CPU está operando a {cpu_percent:.0f}%. Verifique os processos vilões na aba Processos."
        })
    elif cpu_percent >= 75:
        score -= 8
        alerts.append({
            "level": "warning",
            "title": "Carga Alta de CPU",
            "message": f"O uso do processador está em {cpu_percent:.0f}%."
        })

    # Check Disks
    for d in disks:
        if d["percent"] >= 92:
            score -= 20
            alerts.append({
                "level": "critical",
                "title": f"Disco {d['mountpoint']} Quase Cheio ({d['percent']:.0f}%)",
                "message": f"Restam apenas {d['free_gb']} GB livres. Execute a Limpeza de Arquivos Inúteis e o Scanner de Arquivos Grandes."
            })
        elif d["percent"] >= 82:
            score -= 10
            alerts.append({
                "level": "warning",
                "title": f"Espaço Reduzido em {d['mountpoint']} ({d['percent']:.0f}%)",
                "message": f"Restam {d['free_gb']} GB livres no disco {d['mountpoint']}."
            })

    # Check Uptime
    if uptime["days"] >= 7:
        score -= 8
        alerts.append({
            "level": "info",
            "title": f"Computador Ligado há {uptime['days']} Dias",
            "message": "Reiniciar o Windows periodicamente ajuda a limpar caches de kernel e aplicar atualizações pendentes."
        })

    # Check SMART from cached hardware specs if available
    if _hw_cache and _hw_cache.get("physical_disks"):
        for pd in _hw_cache["physical_disks"]:
            health_st = str(pd.get("HealthStatus", "Healthy")).lower()
            if health_st not in ("healthy", "saudável", "ok", ""):
                score -= 25
                alerts.append({
                    "level": "critical",
                    "title": f"Alerta S.M.A.R.T. no Disco {pd.get('FriendlyName', '')}",
                    "message": f"O status físico reportado pelo disco é '{pd.get('HealthStatus')}'. Faça backup dos seus dados importantes!"
                })

    if not alerts:
        alerts.append({
            "level": "healthy",
            "title": "Sistema Operando em Ótimo Estado",
            "message": "Nenhum gargalo crítico de CPU, Memória ou Disco detectado no momento."
        })

    score = max(15, min(100, score))
    if score >= 85:
        health_label = "Excelente"
    elif score >= 70:
        health_label = "Bom"
    elif score >= 50:
        health_label = "Atenção"
    else:
        health_label = "Crítico"

    return {
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "is_admin": is_admin(),
        "health_score": score,
        "health_label": health_label,
        "alerts": alerts,
        "cpu": {
            "percent": round(cpu_percent, 1),
            "per_core": [round(x, 1) for x in cpu_per_core],
            "cores_physical": psutil.cpu_count(logical=False) or 1,
            "cores_logical": psutil.cpu_count(logical=True) or 1,
            "freq_mhz": freq_mhz,
            "freq_max_mhz": freq_max_mhz,
        },
        "ram": {
            "total_gb": round(vm.total / (1024**3), 1),
            "used_gb": round(vm.used / (1024**3), 1),
            "available_gb": round(vm.available / (1024**3), 1),
            "percent": round(vm.percent, 1),
            "swap_percent": round(swap.percent, 1),
            "swap_used_gb": round(swap.used / (1024**3), 1),
        },
        "io": {
            "disk_read_mbps": round(disk_read_bps / (1024 * 1024), 2),
            "disk_write_mbps": round(disk_write_bps / (1024 * 1024), 2),
            "net_down_kbps": round(net_down_bps / 1024, 1),
            "net_up_kbps": round(net_up_bps / 1024, 1),
            "net_total_recv_gb": round(net_io.bytes_recv / (1024**3), 2),
            "net_total_sent_gb": round(net_io.bytes_sent / (1024**3), 2),
        },
        "gpu": gpu_live,
        "disks": disks,
        "uptime": uptime,
        "battery": battery_info,
    }


def get_hardware_specs(force_refresh: bool = False) -> Dict[str, Any]:
    global _hw_cache
    with _hw_cache_lock:
        if _hw_cache is not None and not force_refresh:
            return _hw_cache

    ps_script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, L2CacheSize, L3CacheSize
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer, Product, SerialNumber
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1 SMBIOSBIOSVersion, Manufacturer, ReleaseDate
$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption, Version, BuildNumber, OSArchitecture, CSName, InstallDate
$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, VideoProcessor, CurrentHorizontalResolution, CurrentVerticalResolution)
$rams = @(Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel, Capacity, Speed, Manufacturer, PartNumber)
$pdisks = @(Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType, HealthStatus, OperationalStatus, Size)

[PSCustomObject]@{
    cpu = $cpu
    board = $board
    bios = $bios
    os = $os
    gpus = $gpus
    rams = $rams
    physical_disks = $pdisks
} | ConvertTo-Json -Depth 4 -Compress
"""
    specs: Dict[str, Any] = {
        "cpu": {
            "Name": platform.processor() or "Processador x64",
            "NumberOfCores": psutil.cpu_count(logical=False) or 1,
            "NumberOfLogicalProcessors": psutil.cpu_count(logical=True) or 1,
            "MaxClockSpeed": 0,
        },
        "board": {"Manufacturer": "N/A", "Product": "N/A"},
        "bios": {"SMBIOSBIOSVersion": "N/A"},
        "os": {
            "Caption": f"Windows {platform.release()}",
            "Version": platform.version(),
            "OSArchitecture": platform.machine(),
            "CSName": platform.node(),
        },
        "gpus": [],
        "rams": [],
        "physical_disks": [],
    }

    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and res.stdout.strip():
            raw = json.loads(res.stdout.strip())
            if raw.get("cpu"):
                specs["cpu"] = raw["cpu"]
            if raw.get("board"):
                specs["board"] = raw["board"]
            if raw.get("bios"):
                specs["bios"] = raw["bios"]
            if raw.get("os"):
                specs["os"] = raw["os"]
            if raw.get("gpus"):
                gpus = raw["gpus"] if isinstance(raw["gpus"], list) else [raw["gpus"]]
                for g in gpus:
                    ram_b = g.get("AdapterRAM") or 0
                    g["AdapterRAM_GB"] = round(int(ram_b) / (1024**3), 1) if ram_b else None
                specs["gpus"] = gpus
            if raw.get("rams"):
                rams = raw["rams"] if isinstance(raw["rams"], list) else [raw["rams"]]
                for r in rams:
                    cap = r.get("Capacity") or 0
                    r["Capacity_GB"] = round(int(cap) / (1024**3), 1) if cap else 0
                specs["rams"] = rams
            if raw.get("physical_disks"):
                pdisks = raw["physical_disks"] if isinstance(raw["physical_disks"], list) else [raw["physical_disks"]]
                for pd in pdisks:
                    sz = pd.get("Size") or 0
                    pd["Size_GB"] = round(int(sz) / (1024**3), 1) if sz else 0
                specs["physical_disks"] = pdisks
    except Exception:
        pass

    with _hw_cache_lock:
        _hw_cache = specs
    return specs
