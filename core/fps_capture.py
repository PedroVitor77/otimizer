"""Real FPS of the game that is running, read with Intel's PresentMon.

PresentMon listens to the Windows graphics events (ETW) and reports one CSV row for every frame a
process presents. This module runs it for the game's process, parses the rows and keeps the last
seconds of frame times, from which it computes the current FPS, the frame time and the 1% low.

The PresentMon console executable is looked for (in this order) at:
  1. the PULSEPC_PRESENTMON environment variable,
  2. assets/tools/PresentMon.exe (bundled with the app),
  3. %LOCALAPPDATA%/PulsePC/tools/PresentMon.exe,
  4. PresentMon on the PATH.
Windows lets an administrator (or a member of "Performance Log Users") start the ETW session. PresentMon
also runs for a normal user, but then it cannot see games started by another account. When it refuses to
start, the status is "needs_admin" and no number is shown.
"""
import atexit
import csv
import ctypes
from ctypes import wintypes
from collections import deque
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Deque, Dict, List, Optional, Tuple


SESSION_NAME = "PulsePC_FPS"
FRAME_TIME_COLUMNS = ("MsBetweenPresents", "msBetweenPresents")  # PresentMon 2.x / 1.x
WINDOW_S = 1.0           # frames in the last second give the "current" FPS
LOW_WINDOW_S = 10.0      # frames in the last 10 s give the 1% low
STALE_S = 2.5            # no frame for this long: the game is not drawing (minimized, loading)
IDLE_STOP_S = 15.0       # nobody asked for the FPS for this long: stop measuring
_ADMIN_HINTS = ("administrator", "access is denied", "access denied", "performance log users", "error 5", "0x5")


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def find_presentmon() -> Optional[Path]:
    env = os.environ.get("PULSEPC_PRESENTMON")
    candidates: List[Path] = [Path(env)] if env else []
    candidates.append(_base_dir() / "assets" / "tools" / "PresentMon.exe")
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        candidates.append(Path(local_app) / "PulsePC" / "tools" / "PresentMon.exe")
    found = shutil.which("PresentMon")
    if found:
        candidates.append(Path(found))
    return next((c for c in candidates if c.is_file()), None)


# --- Child process is killed with PulsePC, even when PulsePC exits through os._exit ---
_job_handle = None


def _kill_with_parent(proc: subprocess.Popen) -> None:
    global _job_handle
    try:
        kernel32 = ctypes.windll.kernel32

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]

        if _job_handle is None:
            job = kernel32.CreateJobObjectW(None, None)
            info = EXTENDED()
            info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
            _job_handle = job
        kernel32.AssignProcessToJobObject(_job_handle, int(proc._handle))
    except Exception:
        pass


def percentile_low_fps(frame_times_ms: List[float]) -> Optional[int]:
    """1% low: FPS of the average of the slowest 1% of the frames (at least the single slowest)."""
    if not frame_times_ms:
        return None
    worst = sorted(frame_times_ms, reverse=True)
    n = max(1, int(len(worst) * 0.01))
    avg = sum(worst[:n]) / n
    return int(round(1000.0 / avg)) if avg > 0 else None


def compute_stats(frames: List[Tuple[float, float]], now: float) -> Dict[str, Any]:
    """frames: (arrival time, frame time in ms) in arrival order. Returns the numbers for the UI."""
    last = [ft for t, ft in frames if now - t <= WINDOW_S]
    if len(last) < 2 or not frames or now - frames[-1][0] > STALE_S:
        return {"fps": None, "frame_time_ms": None, "fps_1pct_low": None}
    total_ms = sum(last)
    fps = 1000.0 * len(last) / total_ms if total_ms > 0 else None
    low = percentile_low_fps([ft for t, ft in frames if now - t <= LOW_WINDOW_S])
    return {
        "fps": int(round(fps)) if fps else None,
        "frame_time_ms": round(total_ms / len(last), 1),
        "fps_1pct_low": low,
    }


