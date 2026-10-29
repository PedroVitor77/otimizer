import ctypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import winreg
import send2trash

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
UNINSTALL_REGISTRY_ROOTS = [
    (
        winreg.HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ),
    (
        winreg.HKEY_LOCAL_MACHINE,
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ),
    (
        winreg.HKEY_CURRENT_USER,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ),
]


def _extract_uninstaller_exe(uninstall_str: str) -> Optional[str]:
    s = os.path.expandvars((uninstall_str or "").strip())
    if not s:
        return None
    m = re.match(r'^"([^"]+)"', s)
    if m:
        cand = m.group(1).strip()
    else:
        m2 = re.match(r'^([a-zA-Z]:\\[^"]*?\.(?:exe|bat|cmd|msi))\b', s, re.IGNORECASE)
        cand = m2.group(1).strip() if m2 else s.split()[0]
    if ":" in cand or cand.startswith("\\\\"):
        return cand
    return None


def _is_ghost_program(uninstall_str: str, install_location: str = "") -> bool:
    exe_path = _extract_uninstaller_exe(uninstall_str)
    if exe_path:
        exe_name = Path(exe_path).name.lower()
        if exe_name not in ("msiexec.exe", "rundll32.exe", "cmd.exe", "powershell.exe"):
            if not Path(exe_path).exists():
                return True
    loc = os.path.expandvars((install_location or "").strip().strip('"'))
    if loc and (":" in loc or loc.startswith("\\\\")):
        if not Path(loc).exists():
            if not exe_path or not Path(exe_path).exists():
                return True
    return False


