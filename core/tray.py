import os
from pathlib import Path
import sys
import threading
import time
from typing import Optional

# Global references
_window = None
_tray_icon = None
_really_quit = False
_has_shown_balloon = False
_game_mode_item = None


def setup_tray_and_window(window, icon_path: Path):
    """Integrates pywebview window with Windows System Tray (NotifyIcon).
    When the user closes the window (X), it hides to tray instead of quitting.
    """
    global _window
    _window = window

    # Hook the pywebview closing event to prevent actual destruction
    window.events.closing += on_window_closing

    # Hook the shown event to initialize the WinForms NotifyIcon once form is ready
    window.events.shown += lambda: _init_tray_in_background(window, icon_path)


def get_minimize_to_tray_setting() -> bool:
    """Read user preference from settings.json. Defaults to True."""
    try:
        from core.history import DATA_DIR
        cfg = DATA_DIR / "settings.json"
        if cfg.exists():
            import json
            with open(cfg, "r", encoding="utf-8") as f:
                d = json.load(f)
                return bool(d.get("minimize_to_tray", True))
    except Exception:
        pass
    return True


def set_minimize_to_tray_setting(enabled: bool):
    """Save user preference to settings.json."""
    try:
        from core.history import DATA_DIR
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cfg = DATA_DIR / "settings.json"
        data = {}
        if cfg.exists():
            import json
            with open(cfg, "r", encoding="utf-8") as f:
                data = json.load(f)
        data["minimize_to_tray"] = bool(enabled)
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def on_window_closing(*args, **kwargs) -> bool:
    """Event handler for pywebview window closing.
    Return False to cancel close and hide to tray.
    Return True to allow application destruction.
    """
    global _really_quit
    if _really_quit or not get_minimize_to_tray_setting():
        _cleanup_tray()
        return True

    # User clicked 'X' -> minimize to system tray
    try:
        if _window:
            _window.hide()
            _show_minimized_balloon()
    except Exception as e:
        print(f"[Tray] Erro ao ocultar janela: {e}", flush=True)

    return False  # Cancels pywebview window destroy


def _show_minimized_balloon():
    """Shows a helpful balloon notification on Windows when minimized to tray."""
    global _has_shown_balloon, _tray_icon
    if not _has_shown_balloon and _tray_icon:
        _has_shown_balloon = True
        try:
            from System.Windows.Forms import ToolTipIcon
            _tray_icon.ShowBalloonTip(
                3500,
                "PulsePC em Segundo Plano",
                "O PulsePC continua ativo na bandeja do sistema para monitorar seus jogos e otimizar a RAM.\nClique duas vezes no ícone para reabrir.",
                ToolTipIcon.Info,
            )
        except Exception:
            pass


def _init_tray_in_background(window, icon_path: Path):
    """Wait for WinForms form to be available and create NotifyIcon on UI thread."""
    def _worker():
        for _ in range(40):
            try:
                import webview.platforms.winforms as wf
                form = wf.BrowserView.instances.get(window.uid)
                if form:
                    # Form is ready, execute tray creation on WinForms UI thread
                    from System.Windows.Forms import MethodInvoker
                    form.Invoke(MethodInvoker(lambda: _create_winforms_tray(form, icon_path)))
                    return
            except Exception:
                pass
            time.sleep(0.15)

    threading.Thread(target=_worker, daemon=True).start()


def _create_winforms_tray(form, icon_path: Path):
    """Instantiate and configure System.Windows.Forms.NotifyIcon and ContextMenuStrip."""
    global _tray_icon, _game_mode_item

    try:
        import clr
        clr.AddReference("System.Windows.Forms")
        clr.AddReference("System.Drawing")
        from System.Windows.Forms import (
            ContextMenuStrip,
            MouseButtons,
            NotifyIcon,
            ToolStripMenuItem,
            ToolStripSeparator,
        )
        from System.Drawing import Font, FontFamily, FontStyle, Icon, SystemIcons

        # 1. Create NotifyIcon
        tray = NotifyIcon()
        if icon_path.exists():
            try:
                tray.Icon = Icon(str(icon_path))
            except Exception:
                tray.Icon = SystemIcons.Application
        else:
            tray.Icon = SystemIcons.Application

        tray.Text = "PulsePC Pro - Monitor e Otimizador"
        tray.Visible = True

        # 2. Context Menu
        menu = ContextMenuStrip()

        # Header item (bold, disabled)
        header_font = Font(FontFamily.GenericSansSerif, 9, FontStyle.Bold)
        header_item = ToolStripMenuItem("PulsePC Pro")
        header_item.Enabled = False
        header_item.Font = header_font
        menu.Items.Add(header_item)

        menu.Items.Add(ToolStripSeparator())

        # Action: Abrir PulsePC
        item_open = ToolStripMenuItem("Abrir PulsePC")
        item_open.Font = Font(FontFamily.GenericSansSerif, 8.5, FontStyle.Bold)
        item_open.Click += lambda sender, args: restore_window()
        menu.Items.Add(item_open)

        menu.Items.Add(ToolStripSeparator())

        # Action: Otimizar RAM
        item_ram = ToolStripMenuItem("⚡ Otimizar RAM Agora")
        item_ram.Click += lambda sender, args: _action_optimize_ram()
        menu.Items.Add(item_ram)

        # Action: Super Boost
        item_boost = ToolStripMenuItem("🚀 Super Boost Rápido")
        item_boost.Click += lambda sender, args: _action_quick_boost()
        menu.Items.Add(item_boost)

        # Action: Modo Jogo
        from core.game_booster import booster
        is_game_on = booster.enabled
        _game_mode_item = ToolStripMenuItem(f"🎮 Modo Jogo: {'Ativado' if is_game_on else 'Desativado'}")
        _game_mode_item.Click += lambda sender, args: _action_toggle_game_mode()
        menu.Items.Add(_game_mode_item)

        menu.Items.Add(ToolStripSeparator())

        # Action: Sair
        item_quit = ToolStripMenuItem("🚪 Fechar PulsePC (Sair)")
        item_quit.Click += lambda sender, args: quit_app()
        menu.Items.Add(item_quit)

        tray.ContextMenuStrip = menu

        # 3. Mouse Click Handlers
        def on_tray_mouse_click(sender, e):
            if e.Button == MouseButtons.Left:
                restore_window()

        tray.MouseClick += on_tray_mouse_click
        tray.DoubleClick += lambda sender, args: restore_window()

        _tray_icon = tray
        print("[Tray] Ícone da bandeja do sistema (NotifyIcon) inicializado com sucesso!", flush=True)

    except Exception as e:
        print(f"[Tray] Falha ao inicializar NotifyIcon WinForms: {e}", flush=True)


