"""Centralized graceful shutdown helpers for PulsePC background services."""


def shutdown_runtime() -> None:
    """Stop active background monitors and restore system state before exiting."""
    try:
        from core.game_booster import booster
        booster.stop()
    except Exception:
        pass

    try:
        from core.fps_capture import capture as fps_capture
        fps_capture.stop()
    except Exception:
        pass

    try:
        from core.game_monitor import toggle_floating_hud
        toggle_floating_hud(False)
    except Exception:
        pass
