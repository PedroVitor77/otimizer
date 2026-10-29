"""Offline FPS estimator.

There is no reliable free API that predicts FPS from a CPU/GPU pair, so this module keeps its own
reference data and model:

- GPU and CPU scores are relative gaming performance indexes (RTX 3060 = 100, Ryzen 5 5600 = 100),
  approximated from averages of public benchmark reviews.
- Each game has the FPS a score-100 GPU reaches at 1080p / High (`gpu`) and the FPS a score-100 CPU
  can feed when the GPU is not the limit (`cpu`).
- Resolution and preset scale the GPU side; the lower of the two sides wins, blended smoothly.

The numbers are estimates (roughly +-15%); drivers, game patches, maps and background apps all move
real results.
"""
import re
from typing import Any, Dict, List, Optional, Tuple

import psutil

from core.health import get_hardware_specs

# name -> (score, vram_gb). Keys are matched against the normalized WMI adapter name.
GPUS: Dict[str, Tuple[float, float]] = {
    # NVIDIA GeForce GTX
    "gtx 750 ti": (25, 2), "gtx 950": (32, 2), "gtx 960": (38, 2), "gtx 970": (55, 4),
    "gtx 980": (65, 4), "gtx 980 ti": (80, 6),
    "gtx 1050": (30, 2), "gtx 1050 ti": (38, 4), "gtx 1060 3gb": (58, 3), "gtx 1060": (62, 6),
    "gtx 1070": (80, 8), "gtx 1070 ti": (90, 8), "gtx 1080": (95, 8), "gtx 1080 ti": (125, 11),
    "gtx 1630": (30, 4), "gtx 1650": (48, 4), "gtx 1650 super": (62, 4), "gtx 1660": (68, 6),
    "gtx 1660 super": (76, 6), "gtx 1660 ti": (78, 6),
    # NVIDIA GeForce RTX
    "rtx 2060": (88, 6), "rtx 2060 super": (102, 8), "rtx 2070": (105, 8), "rtx 2070 super": (118, 8),
    "rtx 2080": (125, 8), "rtx 2080 super": (132, 8), "rtx 2080 ti": (150, 11),
    "rtx 3050": (70, 8), "rtx 3060": (100, 12), "rtx 3060 ti": (125, 8), "rtx 3070": (140, 8),
    "rtx 3070 ti": (148, 8), "rtx 3080": (175, 10), "rtx 3080 ti": (190, 12), "rtx 3090": (195, 24),
    "rtx 3090 ti": (210, 24),
    "rtx 4060": (118, 8), "rtx 4060 ti": (140, 8), "rtx 4070": (175, 12), "rtx 4070 super": (200, 12),
    "rtx 4070 ti": (215, 12), "rtx 4070 ti super": (230, 16), "rtx 4080": (260, 16),
    "rtx 4080 super": (265, 16), "rtx 4090": (320, 24),
    "rtx 5060": (140, 8), "rtx 5060 ti": (160, 16), "rtx 5070": (215, 12), "rtx 5070 ti": (260, 16),
    "rtx 5080": (290, 16), "rtx 5090": (380, 32),
    # AMD Radeon
    "rx 460": (30, 4), "rx 470": (52, 4), "rx 480": (58, 8), "rx 550": (22, 2), "rx 560": (33, 4),
    "rx 570": (55, 4), "rx 580": (60, 8), "rx 590": (66, 8), "vega 56": (80, 8), "vega 64": (88, 8),
    "radeon vii": (115, 16),
    "rx 5500 xt": (62, 8), "rx 5600 xt": (92, 6), "rx 5700": (105, 8), "rx 5700 xt": (118, 8),
    "rx 6400": (45, 4), "rx 6500 xt": (50, 4), "rx 6600": (105, 8), "rx 6600 xt": (120, 8),
    "rx 6650 xt": (125, 8), "rx 6700": (138, 10), "rx 6700 xt": (150, 12), "rx 6750 xt": (158, 12),
    "rx 6800": (185, 16), "rx 6800 xt": (210, 16), "rx 6900 xt": (225, 16), "rx 6950 xt": (235, 16),
    "rx 7600": (125, 8), "rx 7600 xt": (130, 16), "rx 7700 xt": (175, 12), "rx 7800 xt": (205, 16),
    "rx 7900 gre": (220, 16), "rx 7900 xt": (260, 20), "rx 7900 xtx": (290, 24),
    "rx 9060 xt": (170, 16), "rx 9070": (245, 16), "rx 9070 xt": (275, 16),
    # Intel Arc
    "arc a380": (45, 6), "arc a580": (100, 8), "arc a750": (110, 8), "arc a770": (120, 16),
    "arc b570": (120, 10), "arc b580": (135, 12),
    # Integrated graphics
    "intel hd graphics 620": (8, 1), "intel uhd graphics 620": (9, 1), "intel uhd graphics 630": (10, 1),
    "intel uhd graphics 730": (12, 1), "intel uhd graphics 770": (13, 1), "intel uhd graphics": (10, 1),
    "intel iris xe": (22, 2), "intel arc graphics": (45, 4),
    "radeon graphics": (18, 2), "radeon vega 8": (20, 2), "radeon 680m": (45, 4), "radeon 780m": (52, 4), "radeon 890m": (60, 4),
}

