"""PulseScore 10-Second Hardware Performance Benchmark.

Performs rapid, multi-threaded stress testing across:
1. CPU Multi-core throughput (arithmetic, primes, matrix calculations).
2. RAM memory bandwidth (allocation, sequential writes & stride reads).
3. Disk sequential read & write throughput (NVMe/SSD/HDD speed).

Generates a composite "PulseScore" before and after optimization, tracking
performance improvements over time.
"""

from concurrent.futures import ThreadPoolExecutor
import ctypes
import ctypes.wintypes as wintypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from core.history import get_data_dir, record_action

DATA_DIR = get_data_dir()
BENCHMARK_FILE = DATA_DIR / "benchmark.json"

_benchmark_lock = threading.RLock()
_CPU_BLOCK = b"PulsePC-Bench-" * (256 * 1024 // 14)


def _cpu_worker(duration: float, block: bytes = _CPU_BLOCK) -> int:
    """GIL-free CPU throughput worker using C-backed SHA-256 hashing across cores."""
    count = 0
    t_start = time.perf_counter()
    while time.perf_counter() - t_start < duration:
        hashlib.sha256(block).digest()
        count += 1
    return count


def _run_disk_bench_win32_unbuffered(disk_temp_path: str, total_mb: int) -> Optional[Tuple[float, float]]:
    """Run sequential write/read bypassing the Windows OS page cache (FILE_FLAG_NO_BUFFERING)."""
    if os.name != "nt":
        return None
    k32 = ctypes.windll.kernel32
    k32.VirtualAlloc.restype = ctypes.c_void_p
    k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
    k32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]

    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    CREATE_ALWAYS = 2
    OPEN_EXISTING = 3
    FILE_FLAG_NO_BUFFERING = 0x20000000
    FILE_FLAG_WRITE_THROUGH = 0x80000000
    INVALID_HANDLE = wintypes.HANDLE(-1).value
    MEM_COMMIT_RESERVE = 0x3000
    MEM_RELEASE = 0x8000
    PAGE_READWRITE = 0x04

    chunk_sz = 1024 * 1024
    buf = k32.VirtualAlloc(None, chunk_sz, MEM_COMMIT_RESERVE, PAGE_READWRITE)
    if not buf:
        return None
    try:
        ctypes.memset(buf, 0x58, chunk_sz)

        # Unbuffered sequential write
        hw = k32.CreateFileW(
            disk_temp_path, GENERIC_WRITE, 0, None, CREATE_ALWAYS,
            FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, None,
        )
        if hw == INVALID_HANDLE:
            return None
        try:
            written = wintypes.DWORD(0)
            t_w0 = time.perf_counter()
            for _ in range(total_mb):
                if not k32.WriteFile(hw, ctypes.c_void_p(buf), chunk_sz, ctypes.byref(written), None):
                    return None
            write_elapsed = max(0.001, time.perf_counter() - t_w0)
        finally:
            k32.CloseHandle(hw)

        # Unbuffered sequential read
        hr = k32.CreateFileW(
            disk_temp_path, GENERIC_READ, 0, None, OPEN_EXISTING,
            FILE_FLAG_NO_BUFFERING, None,
        )
        if hr == INVALID_HANDLE:
            return None
        try:
            read_n = wintypes.DWORD(0)
            t_r0 = time.perf_counter()
            while k32.ReadFile(hr, ctypes.c_void_p(buf), chunk_sz, ctypes.byref(read_n), None) and read_n.value > 0:
                pass
            read_elapsed = max(0.001, time.perf_counter() - t_r0)
        finally:
            k32.CloseHandle(hr)

        return (total_mb / write_elapsed, total_mb / read_elapsed)
    except Exception:
        return None
    finally:
        k32.VirtualFree(buf, 0, MEM_RELEASE)


