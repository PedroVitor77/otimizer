import os
from pathlib import Path
import shutil
import subprocess
import winreg
from typing import Any, Dict, List

import psutil

from core.health import format_bytes, is_admin
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


# --- STARTUP MANAGER ---
RUN_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
DISABLED_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\RunDisabled_PulsePC"


def _read_reg_startup(root_key, root_name: str, key_path: str, enabled: bool) -> List[Dict[str, Any]]:
    items = []
    try:
        with winreg.OpenKey(root_key, key_path, 0, winreg.KEY_READ) as k:
            idx = 0
            while True:
                try:
                    name, val, _ = winreg.EnumValue(k, idx)
                    idx += 1
                    if not name:
                        continue
                    items.append(
                        {
                            "id": f"reg::{root_name}::{name}",
                            "name": name,
                            "command": str(val),
                            "location": f"Registro ({root_name})",
                            "source_type": "registry",
                            "hive": root_name,
                            "enabled": enabled,
                            "requires_admin": root_name == "HKLM",
                        }
                    )
                except OSError:
                    break
    except Exception:
        pass
    return items


def get_startup_items() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []

    # 1. Registry HKCU Active & Disabled
    items.extend(_read_reg_startup(winreg.HKEY_CURRENT_USER, "HKCU", RUN_KEY_PATH, True))
    items.extend(_read_reg_startup(winreg.HKEY_CURRENT_USER, "HKCU", DISABLED_KEY_PATH, False))

    # 2. Registry HKLM Active & Disabled
    items.extend(_read_reg_startup(winreg.HKEY_LOCAL_MACHINE, "HKLM", RUN_KEY_PATH, True))
    items.extend(_read_reg_startup(winreg.HKEY_LOCAL_MACHINE, "HKLM", DISABLED_KEY_PATH, False))

    # 3. User Startup Folder
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        startup_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        disabled_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "StartupDisabled_PulsePC"

        if startup_dir.exists():
            for f in startup_dir.iterdir():
                if f.name.lower() == "desktop.ini":
                    continue
                items.append(
                    {
                        "id": f"folder::user::{f.name}",
                        "name": f.stem,
                        "command": str(f),
                        "location": "Pasta Inicializar (Usuário)",
                        "source_type": "folder",
                        "hive": "USER_FOLDER",
                        "requires_admin": False,
                        "enabled": True,
                    }
                )
        if disabled_dir.exists():
            for f in disabled_dir.iterdir():
                if f.name.lower() == "desktop.ini":
                    continue
                items.append(
                    {
                        "id": f"folder::user::{f.name}",
                        "name": f.stem,
                        "command": str(f),
                        "location": "Pasta Inicializar (Usuário)",
                        "source_type": "folder",
                        "hive": "USER_FOLDER",
                        "requires_admin": False,
                        "enabled": False,
                    }
                )

    items.sort(key=lambda x: (not x["enabled"], x["name"].lower()))
    return items