# name -> gaming score. Keys are matched against the normalized CPU name.
CPUS: Dict[str, float] = {
    # AMD Ryzen desktop
    "ryzen 3 1200": 45, "ryzen 5 1600": 55, "ryzen 7 1700": 57, "ryzen 5 2600": 62, "ryzen 7 2700": 64,
    "ryzen 5 2400g": 50, "ryzen 3 3100": 65, "ryzen 3 3200g": 52, "ryzen 5 3400g": 60,
    "ryzen 5 3500": 70, "ryzen 5 3600": 75, "ryzen 7 3700x": 78, "ryzen 7 3800x": 79, "ryzen 9 3900x": 80,
    "ryzen 5 4500": 82, "ryzen 5 4600g": 80,
    "ryzen 5 5500": 88, "ryzen 5 5600": 100, "ryzen 5 5600x": 103, "ryzen 5 5600g": 90,
    "ryzen 7 5700g": 95, "ryzen 7 5700x": 106, "ryzen 7 5800x": 108, "ryzen 7 5700x3d": 125,
    "ryzen 7 5800x3d": 130, "ryzen 9 5900x": 110, "ryzen 9 5950x": 111,
    "ryzen 5 8500g": 100, "ryzen 5 8600g": 110, "ryzen 7 8700g": 115,
    "ryzen 5 7500f": 122, "ryzen 5 7600": 125, "ryzen 5 7600x": 128, "ryzen 7 7700": 130,
    "ryzen 7 7700x": 132, "ryzen 7 7800x3d": 160, "ryzen 9 7900x": 135, "ryzen 9 7950x": 138,
    "ryzen 9 7950x3d": 158,
    "ryzen 5 9600x": 135, "ryzen 7 9700x": 140, "ryzen 7 9800x3d": 175, "ryzen 9 9900x": 142,
    "ryzen 9 9950x": 145,
    # AMD Ryzen mobile
    "ryzen 5 4600h": 70, "ryzen 5 5600h": 82, "ryzen 7 5800h": 88, "ryzen 7 6800h": 98,
    "ryzen 5 7535hs": 92, "ryzen 7 7840hs": 115, "ryzen 7 8845hs": 117,
    # Intel Core desktop
    "i3-10100": 65, "i3-12100": 92, "i3-13100": 96,
    "i5-6500": 50, "i5-7400": 52, "i5-8400": 62, "i5-9400": 66, "i5-10400": 78, "i5-11400": 88,
    "i5-12400": 105, "i5-12600k": 118, "i5-13400": 112, "i5-13600k": 135, "i5-14400": 115,
    "i5-14600k": 138,
    "i7-6700k": 60, "i7-7700k": 65, "i7-8700k": 75, "i7-9700k": 80, "i7-10700k": 90, "i7-11700k": 98,
    "i7-12700k": 125, "i7-13700k": 145, "i7-14700k": 150,
    "i9-9900k": 85, "i9-10900k": 95, "i9-12900k": 130, "i9-13900k": 152, "i9-14900k": 155,
    "ultra 5 245k": 130, "ultra 7 265k": 140, "ultra 9 285k": 148,
    # Intel Core mobile
    "i5-1135g7": 55, "i7-1165g7": 60, "i5-1235u": 60, "i7-1255u": 64, "i5-12450h": 85,
    "i7-12700h": 100, "i5-13420h": 90, "i7-13700h": 110, "i9-13900h": 118,
}

