"""Battery & Energy Health Diagnostics for Laptops and Portable PCs.

Analyzes battery health, wear level percentage, full charge vs. design capacity (mWh),
cycle counts, charging status, and power draw.
On desktop computers, cleanly detects absence of battery and reports direct AC power.
"""

from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional
import xml.etree.ElementTree as ET

import psutil

from core.health import format_bytes

_battery_cache: Optional[Dict[str, Any]] = None
_battery_cache_ts: float = 0.0
_battery_lock = threading.Lock()


def get_battery_report(force_refresh: bool = False) -> Dict[str, Any]:
    """Retrieve detailed battery health report and wear analysis."""
    global _battery_cache, _battery_cache_ts
    now = time.time()
    with _battery_lock:
        if not force_refresh and _battery_cache is not None and (now - _battery_cache_ts < 25.0):
            return _battery_cache

    bat_sensor = None
    try:
        bat_sensor = psutil.sensors_battery()
    except Exception:
        pass

    # If psutil returns None, it is almost certainly a Desktop PC without battery
    if bat_sensor is None:
        report = {
            "is_laptop": False,
            "has_battery": False,
            "device_type": "Desktop PC",
            "message": "Computador Desktop (Alimentação Direta via Fonte AC) — Nenhuma bateria instalada.",
            "design_capacity_mwh": None,
            "full_charge_capacity_mwh": None,
            "wear_percent": 0.0,
            "health_percent": 100.0,
            "cycle_count": None,
            "status_label": "Alimentação AC Direta",
            "status_tone": "ok",
            "power_plugged": True,
            "percent_remaining": 100,
            "secs_remaining": None,
            "time_remaining_formatted": "Ilimitado (Conectado à tomada)",
        }
        with _battery_lock:
            _battery_cache = report
            _battery_cache_ts = now
        return report

    # On a portable device with a battery, generate Windows battery report XML
    temp_dir = Path(tempfile.gettempdir())
    report_xml = temp_dir / f"pulsepc_bat_{os.getpid()}.xml"

    design_mwh: Optional[int] = None
    full_mwh: Optional[int] = None
    cycles: Optional[int] = None
    chemistry = "LION"
    manufacturer = "Fabricante da Bateria"
    serial_no = "--"

    try:
        res = subprocess.run(
            ["powercfg", "/batteryreport", "/xml", "/output", str(report_xml)],
            capture_output=True,
            timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and report_xml.exists():
            tree = ET.parse(str(report_xml))
            root = tree.getroot()

            # Namespace handling
            ns = ""
            if "}" in root.tag:
                ns = root.tag.split("}")[0] + "}"

            # Parse Batteries section
            for bat in root.findall(f".//{ns}Battery"):
                cap_design = bat.find(f"{ns}DesignCapacity")
                cap_full = bat.find(f"{ns}FullChargeCapacity")
                cycle_elem = bat.find(f"{ns}CycleCount")
                chem_elem = bat.find(f"{ns}Chemistry")
                manuf_elem = bat.find(f"{ns}Manufacturer")
                serial_elem = bat.find(f"{ns}SerialNumber")

                if cap_design is not None and cap_design.text and cap_design.text.isdigit():
                    design_mwh = int(cap_design.text)
                if cap_full is not None and cap_full.text and cap_full.text.isdigit():
                    full_mwh = int(cap_full.text)
                if cycle_elem is not None and cycle_elem.text and cycle_elem.text.isdigit():
                    cycles = int(cycle_elem.text)
                if chem_elem is not None and chem_elem.text:
                    chemistry = chem_elem.text.strip()
                if manuf_elem is not None and manuf_elem.text:
                    manufacturer = manuf_elem.text.strip()
                if serial_elem is not None and serial_elem.text:
                    serial_no = serial_elem.text.strip()
                break
    except Exception:
        pass
    finally:
        if report_xml.exists():
            try:
                os.remove(str(report_xml))
            except Exception:
                pass

    # Fallback to WMI if powercfg didn't populate capacities
    if not design_mwh or not full_mwh:
        try:
            ps_cmd = (
                "$st = Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1 DesignedCapacity; "
                "$fc = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1 FullChargedCapacity; "
                "Write-Output \"$($st.DesignedCapacity),$($fc.FullChargedCapacity)\""
            )
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True,
                text=True,
                timeout=3,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if r.returncode == 0 and r.stdout.strip():
                parts = r.stdout.strip().split(",")
                if len(parts) >= 2:
                    if parts[0].isdigit() and int(parts[0]) > 0:
                        design_mwh = int(parts[0])
                    if parts[1].isdigit() and int(parts[1]) > 0:
                        full_mwh = int(parts[1])
        except Exception:
            pass

    # Wear & Health Calculations
    wear_percent = 0.0
    health_percent = 100.0
    if design_mwh and full_mwh and design_mwh > 0:
        health_percent = round(min(100.0, (full_mwh / design_mwh) * 100.0), 1)
        wear_percent = round(max(0.0, 100.0 - health_percent), 1)

    # Health evaluation
    if wear_percent < 12.0:
        status_label = "Excelente (Bateria com capacidade quase de fábrica)"
        status_tone = "great"
    elif wear_percent < 25.0:
        status_label = "Bom (Desgaste natural de uso)"
        status_tone = "ok"
    elif wear_percent < 45.0:
        status_label = "Moderado (Autonomia reduzida)"
        status_tone = "warn"
    else:
        status_label = "Atenção (Desgaste severo - recomendada substituição)"
        status_tone = "bad"

    # Time remaining
    secs_left = bat_sensor.secsleft if bat_sensor and bat_sensor.secsleft not in (
        psutil.POWER_TIME_UNLIMITED,
        psutil.POWER_TIME_UNKNOWN,
    ) else None

    formatted_time = None
    if secs_left is not None and secs_left > 0:
        h = secs_left // 3600
        m = (secs_left % 3600) // 60
        formatted_time = f"{h}h {m}m restantes" if h > 0 else f"{m}m restantes"
    elif bat_sensor and bat_sensor.power_plugged:
        formatted_time = "Conectado à tomada (Carregando / AC)"

    report = {
        "is_laptop": True,
        "has_battery": True,
        "device_type": "Notebook / Portátil",
        "percent_remaining": round(bat_sensor.percent, 0) if bat_sensor else 100,
        "power_plugged": bool(bat_sensor.power_plugged) if bat_sensor else True,
        "secs_remaining": secs_left,
        "time_remaining_formatted": formatted_time or "--",
        "design_capacity_mwh": design_mwh,
        "full_charge_capacity_mwh": full_mwh,
        "health_percent": health_percent,
        "wear_percent": wear_percent,
        "cycle_count": cycles,
        "chemistry": chemistry,
        "manufacturer": manufacturer,
        "serial_number": serial_no,
        "status_label": status_label,
        "status_tone": status_tone,
    }

    with _battery_lock:
        _battery_cache = report
        _battery_cache_ts = now

    return report


def generate_battery_html_report() -> Dict[str, Any]:
    """Generates the official Windows HTML battery report and opens it in default browser."""
    try:
        temp_dir = Path(tempfile.gettempdir())
        report_html = temp_dir / "PulsePC_BatteryReport.html"
        res = subprocess.run(
            ["powercfg", "/batteryreport", "/output", str(report_html)],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and report_html.exists():
            try:
                os.startfile(str(report_html))
            except Exception:
                pass
            return {"success": True, "path": str(report_html)}
        return {"success": False, "error": res.stderr or "Não foi possível gerar o relatório de bateria."}
    except Exception as e:
        return {"success": False, "error": str(e)}

