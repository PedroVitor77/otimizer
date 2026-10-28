"""Background jobs for long scans, so the UI can show progress and cancel them.

A job runs a scan function in its own thread. The function receives a `reporter` it uses to
publish progress and to check whether the user asked to cancel (`reporter.check()` raises
ScanCancelled). The UI polls the job by id.
"""
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional


class ScanCancelled(Exception):
    """Raised inside a scan when the user cancelled it."""


class ProgressReporter:
    def __init__(self) -> None:
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self.progress: Dict[str, Any] = {}

    def update(self, **fields: Any) -> None:
        with self._lock:
            self.progress.update(fields)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self.progress)

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check(self) -> None:
        if self._cancel.is_set():
            raise ScanCancelled()


class NullReporter(ProgressReporter):
    """Used when a scan runs synchronously (old endpoints, Super Boost): reports go nowhere."""

    def update(self, **fields: Any) -> None:
        pass


class Job:
    def __init__(self, kind: str) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "running"  # running | done | cancelled | error
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        self.reporter = ProgressReporter()
        self.started = time.time()
        self.finished: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.reporter.snapshot(),
            "elapsed_s": round((self.finished or time.time()) - self.started, 1),
            "result": self.result if self.status == "done" else None,
            "error": self.error,
        }


_jobs: Dict[str, Job] = {}
_jobs_lock = threading.Lock()
_MAX_KEEP_S = 15 * 60


def start_job(kind: str, fn: Callable[..., Dict[str, Any]], **kwargs: Any) -> Job:
    """Run fn(reporter=..., **kwargs) in a thread. Only one job per kind runs at a time:
    starting a new one cancels the previous run of the same kind."""
    job = Job(kind)
    with _jobs_lock:
        _prune_locked()
        for other in _jobs.values():
            if other.kind == kind and other.status == "running":
                other.reporter.cancel()
        _jobs[job.id] = job

    def run() -> None:
        try:
            job.result = fn(reporter=job.reporter, **kwargs)
            job.status = "done"
        except ScanCancelled:
            job.status = "cancelled"
        except Exception as e:  # surfaced to the UI instead of dying silently in the thread
            job.status = "error"
            job.error = str(e) or e.__class__.__name__
        finally:
            job.finished = time.time()

    threading.Thread(target=run, name=f"job-{kind}-{job.id}", daemon=True).start()
    return job


def get_job(job_id: str) -> Optional[Job]:
    with _jobs_lock:
        return _jobs.get(job_id)


def cancel_job(job_id: str) -> Optional[Job]:
    job = get_job(job_id)
    if job and job.status == "running":
        job.reporter.cancel()
    return job


def _prune_locked() -> None:
    now = time.time()
    for jid in [j.id for j in _jobs.values() if j.finished and now - j.finished > _MAX_KEEP_S]:
        del _jobs[jid]