# FPS at 1080p / High with a score-100 GPU (`gpu`) and a score-100 CPU (`cpu`).
# `sens`: how much resolution and preset matter (esports titles barely care). `cap`: engine frame cap.
GAMES: List[Dict[str, Any]] = [
    {"id": "cs2", "name": "Counter-Strike 2", "genre": "Tiro competitivo", "gpu": 210, "cpu": 300, "vram": 4, "ram": 8, "sens": 0.8},
    {"id": "valorant", "name": "Valorant", "genre": "Tiro competitivo", "gpu": 420, "cpu": 420, "vram": 2, "ram": 4, "sens": 0.5},
    {"id": "lol", "name": "League of Legends", "genre": "MOBA", "gpu": 450, "cpu": 350, "vram": 2, "ram": 4, "sens": 0.4},
    {"id": "dota2", "name": "Dota 2", "genre": "MOBA", "gpu": 180, "cpu": 200, "vram": 4, "ram": 8, "sens": 0.6},
    {"id": "fortnite", "name": "Fortnite", "genre": "Battle royale", "gpu": 105, "cpu": 220, "vram": 6, "ram": 8, "sens": 0.9},
    {"id": "apex", "name": "Apex Legends", "genre": "Battle royale", "gpu": 150, "cpu": 220, "vram": 6, "ram": 8, "sens": 0.9, "cap": 300},
    {"id": "warzone", "name": "Call of Duty: Warzone", "genre": "Battle royale", "gpu": 95, "cpu": 160, "vram": 7, "ram": 12, "sens": 0.95},
    {"id": "cod", "name": "Call of Duty: Modern Warfare III", "genre": "Tiro", "gpu": 100, "cpu": 170, "vram": 7, "ram": 12, "sens": 0.95},
    {"id": "pubg", "name": "PUBG: Battlegrounds", "genre": "Battle royale", "gpu": 130, "cpu": 170, "vram": 6, "ram": 16, "sens": 0.9},
    {"id": "r6", "name": "Rainbow Six Siege", "genre": "Tiro competitivo", "gpu": 220, "cpu": 260, "vram": 4, "ram": 8, "sens": 0.8},
    {"id": "rivals", "name": "Marvel Rivals", "genre": "Tiro em equipe", "gpu": 70, "cpu": 140, "vram": 6, "ram": 16, "sens": 1.0},
    {"id": "rocket", "name": "Rocket League", "genre": "Esporte", "gpu": 260, "cpu": 280, "vram": 2, "ram": 8, "sens": 0.6},
    {"id": "fc25", "name": "EA Sports FC 25", "genre": "Esporte", "gpu": 140, "cpu": 200, "vram": 6, "ram": 8, "sens": 0.9},
    {"id": "minecraft", "name": "Minecraft (Java)", "genre": "Sandbox", "gpu": 300, "cpu": 220, "vram": 2, "ram": 8, "sens": 0.5},
    {"id": "roblox", "name": "Roblox", "genre": "Sandbox", "gpu": 260, "cpu": 240, "vram": 2, "ram": 4, "sens": 0.5},
    {"id": "gta5", "name": "GTA V", "genre": "Mundo aberto", "gpu": 135, "cpu": 150, "vram": 4, "ram": 8, "sens": 0.9},
    {"id": "rdr2", "name": "Red Dead Redemption 2", "genre": "Mundo aberto", "gpu": 68, "cpu": 140, "vram": 6, "ram": 12, "sens": 1.0},
    {"id": "cyberpunk", "name": "Cyberpunk 2077", "genre": "RPG", "gpu": 66, "cpu": 120, "vram": 6, "ram": 12, "sens": 1.0},
    {"id": "witcher3", "name": "The Witcher 3 (next-gen)", "genre": "RPG", "gpu": 90, "cpu": 150, "vram": 6, "ram": 8, "sens": 1.0},
    {"id": "eldenring", "name": "Elden Ring", "genre": "RPG", "gpu": 75, "cpu": 150, "vram": 6, "ram": 12, "sens": 1.0, "cap": 60},
    {"id": "bg3", "name": "Baldur's Gate 3", "genre": "RPG", "gpu": 90, "cpu": 110, "vram": 6, "ram": 16, "sens": 1.0},
    {"id": "hogwarts", "name": "Hogwarts Legacy", "genre": "RPG", "gpu": 62, "cpu": 100, "vram": 8, "ram": 16, "sens": 1.0},
    {"id": "starfield", "name": "Starfield", "genre": "RPG", "gpu": 48, "cpu": 80, "vram": 7, "ram": 16, "sens": 1.0},
    {"id": "wukong", "name": "Black Myth: Wukong", "genre": "Ação", "gpu": 50, "cpu": 110, "vram": 7, "ram": 16, "sens": 1.0},
    {"id": "fh5", "name": "Forza Horizon 5", "genre": "Corrida", "gpu": 100, "cpu": 170, "vram": 6, "ram": 12, "sens": 1.0},
]

