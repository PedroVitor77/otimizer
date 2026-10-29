"""Auto Game Booster & Background Game Detector.

Monitors active processes for known games or game launchers (Steam, Epic, Riot, Xbox, etc.).
When a game is detected:
1. Elevates game process priority to High.
2. Lowers priority of non-essential background processes (browsers, Discord, Spotify, updaters).
3. Switches power plan to High / Ultimate Performance (saving the user's original plan).
4. Cleans Standby Memory & Working Sets to avoid stuttering and micro-freezes.
When the game closes:
1. Restores the original Windows power plan.
2. Restores lowered process priorities.
3. Records session statistics to history.
"""

import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Set

import psutil

from core.history import get_data_dir, record_action
from core.optimizer import purge_standby_list

DATA_DIR = get_data_dir()
BOOSTER_CONFIG_FILE = DATA_DIR / "game_booster.json"

# Known game executables -> Friendly game title
KNOWN_GAMES: Dict[str, str] = {
    # Valve & Source
    "cs2.exe": "Counter-Strike 2",
    "csgo.exe": "Counter-Strike: Global Offensive",
    "dota2.exe": "Dota 2",
    "tf2.exe": "Team Fortress 2",
    "left4dead2.exe": "Left 4 Dead 2",
    "hl2.exe": "Half-Life 2",
    # Riot Games
    "valorant-win64-shipping.exe": "Valorant",
    "valorant.exe": "Valorant",
    "league of legends.exe": "League of Legends",
    # Epic & Battle Royales
    "fortniteclient-win64-shipping.exe": "Fortnite",
    "fortnite.exe": "Fortnite",
    "r5apex.exe": "Apex Legends",
    "apex.exe": "Apex Legends",
    "pubg.exe": "PUBG: Battlegrounds",
    "tslgame.exe": "PUBG: Battlegrounds",
    "cod.exe": "Call of Duty: Warzone / MW",
    "modernwarfare.exe": "Call of Duty: Modern Warfare",
    "warzone.exe": "Call of Duty: Warzone",
    # Competitive & Sports
    "rocketleague.exe": "Rocket League",
    "overwatch.exe": "Overwatch 2",
    "rainbowsix.exe": "Rainbow Six Siege",
    "rainbowsix_vulkan.exe": "Rainbow Six Siege",
    "marvelrivals.exe": "Marvel Rivals",
    "fc25.exe": "EA Sports FC 25",
    "fifa23.exe": "EA Sports FIFA 23",
    "fifa24.exe": "EA Sports FC 24",
    # RPG & Open World
    "gta5.exe": "Grand Theft Auto V",
    "gtaiv.exe": "Grand Theft Auto IV",
    "rdr2.exe": "Red Dead Redemption 2",
    "cyberpunk2077.exe": "Cyberpunk 2077",
    "witcher3.exe": "The Witcher 3: Wild Hunt",
    "eldenring.exe": "Elden Ring",
    "bg3.exe": "Baldur's Gate 3",
    "bg3_dx11.exe": "Baldur's Gate 3",
    "hogwartslegacy.exe": "Hogwarts Legacy",
    "starfield.exe": "Starfield",
    "b1-win64-shipping.exe": "Black Myth: Wukong",
    "forzahorizon5.exe": "Forza Horizon 5",
    "forzahorizon4.exe": "Forza Horizon 4",
    "palworld-win64-shipping.exe": "Palworld",
    "helldivers2.exe": "Helldivers 2",
    "monsterhunterwilds.exe": "Monster Hunter Wilds",
    "mhrise.exe": "Monster Hunter Rise",
    "mhw.exe": "Monster Hunter: World",
    "genshinimpact.exe": "Genshin Impact",
    "starrail.exe": "Honkai: Star Rail",
    "zenlesszonezero.exe": "Zenless Zone Zero",
    "minecraft.exe": "Minecraft",
    "javaw.exe": "Minecraft (Java Edition)",
    "robloxplayerbeta.exe": "Roblox",
    "fallguys_client.exe": "Fall Guys",
    "deadbydaylight.exe": "Dead by Daylight",
    "rustclient.exe": "Rust",
    "dayz_x64.exe": "DayZ",
    "tarkov.exe": "Escape from Tarkov",
    # EA Sports UFC & Native Ports / Emulators
    "sacredfire-game.exe": "EA Sports UFC 3 (SacredFire)",
    "sacredfire.exe": "EA Sports UFC 3",
    "ufc.exe": "EA Sports UFC",
    "ufc2.exe": "EA Sports UFC 2",
    "ufc3.exe": "EA Sports UFC 3",
    "ufc4.exe": "EA Sports UFC 4",
    "ufc5.exe": "EA Sports UFC 5",
    "rpcs3.exe": "RPCS3 (PS3 Emulator)",
    "yuzu.exe": "Yuzu Emulator",
    "ryujinx.exe": "Ryujinx Emulator",
    "cemu.exe": "Cemu Emulator",
    "pcsx2.exe": "PCSX2 (PS2 Emulator)",
    "pcsx2-qtx64.exe": "PCSX2 Emulator",
    "shadps4.exe": "shadPS4 (PS4 Emulator)",
    "xenia.exe": "Xenia (Xbox 360 Emulator)",
    "xenia_canary.exe": "Xenia Canary",
    "ppssppwindows64.exe": "PPSSPP Emulator",
    "retroarch.exe": "RetroArch",
    "hd-player.exe": "BlueStacks / Emulador Android",
    "dnplayer.exe": "LDPlayer / Emulador Android",
    "nox.exe": "NoxPlayer / Emulador Android",
    "gameloop.exe": "GameLoop / Tencent Emulator",
    # Additional popular PC titles
    "b1.exe": "Black Myth: Wukong",
    "fifa.exe": "EA Sports FIFA",
    "pes2021.exe": "eFootball PES 2021",
    "efootball.exe": "eFootball",
    "gta_sa.exe": "GTA San Andreas",
    "gta_vc.exe": "GTA Vice City",
    "gta3.exe": "GTA III",
    "forzamotorsport.exe": "Forza Motorsport",
    "f1_25.exe": "EA Sports F1 25",
    "f1_24.exe": "EA Sports F1 24",
    "f1_23.exe": "EA Sports F1 23",
    "f1_22.exe": "EA Sports F1 22",
    "fc26.exe": "EA Sports FC 26",
    "fc26_showcase.exe": "EA Sports FC 26 (Showcase)",
    "fc26_trial.exe": "EA Sports FC 26 (Trial)",
    # Sim Racing & Simulation
    "ams2.exe": "Automobilista 2",
    "ams2avx.exe": "Automobilista 2",
    "ams2-career.exe": "Automobilista 2 (Zero to Apex)",
    "acs.exe": "Assetto Corsa",
    "assettocorsa.exe": "Assetto Corsa",
    "acshowroom.exe": "Assetto Corsa",
    "acs_x86.exe": "Assetto Corsa",
    "acc.exe": "Assetto Corsa Competizione",
    "ac2-win64-shipping.exe": "Assetto Corsa Competizione",
    "lemansultimate.exe": "Le Mans Ultimate",
    "rfactor2.exe": "rFactor 2",
    # PlayStation PC Ports & Story
    "tlou-ii.exe": "The Last of Us Part II",
    "tlou-ii-l.exe": "The Last of Us Part II",
    "tlou-i.exe": "The Last of Us Part I",
    "gow.exe": "God of War",
    "gowr.exe": "God of War Ragnarök",
    "godofwarragnarok.exe": "God of War Ragnarök",
    "spiderman.exe": "Marvel's Spider-Man",
    "milesmorales.exe": "Marvel's Spider-Man: Miles Morales",
    "ghostotsushima.exe": "Ghost of Tsushima",
    "horizonzerodawn.exe": "Horizon Zero Dawn",
    "horizonforbiddenwest.exe": "Horizon Forbidden West",
    "daysgone.exe": "Days Gone",
    "uncharted.exe": "Uncharted: Legacy of Thieves",
    # RPG, Action & Fighting
    "witcher3.exe": "The Witcher 3: Wild Hunt",
    "redprelauncher.exe": "The Witcher 3 Launcher",
    "onimushawots.exe": "Onimusha: Warlords",
    "ghost in the sql data.exe": "Ghost in the SQL Data Demo",
    "nba2k25.exe": "NBA 2K25",
    "nba2k26.exe": "NBA 2K26",
    "nba2k24.exe": "NBA 2K24",
    "hydra.exe": "Hydra Game Launcher",
    "wutheringwaves-win64-shipping.exe": "Wuthering Waves",
}