def get_installed_programs() -> List[Dict[str, Any]]:
    seen_names = set()
    programs: List[Dict[str, Any]] = []

    for root, subkey, prefix in UNINSTALL_REGISTRY_ROOTS:
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
                            install_loc = str(_q("InstallLocation", "")).strip()
                            size_kb = _q("EstimatedSize", 0)
                            try:
                                size_bytes = int(size_kb) * 1024
                            except Exception:
                                size_bytes = 0

                            install_date = str(_q("InstallDate", "")).strip()
                            if len(install_date) == 8 and install_date.isdigit():
                                install_date = f"{install_date[6:8]}/{install_date[4:6]}/{install_date[0:4]}"

                            is_ghost = _is_ghost_program(uninstall_str, install_loc)

                            programs.append(
                                {
                                    "name": name,
                                    "publisher": publisher,
                                    "version": version,
                                    "size_bytes": size_bytes,
                                    "size_formatted": format_bytes(size_bytes) if size_bytes > 0 else "N/D",
                                    "install_date": install_date or "--",
                                    "uninstall_string": uninstall_str,
                                    "install_location": install_loc,
                                    "is_ghost": is_ghost,
                                    "registry_root": prefix.split("\\")[0],
                                    "registry_subkey": f"{subkey}\\{sk_name}",
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
    programs = get_installed_programs()
    matched = next((p for p in programs if p["uninstall_string"] == uninstall_string), None)
    if not matched:
        return {"success": False, "message": "Desinstalador não encontrado no registro do Windows. Atualize a lista e tente de novo."}

    if matched.get("is_ghost"):
        return {
            "success": False,
            "ghost_entry": True,
            "message": (
                f"Os arquivos de '{app_name or matched['name']}' já foram apagados do disco "
                f"(desinstalador inexistente). Use o Deep Clean para remover esse registro fantasma!"
            ),
        }

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


# --- DEEP CLEAN / LEFTOVER SCANNER (Revo Uninstaller style) ---
STOPWORDS_LEFTOVERS = {
    "corporation", "corp", "inc", "ltd", "gmbh", "software", "system",
    "installer", "uninstaller", "edition", "x64", "x86", "win64", "win32",
    "setup", "client", "desktop", "application", "app", "community",
    "professional", "release", "update", "updater", "service", "services",
    "microsoft", "windows", "for", "the", "and", "version", "portable",
    "desconhecido", "unknown",
}

GENERIC_WORDS_LEFTOVERS = {
    "user", "data", "free", "tool", "tools", "player", "game", "games",
    "pro", "home", "main", "live", "view", "web", "net", "core", "code",
    "beta", "alpha", "pack", "plus", "launcher", "manager", "installer", "install",
    "setup", "update", "updater", "service", "client", "helper", "engine",
    "runtime", "driver", "suite", "software", "desktop", "assistant", "studio",
    "community"
}

PROTECTED_NAMES_LEFTOVERS = {
    "windows", "system32", "syswow64", "winsxs", "system", "users",
    "all users", "default", "public", "program files", "program files (x86)",
    "programdata", "appdata", "localappdata", "temp", "tmp", "microsoft",
    "desktop", "documents", "downloads", "music", "pictures", "videos",
    "start menu", "startup", "common files", "pulsepc", "google", "edge",
    "nvidia", "amd", "intel", "realtek"
}


def _extract_leftover_keywords(app_name: str, publisher: Optional[str] = None) -> List[str]:
    clean = re.sub(r"[\(\)\[\]\{\}\-_,\.:\;/\\]", " ", (app_name or "").lower())
    clean = re.sub(r"\bv?\d+(\.\d+)*\b", " ", clean)
    words = [
        w for w in clean.split()
        if len(w) >= 3 and w not in STOPWORDS_LEFTOVERS and w not in GENERIC_WORDS_LEFTOVERS
    ]
    if publisher:
        clean_pub = re.sub(r"[\(\)\[\]\{\}\-_,\.:\;/\\]", " ", publisher.lower())
        pub_words = [
            w for w in clean_pub.split()
            if len(w) >= 4 and w not in STOPWORDS_LEFTOVERS and w not in GENERIC_WORDS_LEFTOVERS
        ]
        words.extend(pub_words)

    unique_words: List[str] = []
    for w in words:
        if w not in unique_words and w not in PROTECTED_NAMES_LEFTOVERS:
            unique_words.append(w)
    return unique_words or ([app_name.lower()[:15]] if len(app_name) >= 3 else [])


# What the last scan of each app found. clean_app_leftovers only touches items listed here, so a
# client can never ask for an arbitrary folder, file or registry key to be removed.
_LEFTOVER_TTL_S = 30 * 60
_leftover_lock = threading.Lock()
_leftover_allowed: Dict[str, Dict[str, Any]] = {}

# Characters that would break out of the quoted registry path in the elevated batch / reg.exe call.
_UNSAFE_REG_CHARS = set('"%\r\n\0')


def _norm_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _norm_reg(root_name: str, subkey: str) -> Tuple[str, str]:
    return (str(root_name).upper(), str(subkey).strip("\\").lower())


def _remember_leftover_scan(
    app_name: str,
    folders: List[Dict[str, Any]],
    files: List[Dict[str, Any]],
    keys: List[Dict[str, Any]],
) -> None:
    now = time.time()
    with _leftover_lock:
        for k in [k for k, v in _leftover_allowed.items() if now - v["ts"] > _LEFTOVER_TTL_S]:
            del _leftover_allowed[k]
        _leftover_allowed[(app_name or "").strip().lower()] = {
            "ts": now,
            "folders": {_norm_path(f["path"]) for f in folders},
            "files": {_norm_path(f["path"]) for f in files},
            "registry": {_norm_reg(k["root_name"], k["subkey"]) for k in keys},
        }


def _allowed_leftovers(app_name: str) -> Dict[str, Any]:
    with _leftover_lock:
        entry = _leftover_allowed.get((app_name or "").strip().lower())
        if entry and time.time() - entry["ts"] <= _LEFTOVER_TTL_S:
            return entry
    return {"folders": set(), "files": set(), "registry": set()}


def _is_safe_leftover_target(path: Path) -> bool:
    name = path.name.lower()
    if name in PROTECTED_NAMES_LEFTOVERS:
        return False
    if len(path.parts) < 4:
        return False
    if path in (
        Path(os.environ.get("SystemRoot", r"C:\Windows")),
        Path(os.environ.get("ProgramData", r"C:\ProgramData")),
        Path(r"C:\Program Files"),
        Path(r"C:\Program Files (x86)"),
        Path.home(),
        Path(os.environ.get("APPDATA", "")),
        Path(os.environ.get("LOCALAPPDATA", "")),
    ):
        return False
    return True


def scan_app_leftovers(app_name: str, publisher: Optional[str] = None) -> Dict[str, Any]:
    """Scan filesystem and Windows Registry for leftover folders, files and keys for a given application."""
    keywords = _extract_leftover_keywords(app_name, publisher)
    if not keywords:
        return {
            "app_name": app_name,
            "keywords": [],
            "folders": [],
            "files": [],
            "registry_keys": [],
            "total_bytes": 0,
            "total_formatted": "0 B",
            "total_items": 0,
        }

    search_dirs = [
        Path(os.environ.get("APPDATA", "")),
        Path(os.environ.get("LOCALAPPDATA", "")),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs",
        Path(os.environ.get("ProgramData", r"C:\ProgramData")),
        Path(r"C:\Program Files"),
        Path(r"C:\Program Files (x86)"),
    ]

    shortcut_dirs = [
        Path.home() / "Desktop",
        Path(os.environ.get("PUBLIC", r"C:\Users\Public")) / "Desktop",
        Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
        Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
    ]

    found_folders: List[Dict[str, Any]] = []
    found_files: List[Dict[str, Any]] = []
    seen_paths = set()
    total_bytes = 0

    def _matches_keywords(text: str) -> bool:
        t_low = text.lower()
        for kw in keywords:
            if re.search(r"\b" + re.escape(kw) + r"\b", t_low):
                return True
            if len(kw) >= 5 and kw in t_low:
                return True
        return False

    # 1. Search directories for dedicated app folders
    for base in search_dirs:
        if not base.exists():
            continue
        try:
            with os.scandir(str(base)) as it:
                for entry in it:
                    if not _matches_keywords(entry.name):
                        continue
                    p = Path(entry.path)
                    if not _is_safe_leftover_target(p):
                        continue
                    if str(p) in seen_paths:
                        continue
                    seen_paths.add(str(p))

                    if entry.is_dir(follow_symlinks=False):
                        try:
                            sz = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                        except Exception:
                            sz = 0
                        total_bytes += sz
                        found_folders.append({
                            "path": str(p),
                            "name": entry.name,
                            "size_bytes": sz,
                            "size_formatted": format_bytes(sz),
                        })
                    elif entry.is_file(follow_symlinks=False):
                        try:
                            sz = entry.stat().st_size
                        except Exception:
                            sz = 0
                        total_bytes += sz
                        found_files.append({
                            "path": str(p),
                            "name": entry.name,
                            "size_bytes": sz,
                            "size_formatted": format_bytes(sz),
                        })
        except Exception:
            continue

    # 2. Search shortcut links (.lnk)
    for s_dir in shortcut_dirs:
        if not s_dir.exists():
            continue
        try:
            for item in s_dir.rglob("*.lnk"):
                if _matches_keywords(item.stem) and str(item) not in seen_paths:
                    seen_paths.add(str(item))
                    sz = item.stat().st_size if item.exists() else 0
                    total_bytes += sz
                    found_files.append({
                        "path": str(item),
                        "name": item.name,
                        "size_bytes": sz,
                        "size_formatted": format_bytes(sz),
                    })
        except Exception:
            continue

    # 3. Search Windows Registry (Software + Orphan/Matching Uninstall Keys)
    registry_roots = [
        (winreg.HKEY_CURRENT_USER, r"Software", "HKCU\\Software"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software", "HKLM\\Software"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node", "HKLM\\Software\\WOW6432Node"),
    ]
    found_keys: List[Dict[str, Any]] = []
    seen_reg = set()

    for root, subkey, prefix in registry_roots:
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as k:
                subkeys_cnt, _, _ = winreg.QueryInfoKey(k)
                for i in range(subkeys_cnt):
                    sname = winreg.EnumKey(k, i)
                    s_lower = sname.lower()
                    if s_lower in PROTECTED_NAMES_LEFTOVERS or s_lower in ("classes", "policies", "clients", "registeredapplications"):
                        continue
                    if _matches_keywords(sname):
                        disp = f"{prefix}\\{sname}"
                        if disp not in seen_reg:
                            seen_reg.add(disp)
                            found_keys.append({
                                "display": disp,
                                "root_name": prefix.split("\\")[0],
                                "subkey": f"{subkey}\\{sname}",
                            })
        except Exception:
            continue

    # 4. Also check Windows Uninstall registry keys for orphan/ghost entries or exact app match
    target_app_low = (app_name or "").strip().lower()
    for root, subkey, prefix in UNINSTALL_REGISTRY_ROOTS:
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as k:
                subkeys_cnt, _, _ = winreg.QueryInfoKey(k)
                for i in range(subkeys_cnt):
                    try:
                        sname = winreg.EnumKey(k, i)
                        with winreg.OpenKey(k, sname, 0, winreg.KEY_READ) as sk:
                            try:
                                disp_name = str(winreg.QueryValueEx(sk, "DisplayName")[0]).strip()
                            except Exception:
                                disp_name = ""
                            try:
                                u_str = str(winreg.QueryValueEx(sk, "UninstallString")[0]).strip()
                            except Exception:
                                u_str = ""
                            try:
                                i_loc = str(winreg.QueryValueEx(sk, "InstallLocation")[0]).strip()
                            except Exception:
                                i_loc = ""

                            is_exact = bool(target_app_low and disp_name.lower() == target_app_low)
                            is_kw_match = _matches_keywords(disp_name or sname)
                            is_ghost = _is_ghost_program(u_str, i_loc) if u_str else False

                            if (is_exact and is_ghost) or (is_kw_match and is_ghost) or is_exact:
                                disp = f"{prefix}\\{sname}"
                                if disp not in seen_reg:
                                    seen_reg.add(disp)
                                    found_keys.append({
                                        "display": disp,
                                        "root_name": prefix.split("\\")[0],
                                        "subkey": f"{subkey}\\{sname}",
                                        "is_uninstall_entry": True,
                                        "is_ghost": is_ghost,
                                    })
                    except Exception:
                        continue
        except Exception:
            continue

    found_folders.sort(key=lambda x: x["size_bytes"], reverse=True)
    total_items = len(found_folders) + len(found_files) + len(found_keys)
    _remember_leftover_scan(app_name, found_folders, found_files, found_keys)

    return {
        "app_name": app_name,
        "keywords": keywords,
        "folders": found_folders,
        "files": found_files,
        "registry_keys": found_keys,
        "total_bytes": total_bytes,
        "total_formatted": format_bytes(total_bytes),
        "total_items": total_items,
    }


def _reg_key_exists(root_key, subkey_path: str) -> bool:
    subkey_clean = subkey_path.strip("\\")
    for flags in (winreg.KEY_READ, winreg.KEY_READ | winreg.KEY_WOW64_64KEY, winreg.KEY_READ | winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(root_key, subkey_clean, 0, flags):
                return True
        except OSError:
            pass
    return False


def _delete_reg_key_recursive(root_key, subkey_path: str, full_display_path: str = "", allow_uac: bool = True) -> bool:
    """Recursively delete a Windows Registry key, with fallback to reg.exe and optional UAC elevation."""
    subkey_clean = subkey_path.strip("\\")
    if not _reg_key_exists(root_key, subkey_clean):
        return True

    # 1. Native winreg recursive deletion
    def _py_del(hkey, sub: str) -> bool:
        for flag in (winreg.KEY_ALL_ACCESS, winreg.KEY_ALL_ACCESS | winreg.KEY_WOW64_64KEY, winreg.KEY_ALL_ACCESS | winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hkey, sub, 0, flag) as k:
                    while True:
                        try:
                            child = winreg.EnumKey(k, 0)
                            if not _py_del(hkey, f"{sub}\\{child}"):
                                break
                        except OSError:
                            break
                for del_flag in (0, winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                    try:
                        if del_flag == 0:
                            winreg.DeleteKey(hkey, sub)
                        else:
                            winreg.DeleteKeyEx(hkey, sub, del_flag, 0)
                        return True
                    except OSError:
                        pass
            except OSError:
                pass
        return False

    try:
        if _py_del(root_key, subkey_clean) and not _reg_key_exists(root_key, subkey_clean):
            return True
    except Exception:
        pass

    # 2. Try silent reg.exe delete (succeeds if running as Admin or key is writable)
    target_path = full_display_path.strip()
    if not target_path:
        root_prefix = "HKCU" if root_key == winreg.HKEY_CURRENT_USER else "HKLM"
        target_path = f"{root_prefix}\\{subkey_clean}"

    CREATE_NO_WINDOW = 0x08000000
    try:
        res = subprocess.run(
            ["reg.exe", "delete", target_path, "/f"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=CREATE_NO_WINDOW,
        )
        if res.returncode == 0 or not _reg_key_exists(root_key, subkey_clean):
            return True
    except Exception:
        pass

    if not allow_uac:
        return False

    # 3. Elevate via UAC if allowed
    try:
        res_code = ctypes.windll.shell32.ShellExecuteW(
            None,
            "runas",
            "reg.exe",
            f'delete "{target_path}" /f',
            None,
            0,  # SW_HIDE
        )
        if res_code > 32:
            for _ in range(25):
                time.sleep(0.1)
                if not _reg_key_exists(root_key, subkey_clean):
                    return True
    except Exception:
        pass

    return not _reg_key_exists(root_key, subkey_clean)


def clean_app_leftovers(
    folders: List[str],
    files: List[str],
    registry_keys: List[Dict[str, Any]],
    app_name: str = "",
) -> Dict[str, Any]:
    """Move leftover folders/files to Recycle Bin and delete leftover registry keys."""
    cleaned_bytes = 0
    removed_folders = 0
    removed_files = 0
    removed_keys = 0
    errors: List[str] = []

    allowed = _allowed_leftovers(app_name)

    # 1. Clean folders (Recycle Bin only: nothing is deleted permanently)
    for f_str in folders:
        p = Path(f_str)
        if _norm_path(f_str) not in allowed["folders"]:
            errors.append(f"Pasta ignorada (não estava no último scan): {p.name}")
            continue
        if not p.exists() or not _is_safe_leftover_target(p):
            continue
        try:
            sz = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else 0
            send2trash.send2trash(str(p))
            cleaned_bytes += sz
            removed_folders += 1
        except Exception as e:
            errors.append(f"Pasta {p.name}: não foi possível enviar para a Lixeira ({e})")

    # 2. Clean files & shortcuts
    for f_str in files:
        p = Path(f_str)
        if _norm_path(f_str) not in allowed["files"]:
            errors.append(f"Arquivo ignorado (não estava no último scan): {p.name}")
            continue
        if not p.exists() or not _is_safe_leftover_target(p):
            continue
        try:
            sz = p.stat().st_size if p.is_file() else 0
            send2trash.send2trash(str(p))
            cleaned_bytes += sz
            removed_files += 1
        except Exception as e:
            errors.append(f"Arquivo {p.name}: não foi possível enviar para a Lixeira ({e})")

    # 3. Clean registry keys
    pending_reg: List[Dict[str, Any]] = []
    for rk in registry_keys:
        root_name = str(rk.get("root_name", "")).upper()
        subkey = str(rk.get("subkey", "")).strip("\\")
        if root_name not in ("HKCU", "HKLM") or not subkey:
            continue
        leaf = subkey.split("\\")[-1]
        if _norm_reg(root_name, subkey) not in allowed["registry"]:
            errors.append(f"Chave ignorada (não estava no último scan): {leaf}")
            continue
        if _UNSAFE_REG_CHARS & set(subkey):
            errors.append(f"Chave com caracteres inválidos ignorada: {leaf}")
            continue
        # Built here from the validated parts. The client's "display" text is never used.
        disp = f"{root_name}\\{subkey}"
        sub_low = subkey.lower().strip("\\")
        is_uninstall_subkey = (
            sub_low.startswith("software\\microsoft\\windows\\currentversion\\uninstall\\")
            or sub_low.startswith("software\\wow6432node\\microsoft\\windows\\currentversion\\uninstall\\")
        ) and sub_low.count("\\") >= 5
        if not is_uninstall_subkey and ("microsoft" in sub_low or "windows" in sub_low):
            continue
        root = winreg.HKEY_CURRENT_USER if root_name == "HKCU" else winreg.HKEY_LOCAL_MACHINE

        # Try direct deletion first (fast, silent)
        if _delete_reg_key_recursive(root, subkey, full_display_path=disp, allow_uac=False):
            removed_keys += 1
        else:
            pending_reg.append({
                "root": root,
                "subkey": subkey,
                "display": disp,
                "root_name": root_name,
            })

    # If some keys require administrative elevation, batch them in a single UAC prompt
    if pending_reg:
        reg_cmds = [f'reg delete "{item["display"]}" /f' for item in pending_reg]
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, encoding="utf-8") as tf:
                tf.write("@echo off\n" + "\n".join(reg_cmds) + "\nexit /b 0\n")
                bat_path = tf.name

            res_code = ctypes.windll.shell32.ShellExecuteW(
                None,
                "runas",
                "cmd.exe",
                f'/c "{bat_path}"',
                None,
                0,  # SW_HIDE
            )
            if res_code > 32:
                # Wait up to 3 seconds for batch completion
                for _ in range(30):
                    time.sleep(0.1)
                    if all(not _reg_key_exists(item["root"], item["subkey"]) for item in pending_reg):
                        break
            try:
                os.remove(bat_path)
            except Exception:
                pass
        except Exception:
            pass

        for item in pending_reg:
            if not _reg_key_exists(item["root"], item["subkey"]):
                removed_keys += 1
            else:
                errors.append(f"Chave {item['display']}: Permissão negada no Registro do Windows (execute como Administrador)")

    total_removed = removed_folders + removed_files + removed_keys
    if total_removed > 0:
        record_action(
            action_type="leftovers_clean",
            title=f"Caçador de Sobras: {app_name or 'Aplicativo'}",
            details=(
                f"Removidas {removed_folders} pastas, {removed_files} arquivos e {removed_keys} chaves de registro "
                f"({format_bytes(cleaned_bytes)} recuperados)"
            ),
            bytes_cleaned=cleaned_bytes,
            files_removed=removed_folders + removed_files,
        )

    return {
        "success": total_removed > 0 or len(errors) == 0,
        "removed_folders": removed_folders,
        "removed_files": removed_files,
        "removed_keys": removed_keys,
        "cleaned_bytes": cleaned_bytes,
        "cleaned_formatted": format_bytes(cleaned_bytes),
        "errors": errors,
    }


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
