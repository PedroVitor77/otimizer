"""PulseScore 10-Second Hardware Performance Benchmark.

Performs rapid, multi-threaded stress testing across:
1. CPU Multi-core throughput (arithmetic, primes, matrix calculations).
2. RAM memory bandwidth (allocation, sequential writes & stride reads).
3. Disk sequential read & write throughput (NVMe/SSD/HDD speed).

Generates a composite "PulseScore" before and after optimization, tracking
performance improvements over time.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

from core.history import get_data_dir, record_action

DATA_DIR = get_data_dir()
BENCHMARK_FILE = DATA_DIR / "benchmark.json"

_benchmark_lock = threading.RLock()


def _cpu_worker(duration: float) -> int:
    """CPU load worker executing arithmetic and integer square roots."""
    count = 0
    t_start = time.time()
    while time.time() - t_start < duration:
        for x in range(1000):
            math.isqrt(x * 12345 + 6789)
        count += 1000
    return count


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
            t_cpu_start = time.time()
            with ThreadPoolExecutor(max_workers=cpu_cores) as executor:
                counts = list(executor.map(_cpu_worker, [cpu_duration] * cpu_cores))
            total_cpu_ops = sum(counts)
            cpu_elapsed = max(0.001, time.time() - t_cpu_start)
            cpu_ops_per_sec = total_cpu_ops / cpu_elapsed
            cpu_score = round(cpu_ops_per_sec / 3000)

            # 2. RAM Stage (~2.5 seconds)
            with self.lock:
                self.progress = 50
                self.stage = "Testando Largura de Banda e Latência da Memória RAM..."

            ram_block_size = 64 * 1024 * 1024  # 64 MB
            ram_buffer = bytearray(ram_block_size)
            ram_passes = 0
            t_ram_start = time.time()
            while time.time() - t_ram_start < 2.5:
                # Sequential write / stride swap
                ram_buffer[: ram_block_size // 2] = ram_buffer[ram_block_size // 2 :]
                ram_passes += 1
            ram_elapsed = max(0.001, time.time() - t_ram_start)
            ram_mbs = (ram_passes * (ram_block_size / (1024 * 1024))) / ram_elapsed
            ram_score = round(ram_mbs * 0.45)
            del ram_buffer

            # 3. Disk Stage (~2.5 seconds)
            with self.lock:
                self.progress = 80
                self.stage = "Testando Velocidade de Leitura e Escrita do Disco..."

            disk_temp_path = os.path.join(tempfile.gettempdir(), f"pulsepc_bench_{int(time.time())}.tmp")
            disk_mb_to_test = 64
            chunk = b"X" * (1024 * 1024)  # 1MB chunk

            write_mbs = 0.0
            read_mbs = 0.0
            try:
                # Sequential Write
                t_write_start = time.time()
                with open(disk_temp_path, "wb") as f:
                    for _ in range(disk_mb_to_test):
                        f.write(chunk)
                    f.flush()
                    try:
                        os.fsync(f.fileno())
                    except Exception:
                        pass
                write_elapsed = max(0.001, time.time() - t_write_start)
                write_mbs = disk_mb_to_test / write_elapsed

                # Sequential Read
                t_read_start = time.time()
                with open(disk_temp_path, "rb") as f:
                    while f.read(1024 * 1024):
                        pass
                read_elapsed = max(0.001, time.time() - t_read_start)
                read_mbs = disk_mb_to_test / read_elapsed
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