# Processes to NEVER treat as games even if they reside in steamapps or game directories
LAUNCHER_IGNORE: Set[str] = {
    "steam.exe",
    "steamwebhelper.exe",
    "steamservice.exe",
    "gameoverlayui.exe",
    "epicgameslauncher.exe",
    "unrealcefsubprocess.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "vgc.exe",
    "vgtray.exe",
    "origin.exe",
    "eaconnect_x64.exe",
    "ea.exe",
    "eadesktop.exe",
    "battlenet.exe",
    "agent.exe",
    "gog.galaxy.exe",
    "galaxyclient.exe",
    "easyanticheat.exe",
    "easyanticheat_eos.exe",
    "battleye.exe",
    "beservice.exe",
    "crashreporter.exe",
    "riotclientcrashhandler.exe",
    "crashpad_handler.exe",
    "epicwebhelper.exe",
    "overwolf.exe",
    "overwolflauncher.exe",
    "overwolfbrowser.exe",
    "overwolfhelper.exe",
    "overwolfhelper64.exe",
    "unitycrashhandler64.exe",
    "unitycrashhandler32.exe",
    "pulsepc.exe",
    "python.exe",
    "pythonw.exe",
}

# Non-critical applications to throttle (lower priority) while a game is running
BACKGROUND_APPS_TO_THROTTLE: Set[str] = {
    # Web Browsers
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "operagx.exe",
    "vivaldi.exe",
    # Communications & Media
    "discord.exe",
    "spotify.exe",
    "telegram.exe",
    "whatsapp.exe",
    "slack.exe",
    # Torrents & Downloaders
    "qbittorrent.exe",
    "utorrent.exe",
    "bittorrent.exe",
    # Windows Non-Essential Background Hosts
    "onedrive.exe",
    "searchindexer.exe",
    "compattelrunner.exe",
    "widgets.exe",
    "yourphone.exe",
    "phoneexperiencehost.exe",
}