class FpsCapture:
    """One PresentMon process for one game at a time."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: Optional[subprocess.Popen] = None
        self._pid: Optional[int] = None
        self._frames: Deque[Tuple[float, float]] = deque(maxlen=6000)
        self._status = "idle"   # idle | no_tool | needs_admin | starting | running | error
        self._message = ""
        self._first_frame = False
        self._output_tail: Deque[str] = deque(maxlen=6)
        self._last_request = 0.0
        self._started_at = 0.0

    # ----- public -----
    def ensure(self, pid: int) -> None:
        """Make sure the game `pid` is being measured. Cheap to call on every poll."""
        with self._lock:
            self._last_request = time.monotonic()
            if self._proc and self._pid == pid and self._proc.poll() is None:
                return
            if self._status in ("no_tool", "needs_admin") and self._pid == pid:
                return  # nothing changed that would make a retry succeed
            self._stop_locked()
            self._pid = pid
            self._start_locked(pid)

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()
            self._pid = None
            self._status = "idle"
            self._message = ""

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            self._last_request = time.monotonic()
            status, message = self._status, self._message
            frames = list(self._frames)
        stats = compute_stats(frames, time.monotonic()) if status == "running" else {
            "fps": None, "frame_time_ms": None, "fps_1pct_low": None}
        if status == "running" and stats["fps"] is None:
            status = "no_frames" if self._first_frame else "starting"
        return {"fps_status": status, "fps_message": self._message_for(status, message),
                "fps_current": stats["fps"], "frame_time_ms": stats["frame_time_ms"],
                "fps_1pct_low": stats["fps_1pct_low"]}

    # ----- internals -----
    @staticmethod
    def _message_for(status: str, detail: str) -> str:
        return {
            "no_tool": "Falta o PresentMon (assets/tools/PresentMon.exe) para medir o FPS do jogo.",
            "needs_admin": "Medir o FPS do jogo exige o modo administrador.",
            "starting": "Iniciando a medição...",
            "no_frames": "O jogo não está desenhando quadros agora (minimizado ou carregando).",
            "error": detail or "Não foi possível medir o FPS.",
        }.get(status, "")

    def _stop_locked(self) -> None:
        proc, self._proc = self._proc, None
        self._frames.clear()
        self._first_frame = False
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def _start_locked(self, pid: int) -> None:
        exe = find_presentmon()
        if not exe:
            self._status = "no_tool"
            return
        cmd = [
            str(exe), "--process_id", str(pid), "--output_stdout", "--no_console_stats",
            "--session_name", SESSION_NAME, "--stop_existing_session", "--terminate_on_proc_exit",
        ]
        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception as e:
            self._status = "error"
            self._message = str(e)
            return
        _kill_with_parent(proc)
        self._proc = proc
        self._status = "running"
        self._message = ""
        self._started_at = time.monotonic()
        threading.Thread(target=self._reader, args=(proc,), daemon=True, name="FpsReader").start()
        threading.Thread(target=self._idle_watchdog, args=(proc,), daemon=True, name="FpsIdleWatchdog").start()

    def _reader(self, proc: subprocess.Popen) -> None:
        col: Optional[int] = None
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if col is None:
                    fields = next(csv.reader([line]))
                    idx = next((fields.index(n) for n in FRAME_TIME_COLUMNS if n in fields), None)
                    if idx is None:
                        # Not the CSV header. PresentMon prints a multi-line "warning: ... elevated privilege"
                        # when not elevated; that is only a warning, so it is not kept as an error.
                        if not line.lower().startswith("warning") and not line[:1].isspace():
                            self._output_tail.append(line[:200])
                        continue
                    col = idx
                    continue
                try:
                    ms = float(next(csv.reader([line]))[col])
                except (ValueError, IndexError):
                    continue
                if ms <= 0:
                    continue
                with self._lock:
                    if self._proc is proc:
                        self._frames.append((time.monotonic(), ms))
                        self._first_frame = True
        except Exception:
            pass
        finally:
            with self._lock:
                if self._proc is proc:
                    self._on_exit_locked(proc, had_header=col is not None)

    def _on_exit_locked(self, proc: subprocess.Popen, had_header: bool) -> None:
        self._proc = None
        if had_header:
            self._status = "idle"  # the game closed: PresentMon ended with it
            return
        tail = " ".join(self._output_tail).lower()
        if any(h in tail for h in _ADMIN_HINTS):
            self._status = "needs_admin"
        else:
            self._status = "error"
            self._message = ("O PresentMon fechou sem medir: " + " ".join(self._output_tail))[:220]

    def _idle_watchdog(self, proc: subprocess.Popen) -> None:
        while True:
            time.sleep(3.0)
            with self._lock:
                if self._proc is not proc:
                    return
                if time.monotonic() - self._last_request > IDLE_STOP_S:
                    self._stop_locked()
                    self._status = "idle"
                    return


capture = FpsCapture()
atexit.register(capture.stop)