class BenchmarkRunner:
    """Manages the background execution and state of the 10-second benchmark."""

    def __init__(self):
        self.lock = threading.RLock()
        self.status: str = "idle"  # idle | running | completed | error
        self.progress: int = 0  # 0 to 100
        self.stage: str = ""
        self.error_message: Optional[str] = None
        self.current_result: Optional[Dict[str, Any]] = None
        self._thread: Optional[threading.Thread] = None

    def get_status(self) -> Dict[str, Any]:
        with self.lock:
            history_data = self.load_data()
            return {
                "status": self.status,
                "progress": self.progress,
                "stage": self.stage,
                "error": self.error_message,
                "latest_result": self.current_result or history_data.get("latest"),
                "previous_result": history_data.get("previous"),
                "gain": history_data.get("gain"),
            }

    def load_data(self) -> Dict[str, Any]:
        with self.lock:
            if not BENCHMARK_FILE.exists():
                return {"latest": None, "previous": None, "gain": None, "history": []}
            try:
                with open(BENCHMARK_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return {"latest": None, "previous": None, "gain": None, "history": []}

    def _save_data(self, data: Dict[str, Any]) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(BENCHMARK_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    def start(self) -> Dict[str, Any]:
        """Start benchmark asynchronously in background thread."""
        with self.lock:
            if self.status == "running":
                return {"success": False, "message": "O benchmark já está em execução."}

            self.status = "running"
            self.progress = 5
            self.stage = "Iniciando teste de desempenho..."
            self.error_message = None

            self._thread = threading.Thread(target=self._run_benchmark_flow, daemon=True, name="BenchmarkWorker")
            self._thread.start()
            return {"success": True, "message": "Benchmark iniciado."}

    def _run_benchmark_flow(self) -> None:
        try:
            # 1. CPU Stage (~3.5 seconds)
            with self.lock:
                self.progress = 15
                self.stage = "Testando CPU (cálculos aritméticos)..."

            cpu_cores = os.cpu_count() or 4
            cpu_duration = 3.0
            t_cpu_start = time.perf_counter()
            with ThreadPoolExecutor(max_workers=cpu_cores) as executor:
                counts = list(executor.map(_cpu_worker, [cpu_duration] * cpu_cores))
            total_cpu_ops = sum(counts)
            cpu_elapsed = max(0.001, time.perf_counter() - t_cpu_start)
            cpu_ops_per_sec = total_cpu_ops / cpu_elapsed
            cpu_score = round(cpu_ops_per_sec / 20)

            # 2. RAM Stage (~2.5 seconds)
            with self.lock:
                self.progress = 50
                self.stage = "Testando Largura de Banda e Latência da Memória RAM..."

            ram_block_size = 64 * 1024 * 1024  # 64 MB buffer, 32 MB copied per slice pass
            half_block = ram_block_size // 2
            ram_buffer = bytearray(ram_block_size)
            ram_passes = 0
            t_ram_start = time.perf_counter()
            while time.perf_counter() - t_ram_start < 2.5:
                # Sequential write / stride swap (32 MB copied per pass)
                ram_buffer[:half_block] = ram_buffer[half_block:]
                ram_passes += 1
            ram_elapsed = max(0.001, time.perf_counter() - t_ram_start)
            ram_mbs = (ram_passes * (half_block / (1024 * 1024))) / ram_elapsed
            ram_score = round(ram_mbs * 0.45)
            del ram_buffer

            # 3. Disk Stage (~2.5 seconds)
            with self.lock:
                self.progress = 80
                self.stage = "Testando Velocidade de Leitura e Escrita do Disco..."

            disk_temp_path = os.path.join(tempfile.gettempdir(), f"pulsepc_bench_{int(time.time())}.tmp")
            disk_mb_to_test = 64
            write_mbs = 0.0
            read_mbs = 0.0
            try:
                unbuffered = _run_disk_bench_win32_unbuffered(disk_temp_path, disk_mb_to_test)
                if unbuffered is not None:
                    write_mbs, read_mbs = unbuffered
                else:
                    chunk = b"X" * (1024 * 1024)
                    t_write_start = time.perf_counter()
                    with open(disk_temp_path, "wb") as f:
                        for _ in range(disk_mb_to_test):
                            f.write(chunk)
                        f.flush()
                        try:
                            os.fsync(f.fileno())
                        except Exception:
                            pass
                    write_mbs = disk_mb_to_test / max(0.001, time.perf_counter() - t_write_start)

                    t_read_start = time.perf_counter()
                    with open(disk_temp_path, "rb") as f:
                        while f.read(1024 * 1024):
                            pass
                    read_mbs = disk_mb_to_test / max(0.001, time.perf_counter() - t_read_start)
            finally:
                if os.path.exists(disk_temp_path):
                    try:
                        os.remove(disk_temp_path)
                    except Exception:
                        pass

            disk_throughput = (write_mbs * 0.4) + (read_mbs * 0.6)
            disk_score = round(disk_throughput * 2.2)

            # 4. Composite PulseScore Calculation
            with self.lock:
                self.progress = 95
                self.stage = "Calculando PulseScore final..."

            pulse_score = round(cpu_score * 0.40 + ram_score * 0.35 + disk_score * 0.25)

            now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
            result = {
                "timestamp": now_str,
                "pulse_score": pulse_score,
                "cpu_score": cpu_score,
                "cpu_ops_sec": round(cpu_ops_per_sec),
                "ram_score": ram_score,
                "ram_mbs": round(ram_mbs, 1),
                "disk_score": disk_score,
                "disk_write_mbs": round(write_mbs, 1),
                "disk_read_mbs": round(read_mbs, 1),
            }

            # Update history and calculate gain compared to previous run
            history_data = self.load_data()
            prev_result = history_data.get("latest")
            gain = None
            if prev_result and prev_result.get("pulse_score"):
                prev_score = prev_result["pulse_score"]
                diff = pulse_score - prev_score
                pct = round((diff / prev_score) * 100, 1)
                gain = {
                    "diff_points": diff,
                    "percent": pct,
                    "is_positive": diff >= 0,
                }

            all_history = history_data.get("history", [])
            all_history.append(result)
            if len(all_history) > 20:
                all_history = all_history[-20:]

            saved_payload = {
                "latest": result,
                "previous": prev_result,
                "gain": gain,
                "history": all_history,
            }
            self._save_data(saved_payload)

            record_action(
                action_type="benchmark",
                title="PulseScore Benchmark Concluído",
                details=(
                    f"PulseScore: {pulse_score} pts | CPU: {cpu_score} | RAM: {round(ram_mbs, 1)} MB/s | "
                    f"Disco: {round(read_mbs, 1)} MB/s"
                    + (f" ({gain['percent']:+0.1f}% ganho)" if gain else "")
                ),
            )

            with self.lock:
                self.current_result = result
                self.progress = 100
                self.stage = "Concluído!"
                self.status = "completed"

        except Exception as e:
            with self.lock:
                self.status = "error"
                self.error_message = str(e)
                self.stage = "Erro ao executar benchmark."


# Global singleton benchmark runner
benchmark_runner = BenchmarkRunner()
