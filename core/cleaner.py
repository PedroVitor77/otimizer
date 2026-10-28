import ctypes
from ctypes import wintypes
import glob
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from core.health import format_bytes, is_admin, is_link_or_junction
from core.history import record_action
from core.jobs import NullReporter, ProgressReporter


class SHQUERYRBINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("i64Size", ctypes.c_longlong),
        ("i64NumItems", ctypes.c_longlong),
    ]


SHERB_NOCONFIRMATION = 0x00000001
SHERB_NOPROGRESSUI = 0x00000002
SHERB_NOSOUND = 0x00000004


def query_recycle_bin() -> Tuple[int, int]:
    """Return (bytes, item_count) in the Windows Recycle Bin."""
    try:
        rbinfo = SHQUERYRBINFO()
        rbinfo.cbSize = ctypes.sizeof(SHQUERYRBINFO)
        res = ctypes.windll.shell32.SHQueryRecycleBinW(None, ctypes.byref(rbinfo))
        if res == 0:
            return max(0, int(rbinfo.i64Size)), max(0, int(rbinfo.i64NumItems))
    except Exception:
        pass
    return 0, 0


def empty_recycle_bin() -> Tuple[int, int]:
    """Empty the Windows Recycle Bin and return (bytes_freed, items_removed)."""
    size_before, count_before = query_recycle_bin()
    if count_before == 0 and size_before == 0:
        return 0, 0
    try:
        flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
        ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, flags)
        size_after, count_after = query_recycle_bin()
        return max(0, size_before - size_after), max(0, count_before - count_after)
    except Exception:
        return 0, 0


def _get_browser_cache_dirs() -> List[Path]:
    local_app = Path(os.environ.get("LOCALAPPDATA", ""))
    roaming_app = Path(os.environ.get("APPDATA", ""))
    dirs: List[Path] = []

    # Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, Opera)
    chromium_roots = [
        local_app / "Google" / "Chrome" / "User Data",
        local_app / "Microsoft" / "Edge" / "User Data",
        local_app / "BraveSoftware" / "Brave-Browser" / "User Data",
        local_app / "Vivaldi" / "User Data",
        local_app / "Opera Software" / "Opera Stable",
        local_app / "Opera Software" / "Opera GX Stable",
    ]
    # "Cache" already contains "Cache_Data"; listing both counted the same bytes twice.
    cache_subfolders = [
        Path("Cache"),
        Path("Code Cache"),
        Path("GPUCache"),
        Path("Service Worker") / "CacheStorage",
    ]

    for root in chromium_roots:
        if not root.exists():
            continue
        # Check Default and Profile * folders (or root itself for Opera)
        profiles = [root / "Default"] + list(root.glob("Profile *")) + [root]
        for prof in profiles:
            if not prof.exists():
                continue
            for sub in cache_subfolders:
                target = prof / sub
                if target.exists() and target not in dirs:
                    dirs.append(target)

    # Firefox cache2
    ff_profiles = local_app / "Mozilla" / "Firefox" / "Profiles"
    if ff_profiles.exists():
        for prof in ff_profiles.glob("*"):
            c2 = prof / "cache2"
            if c2.exists():
                dirs.append(c2)

    return dirs


def _get_app_cache_dirs() -> List[Path]:
    local_app = Path(os.environ.get("LOCALAPPDATA", ""))
    roaming_app = Path(os.environ.get("APPDATA", ""))
    candidates = [
        roaming_app / "discord" / "Cache",
        roaming_app / "discord" / "Code Cache",
        roaming_app / "discord" / "GPUCache",
        roaming_app / "Code" / "Cache",
        roaming_app / "Code" / "CachedData",
        roaming_app / "Code" / "GPUCache",
        local_app / "Spotify" / "Storage",
        local_app / "Spotify" / "Data",
        local_app / "Packages" / "MSTeams_8wekyb3d8bbwe" / "LocalCache" / "Microsoft" / "MSTeams" / "EBWebView" / "Default" / "Cache",
        local_app / "NVIDIA" / "DXCache",
        local_app / "NVIDIA" / "GLCache",
        local_app / "AMD" / "DxCache",
        local_app / "D3DSCache",
    ]
    return [p for p in candidates if p.exists()]