def toggle_startup_item(item_id: str, enable: bool) -> Dict[str, Any]:
    parts = item_id.split("::", 2)
    if len(parts) != 3:
        return {"success": False, "message": "Identificador de item inválido."}

    kind, scope, name = parts

    if kind == "reg":
        root_key = winreg.HKEY_CURRENT_USER if scope == "HKCU" else winreg.HKEY_LOCAL_MACHINE
        src_path = DISABLED_KEY_PATH if enable else RUN_KEY_PATH
        dst_path = RUN_KEY_PATH if enable else DISABLED_KEY_PATH

        try:
            with winreg.OpenKey(root_key, src_path, 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as src_k:
                val, reg_type = winreg.QueryValueEx(src_k, name)
                with winreg.CreateKeyEx(root_key, dst_path, 0, winreg.KEY_SET_VALUE) as dst_k:
                    winreg.SetValueEx(dst_k, name, 0, reg_type, val)
                winreg.DeleteValue(src_k, name)

            action_lbl = "Ativado na Inicialização" if enable else "Desativado da Inicialização"
            record_action(
                action_type="startup",
                title=f"{action_lbl}: {name}",
                details=f"Local: Registro ({scope})",
            )
            return {
                "success": True,
                "message": f"'{name}' foi {'ativado' if enable else 'desativado'} na inicialização do Windows.",
                "items": get_startup_items(),
            }
        except PermissionError:
            return {
                "success": False,
                "message": "Permissão negada para alterar item do sistema (HKLM). Execute como Administrador.",
                "items": get_startup_items(),
            }
        except Exception as e:
            return {"success": False, "message": str(e), "items": get_startup_items()}

    elif kind == "folder":
        appdata = os.environ.get("APPDATA", "")
        startup_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        disabled_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "StartupDisabled_PulsePC"
        disabled_dir.mkdir(parents=True, exist_ok=True)

        src_file = (disabled_dir if enable else startup_dir) / name
        dst_file = (startup_dir if enable else disabled_dir) / name

        try:
            if src_file.exists():
                shutil.move(str(src_file), str(dst_file))
                record_action(
                    action_type="startup",
                    title=f"{'Ativado' if enable else 'Desativado'} na Inicialização: {name}",
                    details="Local: Pasta Startup",
                )
                return {
                    "success": True,
                    "message": f"'{name}' foi {'ativado' if enable else 'desativado'} com sucesso.",
                    "items": get_startup_items(),
                }
            return {"success": False, "message": "Arquivo de atalho não encontrado.", "items": get_startup_items()}
        except Exception as e:
            return {"success": False, "message": str(e), "items": get_startup_items()}

    return {"success": False, "message": "Tipo de inicialização não suportado."}


# --- INSTALLED PROGRAMS / BLOATWARE ---
def get_installed_programs() -> List[Dict[str, Any]]:
    uninstall_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    seen_names = set()
    programs: List[Dict[str, Any]] = []

    for root, subkey in uninstall_paths:
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as k:
                num_subkeys, _, _ = winreg.QueryInfoKey(k)
                for i in range(num_subkeys):
                    try:
                        sk_name = winreg.EnumKey(k, i)
                        with winreg.OpenKey(k, sk_name, 0, winreg.KEY_READ) as sk:
                            def _q(val_name, default=""):
                                try:
                                    v, _ = winreg.QueryValueEx(sk, val_name)
                                    return v
                                except Exception:
                                    return default

                            name = str(_q("DisplayName", "")).strip()
                            if not name or name in seen_names:
                                continue
                            system_comp = _q("SystemComponent", 0)
                            if system_comp == 1:
                                continue

                            uninstall_str = str(_q("UninstallString", "")).strip()
                            if not uninstall_str:
                                continue

                            seen_names.add(name)
                            publisher = str(_q("Publisher", "Desconhecido")).strip()
                            version = str(_q("DisplayVersion", "")).strip()
                            size_kb = _q("EstimatedSize", 0)
                            try:
                                size_bytes = int(size_kb) * 1024
                            except Exception:
                                size_bytes = 0

                            install_date = str(_q("InstallDate", "")).strip()
                            if len(install_date) == 8 and install_date.isdigit():
                                install_date = f"{install_date[6:8]}/{install_date[4:6]}/{install_date[0:4]}"

                            programs.append(
                                {
                                    "name": name,
                                    "publisher": publisher,
                                    "version": version,
                                    "size_bytes": size_bytes,
                                    "size_formatted": format_bytes(size_bytes) if size_bytes > 0 else "N/D",
                                    "install_date": install_date or "--",
                                    "uninstall_string": uninstall_str,
                                }
                            )
                    except Exception:
                        continue
        except Exception:
            continue

    programs.sort(key=lambda x: (x["size_bytes"], x["name"].lower()), reverse=True)
    return programs


def launch_uninstaller(uninstall_string: str, app_name: str = "") -> Dict[str, Any]:
    if not uninstall_string:
        return {"success": False, "message": "Comando de desinstalação vazio."}
    # Only run commands that the Windows registry actually lists as an uninstaller,
    # never an arbitrary string sent by the client.
    known = {p["uninstall_string"] for p in get_installed_programs()}
    if uninstall_string not in known:
        return {"success": False, "message": "Desinstalador não encontrado no registro do Windows. Atualize a lista e tente de novo."}
    try:
        subprocess.Popen(uninstall_string, shell=True)
        record_action(
            action_type="uninstall",
            title=f"Desinstalador Iniciado: {app_name}",
            details="O assistente oficial de desinstalação foi aberto.",
        )
        return {
            "success": True,
            "message": f"O desinstalador de '{app_name}' foi iniciado! Siga as instruções na janela que se abriu.",
        }
    except Exception as e:
        return {"success": False, "message": f"Erro ao abrir desinstalador: {str(e)}"}


# --- SYSTEM REPAIR & RESTORE POINT ---
def create_restore_point(description: str = "PulsePC Otimizador - Ponto de Segurança") -> Dict[str, Any]:
    if not is_admin():
        return {
            "success": False,
            "message": "Criar um Ponto de Restauração exige privilégios de Administrador. Abra o programa pelo atalho 'Iniciar como Administrador'.",
        }
    safe_desc = description.replace('"', "").replace("'", "")[:60] or "PulsePC Ponto de Restauracao"
    ps_cmd = (
        f"Enable-ComputerRestore -Drive 'C:\\' -ErrorAction SilentlyContinue; "
        f"Checkpoint-Computer -Description '{safe_desc}' -RestorePointType 'MODIFY_SETTINGS'"
    )
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            encoding="oem",
            errors="replace",
            timeout=45,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if res.returncode == 0:
            record_action(
                action_type="restore_point",
                title="Ponto de Restauração Criado",
                details=f"Descrição: {safe_desc}",
            )
            return {
                "success": True,
                "message": f"Ponto de restauração '{safe_desc}' solicitado com sucesso ao Windows!",
            }
        err_out = (res.stderr or res.stdout or "").strip()
        if "1058" in err_out or "disabled" in err_out.lower():
            return {
                "success": False,
                "message": "O serviço de Restauração do Sistema está desativado nas configurações do seu Windows.",
            }
        return {
            "success": False,
            "message": err_out or "Não foi possível criar o ponto de restauração (o Windows permite apenas 1 ponto a cada 24h por padrão).",
        }
    except Exception as e:
        return {"success": False, "message": f"Erro ao criar ponto de restauração: {str(e)}"}


def run_repair_tool(tool_id: str) -> Dict[str, Any]:
    if tool_id == "cleanmgr":
        try:
            subprocess.Popen(["cleanmgr.exe"])
            return {"success": True, "message": "Utilitário de Limpeza de Disco nativa do Windows aberto!"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    if not is_admin() and tool_id in ("sfc_scan", "dism_check", "dism_restore", "chkdsk_scan"):
        return {
            "success": False,
            "message": "Esta ferramenta de reparo do Windows exige permissão de Administrador.",
        }

    if tool_id == "dism_check":
        try:
            res = subprocess.run(
                ["DISM.exe", "/Online", "/Cleanup-Image", "/CheckHealth"],
                capture_output=True,
                text=True,
                encoding="oem",
                errors="replace",
                timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            output = (res.stdout or res.stderr or "").strip()
            record_action(
                action_type="repair",
                title="Verificação DISM CheckHealth",
                details="Integridade da imagem do Windows verificada.",
            )
            return {
                "success": res.returncode == 0,
                "message": "Verificação rápida DISM concluída!",
                "output": output,
            }
        except Exception as e:
            return {"success": False, "message": str(e)}

    if tool_id == "chkdsk_scan":
        try:
            res = subprocess.run(
                ["chkdsk", "C:", "/scan"],
                capture_output=True,
                text=True,
                encoding="oem",
                errors="replace",
                timeout=90,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            output = (res.stdout or res.stderr or "").strip()
            record_action(
                action_type="repair",
                title="Diagnóstico de Disco (CHKDSK)",
                details="Verificação online de erros no sistema de arquivos concluída.",
            )
            return {
                "success": True,
                "message": "Verificação online do disco C: concluída!",
                "output": output,
            }
        except Exception as e:
            return {"success": False, "message": str(e)}

    if tool_id == "sfc_scan":
        # Open an elevated visible console for SFC /scannow so the user can see live 0-100% progress without freezing
        try:
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "Reparo de Arquivos do Windows (SFC)", "cmd.exe", "/k", "echo Executando verificacao SFC /scannow... & sfc /scannow & echo. & echo Verificacao concluida!"],
                shell=False,
            )
            record_action(
                action_type="repair",
                title="Verificação SFC /scannow Iniciada",
                details="Executado reparo de arquivos protegidos do Windows.",
            )
            return {
                "success": True,
                "message": "O verificador 'SFC /scannow' foi aberto em uma janela dedicada para você acompanhar o progresso de 0% a 100%!",
            }
        except Exception as e:
            return {"success": False, "message": str(e)}

    if tool_id == "dism_restore":
        try:
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "Reparo Profundo do Windows (DISM)", "cmd.exe", "/k", "echo Executando DISM /RestoreHealth... & DISM.exe /Online /Cleanup-Image /RestoreHealth & echo. & echo Processo concluido!"],
                shell=False,
            )
            record_action(
                action_type="repair",
                title="Reparo Profundo DISM /RestoreHealth Iniciado",
                details="Iniciado reparo da imagem do sistema Windows.",
            )
            return {
                "success": True,
                "message": "O reparo profundo 'DISM /RestoreHealth' foi iniciado em uma janela dedicada para você acompanhar o progresso!",
            }
        except Exception as e:
            return {"success": False, "message": str(e)}

    return {"success": False, "message": "Ferramenta desconhecida."}