RESOLUTIONS = {"1080p": 1.0, "1440p": 0.70, "4k": 0.40}
RES_VRAM = {"1080p": 1.0, "1440p": 1.1, "4k": 1.3}
PRESETS = {"low": 1.75, "medium": 1.35, "high": 1.0, "ultra": 0.78}
PRESET_VRAM = {"low": 0.6, "medium": 0.8, "high": 1.0, "ultra": 1.15}
PRESET_CPU = {"low": 1.1, "medium": 1.05, "high": 1.0, "ultra": 0.97}
LAPTOP_GPU_FACTOR = 0.8
UNKNOWN_CPU_SCORE = 80.0
BLEND_K = 4  # how sharply the slower component (CPU or GPU) dominates


def _normalize(name: str) -> str:
    n = name.lower()
    n = re.sub(r"\((r|tm|c)\)|®|™", " ", n)
    for noise in ("nvidia", "geforce", "amd", "radeon(tm)", "intel(r)", "core(tm)", "processor",
                  "with radeon graphics", "-core", "cpu", "@"):
        n = n.replace(noise, " ")
    n = n.replace("core ", " ").replace("rx ", "rx ").replace("_", " ")
    return re.sub(r"\s+", " ", n).strip()


def _best_key(name: str, table: Dict[str, Any]) -> Optional[str]:
    """Longest table key found in the name as whole words (a trailing model suffix like the
    F in i5-12400F is allowed, so "i5-12400" still matches)."""
    norm = _normalize(name)
    best = None
    for key in table:
        pattern = r"(?<![a-z0-9])" + re.escape(key) + r"(?:[a-z]{1,2})?(?![a-z0-9])"
        if re.search(pattern, norm) and (best is None or len(key) > len(best)):
            best = key
    return best


def match_gpu(name: str) -> Dict[str, Any]:
    key = _best_key(name, GPUS)
    laptop = bool(re.search(r"laptop|mobile|max-q", name, re.I))
    if not key:
        return {"key": None, "name": name, "score": None, "vram": None, "laptop": laptop}
    score, vram = GPUS[key]
    return {"key": key, "name": name, "score": score * (LAPTOP_GPU_FACTOR if laptop else 1), "vram": vram, "laptop": laptop}


def match_cpu(name: str) -> Dict[str, Any]:
    key = _best_key(name, CPUS)
    return {"key": key, "name": name, "score": CPUS[key] if key else None}