def get_junk_categories() -> List[Dict[str, Any]]:
    local_app = Path(os.environ.get("LOCALAPPDATA", ""))
    user_temp = Path(os.environ.get("TEMP", str(local_app / "Temp")))
    win_dir = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    prog_data = Path(os.environ.get("ProgramData", r"C:\ProgramData"))

    return [
        {
            "id": "user_temp",
            "name": "Arquivos Temporários do Usuário (%TEMP%)",
            "description": "Arquivos temporários criados por programas e instaladores na sua conta.",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": [user_temp],
            "patterns": [],
        },
        {
            "id": "win_temp",
            "name": "Arquivos Temporários do Windows (C:\\Windows\\Temp)",
            "description": "Arquivos temporários de serviços e processos do sistema operacional.",
            "safe": True,
            "requires_admin": True,
            "default_checked": True,
            "paths": [win_dir / "Temp"],
            "patterns": [],
        },
        {
            "id": "prefetch",
            "name": "Cache Prefetch do Sistema",
            "description": "Arquivos de pré-carregamento antigos do Windows (C:\\Windows\\Prefetch).",
            "safe": True,
            "requires_admin": True,
            "default_checked": True,
            "paths": [win_dir / "Prefetch"],
            "patterns": [],
        },
        {
            "id": "browser_cache",
            "name": "Cache de Navegadores (Chrome, Edge, Brave, Opera, Firefox)",
            "description": "Apenas arquivos de cache de páginas e imagens. Preserva 100% suas senhas, logins e histórico.",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": _get_browser_cache_dirs(),
            "patterns": [],
        },
        {
            "id": "app_cache",
            "name": "Caches de Aplicativos e Shaders (Discord, Spotify, VSCode, GPU)",
            "description": "Caches acumulados por apps de comunicação, mídia e shaders gráficos antigos.",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": _get_app_cache_dirs(),
            "patterns": [],
        },
        {
            "id": "win_update",
            "name": "Cache de Downloads do Windows Update",
            "description": "Pacotes de atualização já instalados armazenados em SoftwareDistribution\\Download.",
            "safe": True,
            "requires_admin": True,
            "default_checked": True,
            "paths": [win_dir / "SoftwareDistribution" / "Download"],
            "patterns": [],
        },
        {
            "id": "wer_logs",
            "name": "Relatórios de Erros (WER) e Logs do Sistema",
            "description": "Relatórios de travamentos passados (Windows Error Reporting) e logs de diagnóstico. Sem administrador, só os da sua conta são limpos.",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": [
                local_app / "Microsoft" / "Windows" / "WER" / "ReportArchive",
                local_app / "Microsoft" / "Windows" / "WER" / "ReportQueue",
                prog_data / "Microsoft" / "Windows" / "WER" / "ReportArchive",
                prog_data / "Microsoft" / "Windows" / "WER" / "ReportQueue",
                local_app / "CrashDumps",
                win_dir / "Logs" / "CBS",
            ],
            "patterns": [],
        },
        {
            "id": "thumbnails",
            "name": "Cache de Miniaturas do Windows Explorer",
            "description": "Bancos de dados de miniaturas de imagens/vídeos antigos (thumbcache_*.db).",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": [],
            "patterns": [str(local_app / "Microsoft" / "Windows" / "Explorer" / "thumbcache_*.db")],
        },
        {
            "id": "recycle_bin",
            "name": "Lixeira do Windows",
            "description": "Arquivos enviados anteriormente para a Lixeira em todos os discos.",
            "safe": True,
            "requires_admin": False,
            "default_checked": True,
            "paths": [],
            "patterns": [],
        },
    ]


def _scan_directory(
    dir_path: Path, max_samples: int = 8, reporter: Optional[ProgressReporter] = None
) -> Tuple[int, int, List[str]]:
    total_size = 0
    file_count = 0
    samples: List[str] = []
    if not dir_path.exists():
        return 0, 0, []

    stack = [str(dir_path)]
    while stack:
        current = stack.pop()
        if reporter is not None:
            reporter.check()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if is_link_or_junction(entry):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            st = entry.stat(follow_symlinks=False)
                            total_size += st.st_size
                            file_count += 1
                            if len(samples) < max_samples:
                                samples.append(entry.path)
                    except Exception:
                        continue
        except Exception:
            continue
    return total_size, file_count, samples


