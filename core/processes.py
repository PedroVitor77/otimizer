"""Running process inspection and safe termination."""

import os
from typing import Any, Dict, List

import psutil

from core.health import format_bytes
from core.history import record_action

CRITICAL_PROCESSES = {
    "system",
    "system idle process",
    "registry",
    "memory compression",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "lsm.exe",
    "svchost.exe",
    "winlogon.exe",
    "dwm.exe",
    "explorer.exe",
    "fontdrvhost.exe",
    "sihost.exe",
    "taskhostw.exe",
    "ctfmon.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "wudfhost.exe",
}


def get_processes(sort_by: str = "ram", limit: int = 80) -> Dict[str, Any]:
    my_pid = os.getpid()
    procs: List[Dict[str, Any]] = []
    hogs_count = 0

    for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "memory_percent", "status", "username"]):
        try:
            info = p.info
            pid = info["pid"]
            if pid == 0:
                continue
            name = info.get("name") or f"PID {pid}"
            name_lower = name.lower()
            mem_info = info.get("memory_info")
            ram_bytes = mem_info.rss if mem_info else 0
            ram_mb = round(ram_bytes / (1024 * 1024), 1)
            ram_pct = round(info.get("memory_percent") or 0.0, 1)

            # Divide cpu_percent by logical cores so it matches Task Manager 0-100% scale
            raw_cpu = info.get("cpu_percent") or 0.0
            cores = psutil.cpu_count(logical=True) or 1
            cpu_pct = round(min(100.0, raw_cpu / cores), 1)

            is_critical = (name_lower in CRITICAL_PROCESSES) or (pid <= 4) or (pid == my_pid)
            is_hog = (ram_mb >= 450 or cpu_pct >= 15.0) and not is_critical
            if is_hog:
                hogs_count += 1

            procs.append(
                {
                    "pid": pid,
                    "name": name,
                    "cpu_percent": cpu_pct,
                    "ram_bytes": ram_bytes,
                    "ram_mb": ram_mb,
                    "ram_formatted": format_bytes(ram_bytes),
                    "ram_percent": ram_pct,
                    "status": info.get("status") or "running",
                    "protected": is_critical,
                    "is_hog": is_hog,
                }
            )
        except Exception:
            continue

    if sort_by == "cpu":
        procs.sort(key=lambda x: (x["cpu_percent"], x["ram_bytes"]), reverse=True)
    elif sort_by == "name":
        procs.sort(key=lambda x: x["name"].lower())
    else:
        procs.sort(key=lambda x: x["ram_bytes"], reverse=True)

    return {
        "total_processes": len(procs),
        "hogs_count": hogs_count,
        "processes": procs[:limit],
    }


def kill_process(pid: int) -> Dict[str, Any]:
    my_pid = os.getpid()
    if pid == my_pid or pid <= 4:
        return {"success": False, "message": "Este processo é protegido e não pode ser encerrado."}
    try:
        p = psutil.Process(pid)
        pname = p.name()
        if pname.lower() in CRITICAL_PROCESSES:
            return {"success": False, "message": f"O processo '{pname}' é vital para o Windows e foi bloqueado pela trava de segurança."}
        mem_before = p.memory_info().rss
        p.terminate()
        try:
            p.wait(timeout=2.0)
        except psutil.TimeoutExpired:
            p.kill()

        freed_mb = round(mem_before / (1024 * 1024), 1)
        record_action(
            action_type="process_kill",
            title=f"Processo Encerrado: {pname}",
            details=f"PID {pid} finalizado (~{freed_mb} MB liberados)",
            ram_freed_mb=freed_mb,
        )
        return {
            "success": True,
            "message": f"Processo '{pname}' (PID {pid}) encerrado com sucesso! (~{freed_mb} MB liberados)",
            "freed_mb": freed_mb,
        }
    except psutil.NoSuchProcess:
        return {"success": True, "message": "O processo já havia sido encerrado."}
    except psutil.AccessDenied:
        return {"success": False, "message": "Acesso negado pelo sistema. Execute o otimizador como Administrador para encerrar este processo."}
    except Exception as e:
        return {"success": False, "message": str(e)}
