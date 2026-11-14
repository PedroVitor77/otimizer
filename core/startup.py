"""Windows startup item discovery and toggle (Registry + Startup folder)."""

import os
from pathlib import Path
import shutil
from typing import Any, Dict, List
import winreg

from core.history import record_action

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

    items.extend(_read_reg_startup(winreg.HKEY_CURRENT_USER, "HKCU", RUN_KEY_PATH, True))
    items.extend(_read_reg_startup(winreg.HKEY_CURRENT_USER, "HKCU", DISABLED_KEY_PATH, False))
    items.extend(_read_reg_startup(winreg.HKEY_LOCAL_MACHINE, "HKLM", RUN_KEY_PATH, True))
    items.extend(_read_reg_startup(winreg.HKEY_LOCAL_MACHINE, "HKLM", DISABLED_KEY_PATH, False))

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