def detect_hardware() -> Dict[str, Any]:
    specs = get_hardware_specs()
    gpus = [match_gpu(str(g.get("Name") or "")) for g in specs.get("gpus", []) if g.get("Name")]
    # Systems with integrated + dedicated graphics: the game runs on the faster one.
    known = [g for g in gpus if g["score"]]
    gpu = max(known, key=lambda g: g["score"]) if known else (gpus[0] if gpus else {"key": None, "name": "Não detectada", "score": None, "vram": None, "laptop": False})
    cpu = match_cpu(str((specs.get("cpu") or {}).get("Name") or "").strip())
    ram_gb = round(psutil.virtual_memory().total / (1024 ** 3))
    return {"gpu": gpu, "cpu": cpu, "ram_gb": ram_gb}


def _label(fps: float) -> Tuple[str, str]:
    if fps < 30:
        return "Não recomendado", "bad"
    if fps < 45:
        return "Jogável", "warn"
    if fps < 60:
        return "Bom", "ok"
    if fps < 144:
        return "Fluido", "ok"
    return "Competitivo", "great"


def estimate_game(game: Dict[str, Any], gpu_score: float, gpu_vram: float, cpu_score: float,
                  ram_gb: float, resolution: str, preset: str) -> Dict[str, Any]:
    sens = game.get("sens", 1.0)
    gpu_fps = game["gpu"] * (gpu_score / 100) * (RESOLUTIONS[resolution] ** sens) * (PRESETS[preset] ** sens)
    cpu_fps = game["cpu"] * (cpu_score / 100) * PRESET_CPU[preset]
    fps = (gpu_fps ** -BLEND_K + cpu_fps ** -BLEND_K) ** (-1 / BLEND_K)

    notes = []
    vram_need = game["vram"] * PRESET_VRAM[preset] * RES_VRAM[resolution]
    if gpu_vram and gpu_vram + 0.5 < vram_need:
        fps *= 0.8
        notes.append(f"VRAM curta: o jogo pede ~{vram_need:.0f} GB nessa qualidade e a placa tem {gpu_vram:g} GB")
    if ram_gb and ram_gb < game["ram"]:
        fps *= 0.85
        notes.append(f"Pouca RAM: recomendado {game['ram']} GB, você tem {ram_gb} GB")

    capped = False
    if game.get("cap") and fps > game["cap"]:
        fps = game["cap"]
        capped = True
        notes.append(f"O jogo limita a {game['cap']} FPS")

    label, tone = _label(fps)
    bottleneck = "gpu" if gpu_fps <= cpu_fps else "cpu"
    return {
        "id": game["id"],
        "name": game["name"],
        "genre": game["genre"],
        "fps": round(fps),
        "fps_low": round(fps * (1 if capped else 0.85)),
        "fps_high": round(fps * (1 if capped else 1.15)),
        "label": label,
        "tone": tone,
        "bottleneck": None if capped else bottleneck,
        "notes": notes,
    }


# Words that identify each game in a process/window title (lowercase).
_TITLE_HINTS: Dict[str, List[str]] = {
    "cs2": ["counter-strike", "cs2"], "valorant": ["valorant"], "lol": ["league of legends"],
    "dota2": ["dota"], "fortnite": ["fortnite"], "apex": ["apex"], "warzone": ["warzone"],
    "cod": ["call of duty", "modern warfare"], "pubg": ["pubg", "battlegrounds"],
    "r6": ["rainbow six"], "rivals": ["marvel rivals"], "rocket": ["rocket league"],
    "fc25": ["fc 24", "fc 25", "fc 26", "fifa", "ea sports fc"], "minecraft": ["minecraft"],
    "roblox": ["roblox"], "gta5": ["grand theft auto v", "gta v", "gta5"], "rdr2": ["red dead"],
    "cyberpunk": ["cyberpunk"], "witcher3": ["witcher"], "eldenring": ["elden ring"],
    "bg3": ["baldur"], "hogwarts": ["hogwarts"], "starfield": ["starfield"], "wukong": ["wukong"],
    "fh5": ["forza horizon"],
}
_hw_cache: Dict[str, Any] = {"t": 0.0, "hw": None}