def _get_active_power_plan() -> Optional[str]:
    """Retrieve current Windows active power plan GUID."""
    try:
        out = subprocess.check_output(
            ["powercfg", "/getactivescheme"],
            text=True,
            encoding="oem",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=3,
        )
        match = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", out)
        if match:
            return match.group(1).lower()
    except Exception:
        pass
    return None


def _set_active_power_plan(guid: str) -> bool:
    """Set the Windows active power plan by GUID."""
    try:
        res = subprocess.run(
            ["powercfg", "/setactive", guid],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=3,
        )
        return res.returncode == 0
    except Exception:
        return False


def _find_best_performance_plan() -> Optional[str]:
    """Find High or Ultimate Performance power plan GUID, creating High Performance if needed."""
    preferred = [
        "e9a42b02-d5df-448d-aa00-03f14749eb61",  # Ultimate Performance
        "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",  # High Performance
    ]
    try:
        out = subprocess.check_output(
            ["powercfg", "/list"],
            text=True,
            encoding="oem",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=3,
        )
        found_guids = re.findall(
            r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
            out,
        )
        found_guids_lower = [g.lower() for g in found_guids]

        for p in preferred:
            if p in found_guids_lower:
                return p

        # Check for any plan mentioning High / Alto / Desempenho
        lines = out.splitlines()
        for line in lines:
            ll = line.lower()
            if any(term in ll for term in ("alto", "high", "ultimate", "desempenho")):
                m = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", line)
                if m:
                    return m.group(1).lower()

        # Try duplicating High Performance
        subprocess.run(
            ["powercfg", "-duplicatescheme", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=3,
        )
        return "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
    except Exception:
        return None



def discover_installed_games() -> Dict[str, str]:
    """Scan all Steam libraries and local drives to dynamically map game exes to titles."""
    games: Dict[str, str] = {}
    vdf_paths = [
        r"C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf",
        r"C:\Program Files\Steam\steamapps\libraryfolders.vdf",
    ]
    lib_roots = set()
    for vp in vdf_paths:
        if os.path.exists(vp):
            try:
                with open(vp, "r", encoding="utf-8", errors="ignore") as f:
                    txt = f.read()
                matches = re.findall(r'"path"\s+"([^"]+)"', txt)
                for m in matches:
                    clean = m.replace(r"\\", "\\").strip()
                    if os.path.isdir(clean):
                        lib_roots.add(clean)
            except Exception:
                pass

    # Standard drive roots
    for drive in ["C", "D", "E", "F", "G"]:
        for cand in [
            rf"{drive}:\SteamLibrary",
            rf"{drive}:\Program Files (x86)\Steam",
            rf"{drive}:\Program Files\Steam",
            rf"{drive}:\Games",
            rf"{drive}:\Jogos",
            rf"{drive}:\Epic Games",
            rf"{drive}:\Riot Games",
            rf"{drive}:\TheWitcher3",
            rf"{drive}:\ufc",
            rf"{drive}:\Zero to Apex",
            rf"{drive}:\hydra",
        ]:
            if os.path.isdir(cand):
                lib_roots.add(cand)

    ignore_exes = {
        "crashreporter.exe", "crashreport.exe", "bssndrpt64.exe", "bugsplathd64.exe",
        "steamstatisticsreader.exe", "eaanticheat.installer.exe", "launcher.exe",
        "uninstall.exe", "uninstall hydra.exe", "vc_redist.x64.exe", "7za.exe",
        "d3dconfig.exe", "d3d12stateobjectcompiler.exe", "socd_cleaner.exe",
        "pkg_extractor.exe", "hitboxer.exe", "python.exe", "pythonw.exe",
        "redist.exe", "cleanup.exe", "touchup.exe", "elevate.exe", "7z.exe",
        "bb-gpu-capabilities.exe", "crs-handler.exe", "crs-uploader.exe", "crs-video.exe"
    }

    friendly_overrides = {
        "acs.exe": "Assetto Corsa",
        "assettocorsa.exe": "Assetto Corsa",
        "ams2.exe": "Automobilista 2",
        "ams2avx.exe": "Automobilista 2",
        "ams2-career.exe": "Automobilista 2 (Zero to Apex)",
        "f1_25.exe": "EA Sports F1 25",
        "fc26.exe": "EA Sports FC 26",
        "fc26_showcase.exe": "EA Sports FC 26 (Showcase)",
        "fc26_trial.exe": "EA Sports FC 26 (Trial)",
        "tlou-ii.exe": "The Last of Us Part II",
        "tlou-ii-l.exe": "The Last of Us Part II",
        "onimushawots.exe": "Onimusha: Warlords",
        "ghost in the sql data.exe": "Ghost in the SQL Data Demo",
        "witcher3.exe": "The Witcher 3: Wild Hunt",
        "ufc3.exe": "EA Sports UFC 3",
        "sacredfire-game.exe": "EA Sports UFC 3 (SacredFire)",
        "sacredfire.exe": "EA Sports UFC 3",
        "hydra.exe": "Hydra Game Launcher",
    }

    for root in lib_roots:
        scan_dirs = []
        common = os.path.join(root, "steamapps", "common")
        if os.path.isdir(common):
            scan_dirs.append(common)
        scan_dirs.append(root)

        for sdir in scan_dirs:
            try:
                for entry in os.listdir(sdir):
                    sub = os.path.join(sdir, entry)
                    if not os.path.isdir(sub):
                        continue
                    folder_low = entry.lower()
                    if folder_low in ["steamworks shared", "steam controller configs", "bin", "libs", "backup-steam-userdata", "resources"]:
                        continue

                    found_exes = []
                    try:
                        for f in os.listdir(sub):
                            if f.lower().endswith(".exe") and f.lower() not in ignore_exes:
                                found_exes.append((f, entry))
                    except Exception:
                        pass

                    for nested in ["bin", "bin\\x64_dx12", "bin\\x64", "bin64", "build", "UFC3Native", "UFC3Native\\bin"]:
                        np = os.path.join(sub, nested)
                        if os.path.isdir(np):
                            try:
                                for f in os.listdir(np):
                                    if f.lower().endswith(".exe") and f.lower() not in ignore_exes:
                                        found_exes.append((f, entry))
                            except Exception:
                                pass

                    for exe_file, title in found_exes:
                        low_exe = exe_file.lower()
                        if low_exe in friendly_overrides:
                            games[low_exe] = friendly_overrides[low_exe]
                        else:
                            clean_t = title.replace("_", " ").title()
                            games[low_exe] = clean_t
            except Exception:
                pass

    return games

class GameBooster:
    """Singleton background watcher that optimizes performance whenever games run."""

    def __init__(self):
        self.lock = threading.RLock()
        self.enabled: bool = True
        self.running: bool = False
        self._thread: Optional[threading.Thread] = None

        self.active_game: Optional[Dict[str, Any]] = None
        self.original_power_plan: Optional[str] = None
        self.throttled_pids: Dict[int, int] = {}  # pid -> original_priority
        self.last_session: Optional[Dict[str, Any]] = None
        self._last_catalog_refresh: float = 0.0

        self._load_config()
        self._refresh_games_catalog(force=True)

    def _load_config(self) -> None:
        if BOOSTER_CONFIG_FILE.exists():
            try:
                with open(BOOSTER_CONFIG_FILE, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                    self.enabled = bool(cfg.get("enabled", True))
            except Exception:
                self.enabled = True

    def _save_config(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(BOOSTER_CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump({"enabled": self.enabled}, f, indent=2)
        except Exception:
            pass

    def start(self) -> None:
        """Start the background detector loop if not already running."""
        with self.lock:
            if self.running and self._thread and self._thread.is_alive():
                return
            self.running = True
            self._thread = threading.Thread(target=self._detector_loop, daemon=True, name="GameBoosterWatcher")
            self._thread.start()

    def stop(self) -> None:
        """Stop watcher thread and revert any active boost."""
        with self.lock:
            self.running = False
            if self.active_game:
                self._deactivate_boost()

    def set_enabled(self, enabled: bool) -> Dict[str, Any]:
        """Toggle auto-detection on or off."""
        with self.lock:
            self.enabled = enabled
            self._save_config()
            if not enabled and self.active_game:
                self._deactivate_boost()
            elif enabled and not self.running:
                self.start()
            return self.get_status()

    def get_status(self) -> Dict[str, Any]:
        """Return the current Game Booster status."""
        with self.lock:
            return {
                "enabled": self.enabled,
                "is_monitoring": self.running and self.enabled,
                "active_game": self.active_game,
                "throttled_apps_count": len(self.throttled_pids),
                "last_session": self.last_session,
            }

    def _refresh_games_catalog(self, force: bool = False) -> None:
        """Dynamically discover installed games across Steam and user folders."""
        now = time.time()
        if not force and (now - self._last_catalog_refresh) < 60.0:
            return
        try:
            discovered = discover_installed_games()
            if discovered:
                KNOWN_GAMES.update(discovered)
            self._last_catalog_refresh = now
        except Exception:
            pass

    def get_running_process_candidates(self) -> List[Dict[str, Any]]:
        """Return user applications running on the machine for manual game linking."""
        candidates = []
        self._refresh_games_catalog()
        for proc in psutil.process_iter(["pid", "name", "exe", "memory_info"]):
            try:
                pname = (proc.info.get("name") or "").lower()
                if not pname or pname in LAUNCHER_IGNORE:
                    continue
                if any(k in pname for k in ["crash", "helper", "updater", "report", "service", "install", "webhelper"]):
                    continue
                pexe = (proc.info.get("exe") or "").lower()
                if any(s in pexe for s in ["\\windows\\", "\\system32\\", "\\syswow64\\", "\\microsoft\\"]):
                    continue
                mem_mb = int((proc.info["memory_info"].rss if proc.info.get("memory_info") else 0) / (1024 * 1024))
                if mem_mb < 35:
                    continue

                title = KNOWN_GAMES.get(pname) or Path(proc.info["name"]).stem.replace("_", " ").title()
                candidates.append({
                    "pid": proc.info["pid"],
                    "name": title,
                    "exe_name": proc.info["name"],
                    "exe_path": proc.info.get("exe") or "",
                    "memory_mb": mem_mb,
                    "is_known_game": pname in KNOWN_GAMES,
                })
            except Exception:
                continue

        candidates.sort(key=lambda x: (not x["is_known_game"], -x["memory_mb"]))
        return candidates[:35]

    def detect_running_game(self) -> Optional[Dict[str, Any]]:
        """Scan active processes to see if any known game is executing.
        Uses a 2-pass strategy:
        Pass 1: Exact matches in KNOWN_GAMES (highest confidence, avoids false positives).
        Pass 2: Heuristic detection by executable stem and folder paths.
        """
        self._refresh_games_catalog()
        candidates = []
        for proc in psutil.process_iter(["pid", "name", "exe"]):
            try:
                pname = (proc.info.get("name") or "").lower()
                if not pname or pname in LAUNCHER_IGNORE:
                    continue
                # Skip common background utilities and handlers
                if any(k in pname for k in ["crash", "helper", "updater", "report", "service", "install", "webhelper"]):
                    continue

                pid = proc.info["pid"]
                pexe = (proc.info.get("exe") or "").lower()
                if not pexe:
                    try:
                        cmd = " ".join(proc.cmdline()).lower()
                        for part in cmd.split():
                            if part.endswith(".exe") and ("\\" in part or "/" in part):
                                pexe = part.strip('"\'')
                                break
                    except Exception:
                        pass

                # Pass 1: Direct match in KNOWN_GAMES
                if pname in KNOWN_GAMES:
                    return {
                        "pid": pid,
                        "name": KNOWN_GAMES[pname],
                        "exe_name": proc.info["name"],
                        "exe_path": proc.info.get("exe") or "",
                    }

                candidates.append((pid, pname, proc.info["name"], pexe))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            except Exception:
                continue

        # Pass 2: Heuristics
        for pid, pname, real_name, pexe in candidates:
            try:
                stem = Path(pname).stem.lower()
                # 2.1 Name heuristic (-game, _game, etc.)
                if any(k in stem for k in ["-game", "_game", "game-", "game_"]) or stem == "game":
                    clean = stem.replace("-game", "").replace("_game", "").replace("game-", "").replace("game_", "").replace("-", " ").replace("_", " ").strip().title()
                    display_name = f"{clean} (Jogo)" if clean else "Jogo em Execução"
                    return {
                        "pid": pid,
                        "name": display_name,
                        "exe_name": real_name,
                        "exe_path": pexe,
                    }

                # 2.2 Unreal Engine Shipping binaries
                if "-shipping" in stem or "_shipping" in stem:
                    clean = stem.split("-shipping")[0].split("_shipping")[0].replace("-win64", "").replace("_win64", "").replace("-", " ").replace("_", " ").strip().title()
                    return {
                        "pid": pid,
                        "name": clean or "Jogo (Unreal Engine)",
                        "exe_name": real_name,
                        "exe_path": pexe,
                    }

                # 2.3 Directory heuristic
                if pexe:
                    is_game_dir = any(
                        sub in pexe
                        for sub in [
                            "\\steamapps\\common\\",
                            "\\epic games\\",
                            "\\riot games\\",
                            "\\xboxgames\\",
                            "\\ea games\\",
                            "\\origin games\\",
                            "\\ubisoft",
                            "\\gog galaxy\\games\\",
                            "\\games\\",
                            "\\jogos\\",
                            "\\game\\",
                            "\\ufc\\",
                            "\\emulators\\",
                            "\\emuladores\\",
                            "\\rpcs3\\",
                            "\\yuzu\\",
                            "\\ryujinx\\",
                            "\\cemu\\",
                            "\\pcsx2\\",
                        ]
                    )
                    if is_game_dir:
                        title = Path(pexe).stem.replace("_", " ").replace("-", " ").title()
                        return {
                            "pid": pid,
                            "name": title,
                            "exe_name": real_name,
                            "exe_path": pexe,
                        }
            except Exception:
                continue

        return None

    def boost_process(self, pid: int, custom_title: Optional[str] = None) -> Dict[str, Any]:
        """Manually trigger Turbo Game Mode for a specific PID."""
        with self.lock:
            try:
                proc = psutil.Process(pid)
                pname = proc.name()
                game_title = custom_title or KNOWN_GAMES.get(pname.lower()) or pname
                game_info = {
                    "pid": pid,
                    "name": game_title,
                    "exe_name": pname,
                    "exe_path": proc.exe() if hasattr(proc, "exe") else "",
                }
                self._activate_boost(game_info)
                return {"success": True, "game": game_info}
            except Exception as e:
                return {"success": False, "error": str(e)}

    def _activate_boost(self, game_info: Dict[str, Any]) -> None:
        """Apply Turbo settings for the identified game."""
        pid = game_info["pid"]
        game_title = game_info["name"]

        # 1. Elevate Game Priority
        elevated = False
        try:
            p = psutil.Process(pid)
            p.nice(psutil.HIGH_PRIORITY_CLASS)
            elevated = True
        except Exception:
            pass

        # 2. Switch Windows Power Plan to High Performance
        self.original_power_plan = _get_active_power_plan()
        perf_plan = _find_best_performance_plan()
        switched_power = False
        if perf_plan and perf_plan != self.original_power_plan:
            switched_power = _set_active_power_plan(perf_plan)

        # 3. Throttle background browser and updater processes
        self.throttled_pids.clear()
        throttled_names = []
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                pname = (proc.info.get("name") or "").lower()
                p_pid = proc.info["pid"]
                if p_pid == pid:
                    continue
                if pname in BACKGROUND_APPS_TO_THROTTLE:
                    target_proc = psutil.Process(p_pid)
                    old_pri = target_proc.nice()
                    target_proc.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
                    self.throttled_pids[p_pid] = old_pri
                    throttled_names.append(proc.info["name"])
            except Exception:
                continue

        # 4. Clean Standby Memory List & Working Sets
        ram_res = purge_standby_list(record_in_history=False)

        started_at = time.strftime("%H:%M:%S")
        self.active_game = {
            "pid": pid,
            "name": game_title,
            "exe_name": game_info.get("exe_name"),
            "exe_path": game_info.get("exe_path"),
            "started_at": started_at,
            "elevated_priority": elevated,
            "switched_power": switched_power,
            "ram_freed_mb": ram_res.get("freed_mb", 0),
            "throttled_apps": list(set(throttled_names)),
        }

        # Log action to PulsePC history
        record_action(
            action_type="game_booster",
            title=f"Game Booster: {game_title}",
            details=(
                f"Modo Turbo ativado automaticamente. "
                f"Prioridade Alta: {'Sim' if elevated else 'Normal'} | "
                f"RAM liberada: {ram_res.get('freed_mb', 0)} MB | "
                f"Apps em 2º plano desacelerados: {len(self.throttled_pids)}"
            ),
            ram_freed_mb=ram_res.get("freed_mb", 0),
        )

    def _deactivate_boost(self) -> None:
        """Revert settings when the game process closes."""
        if not self.active_game:
            return

        game_title = self.active_game.get("name", "Jogo")

        # 1. Restore Windows Power Plan
        if self.original_power_plan:
            _set_active_power_plan(self.original_power_plan)
            self.original_power_plan = None

        # 2. Restore throttled processes
        restored_count = 0
        for p_pid, old_pri in self.throttled_pids.items():
            try:
                p = psutil.Process(p_pid)
                p.nice(old_pri or psutil.NORMAL_PRIORITY_CLASS)
                restored_count += 1
            except Exception:
                continue
        self.throttled_pids.clear()

        ended_at = time.strftime("%H:%M:%S")
        self.last_session = {
            "name": game_title,
            "started_at": self.active_game.get("started_at"),
            "ended_at": ended_at,
            "restored_apps": restored_count,
        }

        self.active_game = None

    def _detector_loop(self) -> None:
        """Lightweight background loop running every 2.5 - 3.0 seconds."""
        while self.running:
            try:
                time.sleep(3.0)
                if not self.enabled:
                    continue

                with self.lock:
                    # If we currently have an active game, verify it is still alive
                    if self.active_game:
                        active_pid = self.active_game.get("pid")
                        if active_pid is None or not psutil.pid_exists(active_pid):
                            self._deactivate_boost()
                        else:
                            try:
                                proc = psutil.Process(active_pid)
                                if not proc.is_running() or proc.status() == psutil.STATUS_ZOMBIE:
                                    self._deactivate_boost()
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                self._deactivate_boost()
                        continue

                    # If no active game, scan for one
                    detected = self.detect_running_game()
                    if detected:
                        self._activate_boost(detected)

            except Exception:
                pass


# Global singleton booster instance
booster = GameBooster()
