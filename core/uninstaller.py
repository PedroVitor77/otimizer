"""Installed programs, official uninstaller launcher, and Revo-style Deep Clean leftover scanner."""

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import winreg

import send2trash

from core.health import format_bytes
from core.history import record_action

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
    "community",
}

PROTECTED_NAMES_LEFTOVERS = {
    "windows", "system32", "syswow64", "winsxs", "system", "users",
    "all users", "default", "public", "program files", "program files (x86)",
    "programdata", "appdata", "localappdata", "temp", "tmp", "microsoft",
    "desktop", "documents", "downloads", "music", "pictures", "videos",
    "start menu", "startup", "common files", "pulsepc", "google", "edge",
    "nvidia", "amd", "intel", "realtek",
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


class _SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("fMask", ctypes.c_ulong),
        ("hwnd", wintypes.HWND),
        ("lpVerb", wintypes.LPCWSTR),
        ("lpFile", wintypes.LPCWSTR),
        ("lpParameters", wintypes.LPCWSTR),
        ("lpDirectory", wintypes.LPCWSTR),
        ("nShow", ctypes.c_int),
        ("hInstApp", wintypes.HINSTANCE),
        ("lpIDList", ctypes.c_void_p),
        ("lpClass", wintypes.LPCWSTR),
        ("hkeyClass", wintypes.HKEY),
        ("dwHotKey", wintypes.DWORD),
        ("hIconOrMonitor", wintypes.HANDLE),
        ("hProcess", wintypes.HANDLE),
    ]


def _run_elevated_and_wait(exe: str, params: str, timeout_ms: int = 120000) -> bool:
    """Launch an elevated command via ShellExecuteExW and wait for process completion."""
    if os.name != "nt":
        return False
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    sei = _SHELLEXECUTEINFOW()
    sei.cbSize = ctypes.sizeof(_SHELLEXECUTEINFOW)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS
    sei.lpVerb = "runas"
    sei.lpFile = exe
    sei.lpParameters = params
    sei.nShow = 0  # SW_HIDE

    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei)):
        return False
    if sei.hProcess:
        try:
            ctypes.windll.kernel32.WaitForSingleObject(sei.hProcess, int(timeout_ms))
        finally:
            ctypes.windll.kernel32.CloseHandle(sei.hProcess)
    return True


def _delete_reg_key_recursive(root_key, subkey_path: str, full_display_path: str = "", allow_uac: bool = True) -> bool:
    """Recursively delete a Windows Registry key, with fallback to reg.exe and optional UAC elevation."""
    subkey_clean = subkey_path.strip("\\")
    if not _reg_key_exists(root_key, subkey_clean):
        return True

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

    try:
        _run_elevated_and_wait("reg.exe", f'delete "{target_path}" /f', timeout_ms=60000)
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
        disp = f"{root_name}\\{subkey}"
        sub_low = subkey.lower().strip("\\")
        is_uninstall_subkey = (
            sub_low.startswith("software\\microsoft\\windows\\currentversion\\uninstall\\")
            or sub_low.startswith("software\\wow6432node\\microsoft\\windows\\currentversion\\uninstall\\")
        ) and sub_low.count("\\") >= 5
        if not is_uninstall_subkey and ("microsoft" in sub_low or "windows" in sub_low):
            continue
        root = winreg.HKEY_CURRENT_USER if root_name == "HKCU" else winreg.HKEY_LOCAL_MACHINE

        if _delete_reg_key_recursive(root, subkey, full_display_path=disp, allow_uac=False):
            removed_keys += 1
        else:
            pending_reg.append({
                "root": root,
                "subkey": subkey,
                "display": disp,
                "root_name": root_name,
            })

    if pending_reg:
        reg_cmds = [f'reg delete "{item["display"]}" /f' for item in pending_reg]
        bat_path = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, encoding="utf-8") as tf:
                tf.write("@echo off\n" + "\n".join(reg_cmds) + "\nexit /b 0\n")
                bat_path = tf.name

            _run_elevated_and_wait("cmd.exe", f'/c "{bat_path}"', timeout_ms=120000)
        except Exception:
            pass
        finally:
            if bat_path:
                try:
                    os.remove(bat_path)
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