def scan_junk(reporter: Optional[ProgressReporter] = None) -> Dict[str, Any]:
    reporter = reporter or NullReporter()
    admin = is_admin()
    categories = get_junk_categories()
    results = []
    grand_total_bytes = 0
    grand_total_files = 0

    for step, cat in enumerate(categories, start=1):
        reporter.check()
        reporter.update(label=cat["name"], done=step - 1, total=len(categories), scanned=grand_total_files)
        cat_bytes = 0
        cat_files = 0
        cat_samples: List[str] = []

        if cat["id"] == "recycle_bin":
            rb_bytes, rb_items = query_recycle_bin()
            cat_bytes += rb_bytes
            cat_files += rb_items
            if rb_items > 0:
                cat_samples.append(f"Lixeira do Sistema ({rb_items} itens)")
        else:
            for p in cat["paths"]:
                sz, cnt, smp = _scan_directory(p, reporter=reporter)
                cat_bytes += sz
                cat_files += cnt
                for s in smp:
                    if len(cat_samples) < 8:
                        cat_samples.append(s)

            for pat in cat["patterns"]:
                for matched in glob.glob(pat):
                    try:
                        st = os.stat(matched)
                        cat_bytes += st.st_size
                        cat_files += 1
                        if len(cat_samples) < 8:
                            cat_samples.append(matched)
                    except Exception:
                        continue

        grand_total_bytes += cat_bytes
        grand_total_files += cat_files

        results.append(
            {
                "id": cat["id"],
                "name": cat["name"],
                "description": cat["description"],
                "safe": cat["safe"],
                "requires_admin": cat["requires_admin"],
                "blocked": cat["requires_admin"] and not admin,
                "default_checked": cat["default_checked"] and not (cat["requires_admin"] and not admin),
                "size_bytes": cat_bytes,
                "size_formatted": format_bytes(cat_bytes),
                "file_count": cat_files,
                "samples": cat_samples,
            }
        )

    return {
        "total_bytes": grand_total_bytes,
        "total_formatted": format_bytes(grand_total_bytes),
        "total_files": grand_total_files,
        "is_admin": admin,
        "categories": results,
    }


def _clean_directory_contents(dir_path: Path) -> Tuple[int, int, int]:
    """Delete files and subdirectories inside dir_path without deleting dir_path itself."""
    bytes_freed = 0
    files_removed = 0
    skipped_locked = 0

    if not dir_path.exists():
        return 0, 0, 0

    # Manual walk instead of os.walk: os.walk descends into NTFS junctions, which would
    # delete files that live outside the folder being cleaned. Links are left untouched.
    subdirs: List[str] = []
    stack = [str(dir_path)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                entries = list(it)
        except Exception:
            continue
        for entry in entries:
            try:
                if is_link_or_junction(entry):
                    skipped_locked += 1
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                    subdirs.append(entry.path)
                    continue
                sz = entry.stat(follow_symlinks=False).st_size
                os.chmod(entry.path, 0o666)
                os.remove(entry.path)
                bytes_freed += sz
                files_removed += 1
            except Exception:
                skipped_locked += 1

    # Children were discovered after their parents, so reverse order removes the deepest first.
    for dpath in reversed(subdirs):
        try:
            os.rmdir(dpath)
        except Exception:
            pass

    return bytes_freed, files_removed, skipped_locked


def clean_junk(selected_ids: List[str], record_in_history: bool = True) -> Dict[str, Any]:
    categories = get_junk_categories()
    selected_set = set(selected_ids)
    admin = is_admin()

    total_freed = 0
    total_removed = 0
    total_skipped = 0
    details_by_cat = []

    for cat in categories:
        if cat["id"] not in selected_set:
            continue
        if cat["requires_admin"] and not admin:
            details_by_cat.append(
                {
                    "id": cat["id"],
                    "name": cat["name"],
                    "bytes_freed": 0,
                    "formatted_freed": format_bytes(0),
                    "files_removed": 0,
                    "skipped_in_use": 0,
                    "skipped_no_admin": True,
                }
            )
            continue

        cat_freed = 0
        cat_removed = 0
        cat_skipped = 0

        if cat["id"] == "recycle_bin":
            rb_freed, rb_removed = empty_recycle_bin()
            cat_freed += rb_freed
            cat_removed += rb_removed
        else:
            for p in cat["paths"]:
                b_freed, f_rem, f_skip = _clean_directory_contents(p)
                cat_freed += b_freed
                cat_removed += f_rem
                cat_skipped += f_skip

            for pat in cat["patterns"]:
                for matched in glob.glob(pat):
                    try:
                        sz = os.path.getsize(matched)
                        os.remove(matched)
                        cat_freed += sz
                        cat_removed += 1
                    except Exception:
                        cat_skipped += 1

        total_freed += cat_freed
        total_removed += cat_removed
        total_skipped += cat_skipped
        details_by_cat.append(
            {
                "id": cat["id"],
                "name": cat["name"],
                "bytes_freed": cat_freed,
                "formatted_freed": format_bytes(cat_freed),
                "files_removed": cat_removed,
                "skipped_in_use": cat_skipped,
                "skipped_no_admin": False,
            }
        )

    if record_in_history and (total_freed > 0 or total_removed > 0):
        record_action(
            action_type="cleaner",
            title="Limpeza de Arquivos Inúteis",
            details=f"Liberados {format_bytes(total_freed)} ({total_removed} arquivos removidos)",
            bytes_cleaned=total_freed,
            files_removed=total_removed,
        )

    return {
        "bytes_freed": total_freed,
        "formatted_freed": format_bytes(total_freed),
        "files_removed": total_removed,
        "skipped_in_use": total_skipped,
        "skipped_no_admin": [d["name"] for d in details_by_cat if d["skipped_no_admin"]],
        "is_admin": admin,
        "categories": details_by_cat,
    }