def restore_window():
    """Brings PulsePC window back to the front."""
    global _window
    if not _window:
        return
    try:
        _window.show()
        _window.restore()

        # WinForms form activation to guarantee focus
        import webview.platforms.winforms as wf
        form = wf.BrowserView.instances.get(_window.uid)
        if form:
            from System.Windows.Forms import FormWindowState, MethodInvoker
            def _bring():
                form.WindowState = FormWindowState.Normal
                form.Show()
                form.BringToFront()
                form.Activate()
            form.Invoke(MethodInvoker(_bring))
    except Exception as e:
        print(f"[Tray] Erro ao restaurar janela: {e}", flush=True)


def minimize_to_tray():
    """Explicitly minimizes the window to tray."""
    global _window
    if _window:
        try:
            _window.hide()
            _show_minimized_balloon()
        except Exception:
            pass


def quit_app():
    """Gracefully terminates PulsePC and destroys all windows."""
    global _really_quit, _window
    _really_quit = True
    _cleanup_tray()

    try:
        if _window:
            _window.destroy()
    except Exception:
        pass

    # Ensure python process exits cleanly if daemon threads linger
    def _force_exit():
        time.sleep(1.0)
        os._exit(0)

    threading.Thread(target=_force_exit, daemon=True).start()


def _cleanup_tray():
    """Removes the tray icon from the Windows Taskbar."""
    global _tray_icon
    if _tray_icon:
        try:
            _tray_icon.Visible = False
            _tray_icon.Dispose()
        except Exception:
            pass
        _tray_icon = None


def _action_optimize_ram():
    """Background worker for Tray RAM Optimization."""
    def _worker():
        try:
            from core.optimizer import optimize_ram
            res = optimize_ram(record_in_history=True)
            freed = res.get("freed_mb", 0)
            pct = res.get("percent_after", 0)
            if _tray_icon:
                from System.Windows.Forms import ToolTipIcon
                _tray_icon.ShowBalloonTip(
                    3000,
                    "PulsePC - RAM Otimizada ⚡",
                    f"Liberados {freed:.1f} MB de memória RAM!\nUso atual: {pct}%",
                    ToolTipIcon.Info,
                )
        except Exception as e:
            if _tray_icon:
                from System.Windows.Forms import ToolTipIcon
                _tray_icon.ShowBalloonTip(3000, "PulsePC", f"Erro ao otimizar RAM: {e}", ToolTipIcon.Warning)

    threading.Thread(target=_worker, daemon=True).start()


def _action_quick_boost():
    """Background worker for Tray Quick Boost."""
    def _worker():
        try:
            from core.cleaner import clean_system_files, QUICK_CLEAN_TARGETS
            from core.optimizer import optimize_ram
            clean_res = clean_system_files(QUICK_CLEAN_TARGETS)
            ram_res = optimize_ram(record_in_history=True)
            cleaned_str = clean_res.get("cleaned_formatted", "0 B")
            freed_ram = ram_res.get("freed_mb", 0)
            if _tray_icon:
                from System.Windows.Forms import ToolTipIcon
                _tray_icon.ShowBalloonTip(
                    3500,
                    "PulsePC - Super Boost Concluído 🚀",
                    f"Recuperados {cleaned_str} em disco e {freed_ram:.1f} MB de RAM liberados!",
                    ToolTipIcon.Info,
                )
        except Exception as e:
            if _tray_icon:
                from System.Windows.Forms import ToolTipIcon
                _tray_icon.ShowBalloonTip(3000, "PulsePC", f"Erro no Super Boost: {e}", ToolTipIcon.Warning)

    threading.Thread(target=_worker, daemon=True).start()


def _action_toggle_game_mode():
    """Background worker to toggle Game Booster state from tray."""
    global _game_mode_item
    try:
        from core.game_booster import booster
        new_state = not booster.enabled
        booster.set_enabled(new_state)

        if _game_mode_item:
            _game_mode_item.Text = f"🎮 Modo Jogo: {'Ativado' if new_state else 'Desativado'}"

        if _tray_icon:
            from System.Windows.Forms import ToolTipIcon
            msg = "Prioridade Máxima e Plano de Energia Ativados para Jogos!" if new_state else "Modo de Segundo Plano Padrão Restaurado."
            _tray_icon.ShowBalloonTip(
                2800,
                f"Modo Jogo: {'ATIVADO 🎮' if new_state else 'DESATIVADO'}",
                msg,
                ToolTipIcon.Info,
            )
    except Exception as e:
        print(f"[Tray] Erro ao alternar Modo Jogo: {e}", flush=True)