def estimate_fps_for_title(title: str) -> Optional[Dict[str, Any]]:
    """Estimated FPS (1080p / High) for a running game, or None when the game is not in the table
    or the graphics card is not recognized. This is an estimate from hardware, not a measurement."""
    low = (title or "").lower()
    game = next(
        (g for g in GAMES if any(h in low for h in _TITLE_HINTS.get(g["id"], []))),
        None,
    )
    if not game:
        return None

    import time
    if not _hw_cache["hw"] or time.time() - _hw_cache["t"] > 120:
        _hw_cache.update(t=time.time(), hw=detect_hardware())
    hw = _hw_cache["hw"]
    gpu, cpu = hw["gpu"], hw["cpu"]
    if not gpu.get("score"):
        return None
    return estimate_game(
        game, gpu["score"], gpu.get("vram") or 0, cpu.get("score") or UNKNOWN_CPU_SCORE,
        hw["ram_gb"], "1080p", "high",
    )


def estimate_all(gpu_key: Optional[str], cpu_key: Optional[str], ram_gb: Optional[float],
                 resolution: str = "1080p", preset: str = "high") -> Dict[str, Any]:
    resolution = resolution if resolution in RESOLUTIONS else "1080p"
    preset = preset if preset in PRESETS else "high"
    hw = detect_hardware()

    # The user may pick another GPU/CPU in the UI (e.g. one we could not recognize).
    if gpu_key in GPUS:
        gpu_score, gpu_vram = GPUS[gpu_key]
        if gpu_key == hw["gpu"].get("key") and hw["gpu"].get("laptop"):
            gpu_score *= LAPTOP_GPU_FACTOR
    else:
        gpu_score, gpu_vram = hw["gpu"].get("score"), hw["gpu"].get("vram")
    cpu_score = CPUS.get(cpu_key) if cpu_key in CPUS else hw["cpu"].get("score")
    ram = ram_gb or hw["ram_gb"]

    if not gpu_score:
        return {"ok": False, "message": "Não reconhecemos sua placa de vídeo. Escolha o modelo mais próximo na lista.", "games": []}
    cpu_unknown = not cpu_score
    cpu_score = cpu_score or UNKNOWN_CPU_SCORE

    games = [estimate_game(g, gpu_score, gpu_vram or 0, cpu_score, ram, resolution, preset) for g in GAMES]
    games.sort(key=lambda g: g["fps"], reverse=True)
    return {
        "ok": True,
        "resolution": resolution,
        "preset": preset,
        "cpu_unknown": cpu_unknown,
        "games": games,
    }


_WORD_LABELS = {
    "rtx": "RTX", "gtx": "GTX", "rx": "RX", "xt": "XT", "xtx": "XTX", "gre": "GRE", "ti": "Ti",
    "super": "Super", "arc": "Arc", "intel": "Intel", "uhd": "UHD", "hd": "HD", "iris": "Iris", "xe": "Xe",
    "radeon": "Radeon", "vega": "Vega", "vii": "VII", "graphics": "Graphics", "ryzen": "Ryzen",
    "ultra": "Core Ultra", "3gb": "3GB",
}


def _pretty(key: str) -> str:
    if re.match(r"^i\d-", key):
        return "Core " + key.upper().replace("I", "i", 1)
    words = []
    for w in key.split():
        words.append(_WORD_LABELS.get(w) or (w.upper() if re.search(r"\d", w) else w.capitalize()))
    return " ".join(words)


def _gpu_vendor(key: str) -> str:
    if key.startswith(("rtx", "gtx")):
        return "NVIDIA"
    if key.startswith(("arc", "intel")):
        return "Intel"
    return "AMD"


def catalog() -> Dict[str, Any]:
    hw = detect_hardware()
    gpus = sorted(GPUS.items(), key=lambda kv: (_gpu_vendor(kv[0]), kv[1][0]))
    cpus = sorted(CPUS.items(), key=lambda kv: ("AMD" if kv[0].startswith("ryzen") else "Intel", kv[1]))
    return {
        "detected": hw,
        "gpus": [{"key": k, "label": _pretty(k), "group": _gpu_vendor(k), "vram": v[1]} for k, v in gpus],
        "cpus": [{"key": k, "label": _pretty(k), "group": "AMD" if k.startswith("ryzen") else "Intel"} for k, _ in cpus],
        "resolutions": list(RESOLUTIONS.keys()),
        "presets": list(PRESETS.keys()),
    }
