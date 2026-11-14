"""Windows system restore point and diagnostic repair tools (SFC, DISM, CHKDSK)."""

import subprocess
from typing import Any, Dict

from core.health import is_admin
from core.history import record_action


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
