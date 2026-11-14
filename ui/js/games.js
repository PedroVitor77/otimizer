// ================= LIVE GAMER HUB & TELEMETRY =================
let isGamerTelemetryPolling = false;
const fpsWaveHistory = [];

function drawGamerFrametimeWave(ftMs, active) {
  const canvas = document.getElementById("fpsFrametimeCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);

  // Subtle flat guide line when waiting
  if (!active || fpsWaveHistory.length < 2) {
    ctx.strokeStyle = "rgba(56, 189, 248, 0.22)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(4, h * 0.65);
    ctx.lineTo(w - 4, h * 0.65);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const maxMs = Math.max(33, ...fpsWaveHistory) * 1.15;
  const pts = fpsWaveHistory.map((v, i) => ({
    x: (i / Math.max(1, fpsWaveHistory.length - 1)) * (w - 8) + 4,
    y: h - 5 - (Math.min(maxMs, Math.max(0, v)) / maxMs) * (h - 10)
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = cssVar("--lime") || "#9BE22D";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(155, 226, 45, 0.25)");
  grad.addColorStop(1, "rgba(155, 226, 45, 0)");
  ctx.fillStyle = grad;
  ctx.fill();
}

function drawGamerGpuRing(loadPct) {
  const canvas = document.getElementById("gamerGpuRingCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);
  const pct = Math.max(0, Math.min(100, Number(loadPct) || 0));
  const color = pct >= 90 ? (cssVar("--warn") || "#f5b83d") : (cssVar("--cyan") || "#38BDF8");
  drawArc(ctx, w / 2, h / 2, Math.min(w, h) / 2 - 7, 7, pct, color, cssVar("--track"));
}

async function pollGamerTelemetry() {
  if (isGamerTelemetryPolling) return;
  isGamerTelemetryPolling = true;

  try {
    const res = await fetch("/api/game-monitor/telemetry");
    if (!res.ok) return;
    const data = await res.json();

    // 1. Active Game Hero Card
    const game = data.game || {};
    const statusBadge = document.getElementById("game-status-badge");
    const pidBadge = document.getElementById("game-pid-badge");
    const titleEl = document.getElementById("game-active-title");
    const descEl = document.getElementById("game-active-desc");

    if (game.active) {
      if (statusBadge) {
        statusBadge.className = "badge badge-green";
        statusBadge.innerHTML = `<span class="live-dot"></span>Jogo Detectado: ${escapeHtml(game.name)}`;
      }
      if (pidBadge) {
        pidBadge.style.display = "inline-block";
        pidBadge.textContent = `PID: ${game.pid}`;
      }
      if (titleEl) titleEl.textContent = game.name;
      if (descEl) {
        const cpuTxt = game.game_cpu_percent != null ? `${game.game_cpu_percent}%` : "--";
        const ramTxt = game.game_ram_mb != null ? `${game.game_ram_mb} MB` : "--";
        descEl.textContent = `Processo ${game.exe_name || ""} • CPU: ${cpuTxt} • RAM: ${ramTxt}`;
      }
    } else {
      if (statusBadge) {
        statusBadge.className = "badge badge-cyan";
        statusBadge.innerHTML = `<span class="live-dot" style="background:var(--accent-cyan);"></span>Pronto para Jogar`;
      }
      if (pidBadge) pidBadge.style.display = "none";
      if (titleEl) titleEl.textContent = "Nenhum jogo em execução";
      if (descEl) {
        descEl.textContent = "Inicie qualquer jogo (Steam, Epic, Riot, EA, Battle.net). O PulsePC detectará e otimizará automaticamente.";
      }
    }

    // 2. FPS & Frametime Card
    const fpsDisp = document.getElementById("gamer-fps-display");
    const ftDisp = document.getElementById("gamer-frametime-detail");
    const lowDisp = document.getElementById("gamer-1pct-low");
    const stabTag = document.getElementById("gamer-stability-tag");

    // Real FPS of the running game, read with PresentMon (see core/fps_capture.py)
    const fpsOk = game.active && game.fps_status === "running" && game.fps_current;
    const btnFpsAdmin = document.getElementById("btn-fps-admin");
    const badgeFps = document.getElementById("gamer-stability-badge");
    if (fpsDisp) fpsDisp.textContent = fpsOk ? game.fps_current : "--";
    if (ftDisp) {
      ftDisp.textContent = fpsOk
        ? `Tempo de quadro: ${game.frame_time_ms} ms`
        : (game.active ? (game.fps_message || "Medindo...") : "Inicie um jogo para medir o FPS.");
    }
    if (lowDisp) lowDisp.textContent = fpsOk && game.fps_1pct_low ? `${game.fps_1pct_low} FPS` : "-- FPS";
    if (stabTag) {
      stabTag.textContent = fpsOk && game.fps_1pct_low ? (game.fps_1pct_low >= 55 ? "Estável" : "Oscilando") : "";
      stabTag.style.color = fpsOk && game.fps_1pct_low >= 55 ? "var(--accent-emerald)" : "var(--accent-amber)";
    }
    if (badgeFps) {
      badgeFps.textContent = fpsOk ? "Ao vivo" : (game.fps_status === "needs_admin" ? "Requer admin" : "Aguardando");
      badgeFps.className = fpsOk ? "badge badge-green" : (game.fps_status === "needs_admin" ? "badge badge-amber" : "badge badge-cyan");
    }
    if (btnFpsAdmin) btnFpsAdmin.style.display = game.active && game.fps_status === "needs_admin" ? "block" : "none";

    if (fpsOk && game.frame_time_ms) {
      fpsWaveHistory.push(Number(game.frame_time_ms) || 16.6);
      if (fpsWaveHistory.length > 42) fpsWaveHistory.shift();
    } else if (!game.active) {
      fpsWaveHistory.length = 0;
    }
    drawGamerFrametimeWave(game.frame_time_ms, Boolean(fpsOk));

    // 3. GPU & VRAM Card
    const hw = data.hardware || {};
    const gpuLoad = document.getElementById("gamer-gpu-load-display");
    const gpuTemp = document.getElementById("gamer-gpu-temp-badge");
    const gpuName = document.getElementById("gamer-gpu-shortname");
    const gpuBar = document.getElementById("gamer-gpu-bar");
    const vramUsed = document.getElementById("gamer-vram-used");
    const vramTotal = document.getElementById("gamer-vram-total");
    const vramPct = document.getElementById("gamer-vram-pct");
    const vramBar = document.getElementById("gamer-vram-bar");

    if (gpuLoad) gpuLoad.textContent = `${hw.gpu_load || 0}%`;
    drawGamerGpuRing(hw.gpu_load || 0);
    if (gpuTemp) {
      gpuTemp.textContent = hw.gpu_temp && hw.gpu_temp !== "--" ? `${hw.gpu_temp} °C` : "-- °C";
      gpuTemp.className = Number(hw.gpu_temp) > 80 ? "badge badge-amber" : "badge badge-green";
    }
    if (gpuName && hw.gpu_name) {
      gpuName.textContent = hw.gpu_name.length > 25 ? hw.gpu_name.slice(0, 22) + "..." : hw.gpu_name;
      gpuName.title = hw.gpu_name;
    }
    if (gpuBar) gpuBar.style.width = `${Math.min(100, hw.gpu_load || 0)}%`;
    if (vramUsed) vramUsed.textContent = hw.vram_used_mb || 0;
    if (vramTotal) vramTotal.textContent = hw.vram_total_mb || 0;
    if (vramPct) vramPct.textContent = `${hw.vram_percent || 0}%`;
    if (vramBar) vramBar.style.width = `${Math.min(100, hw.vram_percent || 0)}%`;

    // 4. CPU & RAM Card
    const cpuLoad = document.getElementById("gamer-cpu-load-display");
    const cpuTemp = document.getElementById("gamer-cpu-temp-badge");
    const cpuFreq = document.getElementById("gamer-cpu-freq-display");
    const cpuBar = document.getElementById("gamer-cpu-bar");
    const ramUsed = document.getElementById("gamer-ram-used");
    const ramTotal = document.getElementById("gamer-ram-total");
    const ramPct = document.getElementById("gamer-ram-pct");
    const ramGamerBar = document.getElementById("gamer-ram-bar");

    if (cpuLoad) cpuLoad.textContent = `${hw.cpu_load || 0}%`;
    if (cpuTemp) {
      cpuTemp.textContent = hw.cpu_temp && hw.cpu_temp !== "--" ? `${hw.cpu_temp} °C` : "-- °C";
      cpuTemp.className = Number(hw.cpu_temp) > 80 ? "badge badge-amber" : "badge badge-cyan";
    }
    if (cpuFreq) cpuFreq.textContent = hw.cpu_freq_mhz ? `${hw.cpu_freq_mhz} MHz` : "-- MHz";
    if (cpuBar) cpuBar.style.width = `${Math.min(100, hw.cpu_load || 0)}%`;
    if (ramUsed) ramUsed.textContent = hw.ram_used_gb || 0;
    if (ramTotal) ramTotal.textContent = hw.ram_total_gb || 0;
    if (ramPct) ramPct.textContent = `${hw.ram_percent || 0}%`;
    if (ramGamerBar) ramGamerBar.style.width = `${Math.min(100, hw.ram_percent || 0)}%`;

    // 5. Ping Card
    const ping = data.ping || {};
    const pingMain = document.getElementById("gamer-ping-main");
    const pingRiot = document.getElementById("ping-riot-val");
    const pingValve = document.getElementById("ping-valve-val");
    const pingCf = document.getElementById("ping-cf-val");
    const pingStatus = document.getElementById("gamer-ping-status-badge");

    const fmtMs = (v) => (v ? `${v} ms` : "sem resposta");
    const available = [ping.riot_br, ping.valve_br, ping.cloudflare].filter(Boolean);
    const bestPing = available.length ? Math.min(...available) : null;
    if (pingMain) pingMain.textContent = bestPing ?? "--";
    if (pingRiot) pingRiot.textContent = fmtMs(ping.riot_br);
    if (pingValve) pingValve.textContent = fmtMs(ping.valve_br);
    if (pingCf) pingCf.textContent = fmtMs(ping.cloudflare);

    if (pingStatus) {
      if (bestPing === null) {
        pingStatus.textContent = "Sem resposta";
        pingStatus.className = "badge badge-amber";
      } else if (bestPing < 30) {
        pingStatus.textContent = "Excelente";
        pingStatus.className = "badge badge-green";
      } else if (bestPing < 60) {
        pingStatus.textContent = "Muito Bom";
        pingStatus.className = "badge badge-cyan";
      } else {
        pingStatus.textContent = "Normal";
        pingStatus.className = "badge badge-amber";
      }
    }

    // HUD preview strip
    const hudPreview = document.getElementById("hud-preview-metrics");
    if (hudPreview) {
      const fpsStr = fpsOk ? `${game.fps_current}` : "--";
      const ftStr = fpsOk && game.frame_time_ms ? `${game.frame_time_ms} ms` : "-- ms";
      const pingStr = bestPing !== null ? `${bestPing} ms` : "-- ms";
      hudPreview.textContent = `FPS ${fpsStr} • Frame ${ftStr} • GPU ${hw.gpu_load || 0}% • CPU ${hw.cpu_load || 0}% • Ping ${pingStr}`;
    }

    // 6. Overlay HUD button state
    const btnHud = document.getElementById("btn-toggle-hud");
    if (btnHud) {
      if (data.hud_active) {
        btnHud.innerHTML = `<span>■ Ocultar Overlay HUD</span>`;
        btnHud.classList.remove("btn-secondary");
        btnHud.classList.add("btn-danger");
      } else {
        btnHud.innerHTML = `<span>🪟 Ativar Overlay HUD</span>`;
        btnHud.classList.remove("btn-danger");
        btnHud.classList.add("btn-secondary");
      }
    }

  } catch (e) {
    // silently catch to avoid spamming console
  } finally {
    isGamerTelemetryPolling = false;
  }
}

async function toggleFloatingGamerHUD() {
  const btn = document.getElementById("btn-toggle-hud");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/game-monitor/overlay/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data.hud_active) {
      showToast("Overlay HUD Flutuante ativado! Você pode clicar e arrastar a barra neon no topo da tela para onde preferir.", "success");
    } else {
      showToast("Overlay HUD Flutuante desativado.", "info");
    }
    await pollGamerTelemetry();
  } catch (e) {
    showToast("Erro ao alternar Overlay HUD.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function optimizeActiveGameNow() {
  const btn = document.getElementById("btn-game-turbo-boost");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/game-monitor/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Turbo Gamer Ativado!", "success");
      await pollGamerTelemetry();
      await pollMetrics();
      await loadHistoryStats();
    } else {
      showToast("Não foi possível aplicar Turbo Gamer.", "error");
    }
  } catch (e) {
    showToast("Erro ao ativar Turbo Gamer.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function purgeStandbyListQuick() {
  purgeStandbyNow();
}

async function loadGamerTweaks() {
  try {
    const res = await fetch("/api/game-monitor/tweaks");
    if (!res.ok) return;
    const data = await res.json();
    const chkMouse = document.getElementById("tweak-mouse-raw");
    const chkBooster = document.getElementById("tweak-auto-booster");
    if (chkMouse && data.mouse_raw_input !== undefined) {
      chkMouse.checked = data.mouse_raw_input;
    }
    if (chkBooster && data.game_booster_active !== undefined) {
      chkBooster.checked = data.game_booster_active;
    }
  } catch (e) {}
}

async function toggleMouseRawInput(checked) {
  try {
    const res = await fetch("/api/game-monitor/tweaks/mouse-raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable: checked })
    });
    const data = await res.json();
    if (data.success) {
      showToast(checked ? "Precisão 1:1 do Mouse ativada (Sem aceleração Windows)!" : "Aceleração padrão do Windows restaurada.", "info");
    } else {
      showToast("Não foi possível alterar a aceleração do mouse.", "error");
    }
  } catch (e) {
    showToast("Erro ao configurar precisão do mouse.", "error");
  }
}

// ================= GAMES: ESTIMATED FPS =================
const gamesState = { loaded: false, data: null, resolution: "1080p", preset: "high", seq: 0 };

function fillHwSelect(select, items, detectedKey, detectedName) {
  const groups = {};
  items.forEach(it => (groups[it.group] = groups[it.group] || []).push(it));
  let html = detectedKey ? "" : `<option value="">Não reconhecido: ${escapeHtml(detectedName || "--")}</option>`;
  // Highest-scoring models first inside each vendor
  Object.keys(groups).forEach(g => {
    html += `<optgroup label="${escapeHtml(g)}">` +
      groups[g].slice().reverse().map(it => `<option value="${escapeHtml(it.key)}">${escapeHtml(it.label)}</option>`).join("") +
      `</optgroup>`;
  });
  select.innerHTML = html;
  select.value = detectedKey || "";
}

async function loadGames() {
  if (!gamesState.loaded) {
    document.getElementById("games-grid").innerHTML =
      `<div class="card" style="text-align:center; padding:40px; color:var(--text-secondary);"><span class="spinner"></span> Lendo o hardware do PC...</div>`;
    try {
      const res = await fetch("/api/games/catalog");
      const cat = await res.json();
      const hw = cat.detected;
      fillHwSelect(document.getElementById("games-gpu"), cat.gpus, hw.gpu.key, hw.gpu.name);
      fillHwSelect(document.getElementById("games-cpu"), cat.cpus, hw.cpu.key, hw.cpu.name);
      document.getElementById("games-gpu-detected").textContent = `Detectada: ${hw.gpu.name || "--"}`;
      document.getElementById("games-cpu-detected").textContent = `Detectado: ${hw.cpu.name || "--"}`;
      const ramSel = document.getElementById("games-ram");
      const ramOpts = [...ramSel.options].map(o => Number(o.value));
      ramSel.value = String(ramOpts.reduce((best, v) => Math.abs(v - hw.ram_gb) < Math.abs(best - hw.ram_gb) ? v : best, ramOpts[0]));
      document.getElementById("games-ram-detected").textContent = `Detectada: ${hw.ram_gb} GB`;
      gamesState.loaded = true;
    } catch (e) {
      document.getElementById("games-grid").innerHTML = "";
      showToast("Não foi possível ler o hardware para estimar o FPS.", "error");
      return;
    }
  }
  await estimateGames();
}

async function estimateGames() {
  const seq = ++gamesState.seq;
  try {
    const res = await fetch("/api/games/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gpu: document.getElementById("games-gpu").value || null,
        cpu: document.getElementById("games-cpu").value || null,
        ram_gb: Number(document.getElementById("games-ram").value) || null,
        resolution: gamesState.resolution,
        preset: gamesState.preset
      })
    });
    const data = await res.json();
    if (seq !== gamesState.seq) return; // a newer choice already replaced this one
    gamesState.data = data;
    renderGames();
  } catch (e) {
    showToast("Erro ao estimar o FPS dos jogos.", "error");
  }
}

function renderGames() {
  const data = gamesState.data;
  const grid = document.getElementById("games-grid");
  const warn = document.getElementById("games-warning");
  if (!data) return;

  if (!data.ok) {
    warn.innerHTML = `<span>${escapeHtml(data.message)}</span>`;
    warn.hidden = false;
    grid.innerHTML = "";
    return;
  }
  if (data.cpu_unknown) {
    warn.innerHTML = `<span>Não reconhecemos o processador, então usamos um desempenho médio. Escolha o modelo mais próximo na lista para uma estimativa melhor.</span>`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  const q = (document.getElementById("games-search").value || "").toLowerCase();
  const games = data.games.filter(g => !q || g.name.toLowerCase().includes(q) || g.genre.toLowerCase().includes(q));
  if (!games.length) {
    grid.innerHTML = `<div class="card" style="text-align:center; padding:30px; color:var(--text-secondary);">Nenhum jogo encontrado para "${escapeHtml(q)}".</div>`;
    return;
  }

  const METER_MAX = 240;
  grid.innerHTML = games.map(g => {
    const limit = g.bottleneck === "gpu" ? "Limitado pela placa de vídeo"
      : g.bottleneck === "cpu" ? "Limitado pelo processador" : "";
    const range = g.fps_low === g.fps_high ? `Travado em ${g.fps} FPS` : `Entre ${g.fps_low} e ${g.fps_high} FPS`;
    return `
      <div class="card game-card">
        <div class="game-top">
          <div style="min-width:0;">
            <div class="game-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
            <div class="game-genre">${escapeHtml(g.genre)}</div>
          </div>
          <span class="badge game-badge ${g.tone}">${escapeHtml(g.label)}</span>
        </div>
        <div class="game-fps"><b>${g.fps}</b><span>FPS</span></div>
        <div class="game-range">${range}</div>
        <div class="fps-meter" title="Marcas em 60 e 144 FPS">
          <div class="fps-fill ${g.tone}" style="width:${Math.min(100, (g.fps / METER_MAX) * 100)}%"></div>
          <i style="left:${(60 / METER_MAX) * 100}%"></i>
          <i style="left:${(144 / METER_MAX) * 100}%"></i>
        </div>
        <div class="game-foot">
          ${limit ? `<span>${limit}</span>` : ""}
          ${g.notes.map(n => `<span class="game-note">${escapeHtml(n)}</span>`).join("")}
        </div>
      </div>`;
  }).join("");
}

["games-res", "games-preset"].forEach(groupId => {
  document.getElementById(groupId).addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    document.querySelectorAll(`#${groupId} .seg-btn`).forEach(b => b.classList.toggle("active", b === btn));
    if (groupId === "games-res") gamesState.resolution = btn.dataset.v;
    else gamesState.preset = btn.dataset.v;
    estimateGames();
  });
});

