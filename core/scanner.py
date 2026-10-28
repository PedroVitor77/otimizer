from collections import defaultdict
from datetime import datetime
import hashlib
import os
from pathlib import Path
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from send2trash import send2trash

from core.health import format_bytes, is_link_or_junction
from core.history import record_action
from core.jobs import NullReporter, ProgressReporter

CATEGORY_EXTENSIONS: Dict[str, set] = {
    "Vídeos & Mídia": {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg", ".wav", ".flac", ".mp3"},
    "ISOs & Instaladores": {".iso", ".exe", ".msi", ".img", ".vhd", ".vhdx", ".ova", ".vmdk", ".cab", ".msix"},
    "Compactados & Backups": {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz", ".bak", ".old", ".dmp"},
    "Jogos, IA & Dados": {".pak", ".bin", ".dat", ".ucas", ".utoc", ".upk", ".vpk", ".rpf", ".bundle", ".gguf", ".safetensors", ".onnx", ".pt", ".pth", ".ckpt"},
    "Projetos & Bancos de Dados": {".pdf", ".psd", ".ai", ".prproj", ".aep", ".blend", ".db", ".sqlite", ".sqlite3", ".mdf", ".ldf", ".parquet", ".duckdb", ".csv", ".xlsx"},
}

PROTECTED_DIRS = [
    os.path.normcase(os.environ.get("SystemRoot", r"C:\Windows")),
    os.path.normcase(os.environ.get("ProgramFiles", r"C:\Program Files")),
    os.path.normcase(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")),
    os.path.normcase(r"C:\System Volume Information"),
    os.path.normcase(r"C:\$Recycle.Bin"),
]

PROTECTED_FILENAMES = {
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "bootmgr",
    "ntldr",
}

PROTECTED_EXTENSIONS = {".sys", ".dll", ".drv", ".ocx", ".efi"}


def classify_file(filepath: str) -> str:
    ext = os.path.splitext(filepath)[1].lower()
    for cat, exts in CATEGORY_EXTENSIONS.items():
        if ext in exts:
            return cat
    return "Outros Arquivos"


def is_protected_file(filepath: str) -> Tuple[bool, str]:
    norm_path = os.path.normcase(os.path.abspath(filepath))
    fname = os.path.basename(norm_path)
    ext = os.path.splitext(norm_path)[1].lower()

    if fname in PROTECTED_FILENAMES:
        return True, "Arquivo vital de memória/boot do sistema Windows"

    for pdir in PROTECTED_DIRS:
        if pdir and (norm_path == pdir or norm_path.startswith(pdir + os.sep)):
            return True, "Localizado em pasta protegida do Windows / Programas Instalados"

    if ext in PROTECTED_EXTENSIONS:
        return True, f"Biblioteca ou driver de sistema ({ext})"

    # Also protect Microsoft / Windows folders inside AppData if critical
    local_app = os.path.normcase(os.environ.get("LOCALAPPDATA", ""))
    if local_app and norm_path.startswith(os.path.normcase(os.path.join(local_app, "Microsoft", "WindowsApps"))):
        return True, "Executável de aplicativo da Microsoft Store"

    return False, ""


def get_scan_presets() -> List[Dict[str, str]]:
    user_home = Path.home()
    presets = [
        {"id": "user_home", "name": f"Pasta do Usuário ({user_home.name})", "path": str(user_home)},
        {"id": "downloads", "name": "Pasta Downloads", "path": str(user_home / "Downloads")},
        {"id": "documents", "name": "Pasta Documentos", "path": str(user_home / "Documents")},
        {"id": "videos", "name": "Pasta Vídeos", "path": str(user_home / "Videos")},
        {"id": "desktop", "name": "Área de Trabalho", "path": str(user_home / "Desktop")},
        {"id": "drive_c", "name": "Disco Local Completo (C:\\)", "path": "C:\\"},
    ]
    return [p for p in presets if os.path.exists(p["path"])]


def scan_large_files(
    target_path: Optional[str] = None,
    min_size_mb: int = 100,
    category_filter: Optional[str] = None,
    limit: int = 250,
    reporter: Optional[ProgressReporter] = None,
) -> Dict[str, Any]:
    reporter = reporter or NullReporter()
    if not target_path or not os.path.exists(target_path):
        target_path = str(Path.home())

    min_bytes = max(1, int(min_size_mb)) * 1024 * 1024
    found_files: List[Dict[str, Any]] = []
    category_totals: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"size_bytes": 0, "count": 0})
    folder_totals: Dict[str, int] = defaultdict(int)
    total_scanned_files = 0
    total_large_bytes = 0

    base_skip = {
        "$recycle.bin",
        "system volume information",
        "node_modules",
        ".git",
        "__pycache__",
        ".venv",
        "venv",
        "cache",
        "code cache",
        "gpucache",
        "cache_data",
    }
    if os.path.normcase(target_path) == "c:\\":
        skip_dirs = base_skip | {"windows"}
    else:
        skip_dirs = base_skip

    reporter.update(label="Procurando arquivos grandes", scanned=0, found=0, current=target_path)
    stack = [target_path]
    while stack:
        current_dir = stack.pop()
        reporter.check()
        reporter.update(scanned=total_scanned_files, found=len(found_files), current=current_dir)
        try:
            with os.scandir(current_dir) as it:
                for entry in it:
                    try:
                        if is_link_or_junction(entry):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name.lower() not in skip_dirs:
                                stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total_scanned_files += 1
                            st = entry.stat(follow_symlinks=False)
                            fsize = st.st_size
                            if fsize < min_bytes:
                                continue

                            fpath = entry.path
                            fname = entry.name
                            cat = classify_file(fpath)
                            if category_filter and category_filter != "all" and cat != category_filter:
                                continue

                            protected, reason = is_protected_file(fpath)
                            mtime_str = datetime.fromtimestamp(st.st_mtime).strftime("%d/%m/%Y %H:%M")

                            category_totals[cat]["size_bytes"] += fsize
                            category_totals[cat]["count"] += 1
                            folder_totals[current_dir] += fsize
                            total_large_bytes += fsize

                            found_files.append(
                                {
                                    "name": fname,
                                    "path": fpath,
                                    "folder": current_dir,
                                    "extension": os.path.splitext(fname)[1].lower() or "sem ext",
                                    "category": cat,
                                    "size_bytes": fsize,
                                    "size_formatted": format_bytes(fsize),
                                    "modified": mtime_str,
                                    "protected": protected,
                                    "protection_reason": reason,
                                }
                            )
                    except Exception:
                        continue
        except Exception:
            continue

    found_files.sort(key=lambda x: x["size_bytes"], reverse=True)
    top_files = found_files[:limit]

    # Build category breakdown
    categories_breakdown = []
    for cat_name, data in sorted(category_totals.items(), key=lambda item: item[1]["size_bytes"], reverse=True):
        pct = round((data["size_bytes"] / total_large_bytes) * 100, 1) if total_large_bytes > 0 else 0.0
        categories_breakdown.append(
            {
                "category": cat_name,
                "size_bytes": data["size_bytes"],
                "size_formatted": format_bytes(data["size_bytes"]),
                "count": data["count"],
                "percent": pct,
            }
        )

    # Top 8 folders with large files
    top_folders = [
        {"folder": fld, "size_bytes": sz, "size_formatted": format_bytes(sz)}
        for fld, sz in sorted(folder_totals.items(), key=lambda x: x[1], reverse=True)[:8]
    ]

    return {
        "target_path": target_path,
        "min_size_mb": min_size_mb,
        "total_scanned_files": total_scanned_files,
        "total_matching_count": len(found_files),
        "total_large_bytes": total_large_bytes,
        "total_large_formatted": format_bytes(total_large_bytes),
        "categories": categories_breakdown,
        "top_folders": top_folders,
        "files": top_files,
    }


def open_in_explorer(filepath: str) -> Dict[str, Any]:
    norm_path = os.path.abspath(filepath)
    if not os.path.exists(norm_path):
        return {"success": False, "message": "Arquivo ou pasta não encontrado."}
    try:
        if os.path.isfile(norm_path):
            subprocess.Popen(["explorer.exe", f'/select,{norm_path}'])
        else:
            subprocess.Popen(["explorer.exe", norm_path])
        return {"success": True, "message": "Local aberto no Windows Explorer."}
    except Exception as e:
        return {"success": False, "message": str(e)}


def remove_files_safe(filepaths: List[str], permanent: bool = False) -> Dict[str, Any]:
    removed_count = 0
    bytes_freed = 0
    errors: List[str] = []

    for fp in filepaths:
        norm_fp = os.path.abspath(fp)
        if not os.path.exists(norm_fp):
            continue
        protected, reason = is_protected_file(norm_fp)
        if protected:
            errors.append(f"Bloqueado pela trava de segurança ({os.path.basename(norm_fp)}): {reason}")
            continue
        try:
            fsize = os.path.getsize(norm_fp)
            if permanent:
                os.chmod(norm_fp, 0o666)
                os.remove(norm_fp)
            else:
                send2trash(norm_fp)
            removed_count += 1
            bytes_freed += fsize
        except Exception as e:
            errors.append(f"{os.path.basename(norm_fp)}: {str(e)}")

    if removed_count > 0:
        mode_str = "Exclusão permanente" if permanent else "Enviado para a Lixeira"
        record_action(
            action_type="large_files",
            title=f"Remoção de Arquivos ({mode_str})",
            details=f"{removed_count} arquivo(s) removido(s) ({format_bytes(bytes_freed)})",
            bytes_cleaned=bytes_freed,
            files_removed=removed_count,
        )

    return {
        "success": removed_count > 0 or len(errors) == 0,
        "removed_count": removed_count,
        "bytes_freed": bytes_freed,
        "formatted_freed": format_bytes(bytes_freed),
        "errors": errors,
    }


def _partial_hash(filepath: str, chunk_size: int = 4096) -> Optional[str]:
    try:
        fsize = os.path.getsize(filepath)
        h = hashlib.md5()
        with open(filepath, "rb") as f:
            h.update(f.read(chunk_size))
            if fsize > chunk_size * 2:
                f.seek(fsize - chunk_size)
                h.update(f.read(chunk_size))
        return h.hexdigest()
    except Exception:
        return None


def _full_hash(filepath: str, reporter: Optional[ProgressReporter] = None) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(filepath, "rb") as f:
            while True:
                if reporter is not None:
                    reporter.check()
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def scan_duplicates(
    target_path: Optional[str] = None,
    min_size_kb: int = 100,
    reporter: Optional[ProgressReporter] = None,
) -> Dict[str, Any]:
    reporter = reporter or NullReporter()
    user_home = Path.home()
    if not target_path or not os.path.exists(target_path):
        # Scan common user folders by default so it's super fast and safe
        scan_roots = [
            str(user_home / "Downloads"),
            str(user_home / "Documents"),
            str(user_home / "Pictures"),
            str(user_home / "Videos"),
            str(user_home / "Desktop"),
        ]
        scan_roots = [r for r in scan_roots if os.path.exists(r)]
    else:
        scan_roots = [target_path]

    min_bytes = max(1, int(min_size_kb)) * 1024
    skip_dirs = {
        "node_modules",
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        "appdata",
        "$recycle.bin",
        "system volume information",
        ".gemini",
    }

    size_groups: Dict[int, List[str]] = defaultdict(list)
    total_scanned = 0

    reporter.update(label="Listando arquivos", scanned=0, current="")
    stack = list(scan_roots)
    while stack:
        current_dir = stack.pop()
        reporter.check()
        reporter.update(scanned=total_scanned, current=current_dir)
        try:
            with os.scandir(current_dir) as it:
                for entry in it:
                    try:
                        if is_link_or_junction(entry):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name.lower() not in skip_dirs:
                                stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total_scanned += 1
                            st = entry.stat(follow_symlinks=False)
                            if st.st_size >= min_bytes:
                                protected, _ = is_protected_file(entry.path)
                                if not protected:
                                    size_groups[st.st_size].append(entry.path)
                    except Exception:
                        continue
        except Exception:
            continue

    # Stage 2: Partial hash for same-size files
    partial_groups: Dict[Tuple[int, str], List[str]] = defaultdict(list)
    same_size = [(fsize, p) for fsize, paths in size_groups.items() if len(paths) >= 2 for p in paths]
    reporter.update(label="Comparando arquivos do mesmo tamanho", done=0, total=len(same_size))
    for i, (fsize, p) in enumerate(same_size):
        if i % 25 == 0:
            reporter.check()
            reporter.update(done=i, current=p)
        ph = _partial_hash(p)
        if ph:
            partial_groups[(fsize, ph)].append(p)

    # Stage 3: Full SHA-256 hash for partial matches
    duplicate_groups = []
    total_wasted_bytes = 0
    total_extra_copies = 0

    to_confirm = sum(len(paths) for paths in partial_groups.values() if len(paths) >= 2)
    confirmed = 0
    reporter.update(label="Confirmando cópias idênticas (SHA-256)", done=0, total=to_confirm)
    for (fsize, _), paths in partial_groups.items():
        if len(paths) < 2:
            continue
        full_map: Dict[str, List[str]] = defaultdict(list)
        for p in paths:
            reporter.update(done=confirmed, current=p)
            confirmed += 1
            fh = _full_hash(p, reporter)
            if fh:
                full_map[fh].append(p)

        for fh, identical_paths in full_map.items():
            if len(identical_paths) < 2:
                continue
            # Sort by modification time (keep oldest/original first)
            try:
                identical_paths.sort(key=lambda x: os.path.getmtime(x))
            except Exception:
                pass

            wasted = fsize * (len(identical_paths) - 1)
            total_wasted_bytes += wasted
            total_extra_copies += len(identical_paths) - 1

            files_info = []
            for idx, ipath in enumerate(identical_paths):
                try:
                    mtime = datetime.fromtimestamp(os.path.getmtime(ipath)).strftime("%d/%m/%Y %H:%M")
                except Exception:
                    mtime = ""
                files_info.append(
                    {
                        "path": ipath,
                        "name": os.path.basename(ipath),
                        "folder": os.path.dirname(ipath),
                        "modified": mtime,
                        "is_original": idx == 0,
                    }
                )

            duplicate_groups.append(
                {
                    "hash": fh[:12],
                    "name": os.path.basename(identical_paths[0]),
                    "size_bytes": fsize,
                    "size_formatted": format_bytes(fsize),
                    "wasted_bytes": wasted,
                    "wasted_formatted": format_bytes(wasted),
                    "count": len(identical_paths),
                    "files": files_info,
                }
            )

    duplicate_groups.sort(key=lambda g: g["wasted_bytes"], reverse=True)

    return {
        "scan_roots": scan_roots,
        "total_scanned": total_scanned,
        "groups_count": len(duplicate_groups),
        "total_extra_copies": total_extra_copies,
        "total_wasted_bytes": total_wasted_bytes,
        "total_wasted_formatted": format_bytes(total_wasted_bytes),
        "groups": duplicate_groups[:100],
    }
