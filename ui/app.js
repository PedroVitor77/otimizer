// State
const HISTORY_LEN = 90;
const cpuHistory = [];
const ramHistory = [];
let currentProcesses = [];
let currentPrograms = [];
let hardwareSpecsData = null;
let lastLargeFiles = [];
let lastDupGroups = [];
let lastJunkScan = null;
let isAdmin = null; // null until the first metrics poll answers

const TAB_TITLES = {
  "tab-dashboard": ["Painel", "Saúde do PC em tempo real"],
  "tab-games": ["Jogos e FPS", "Quanto seu PC deve rodar nos jogos mais populares"],
  "tab-cleaner": ["Limpeza", "Caches, temporários e restos de atualizações"],
  "tab-large-files": ["Arquivos grandes", "O que mais ocupa espaço no disco"],
  "tab-duplicates": ["Duplicados", "Cópias idênticas ocupando espaço em dobro"],
  "tab-optimizer": ["Otimizar e Turbo", "Memória, energia, rede e ajustes do Windows"],
  "tab-manager": ["Processos e apps", "O que está rodando, o que inicia com o Windows e o que está instalado"],
  "tab-repair": ["Reparo e histórico", "Ferramentas do Windows, ficha técnica e ganhos acumulados"]
};

// Navigation
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    const tabId = item.getAttribute("data-tab");
    switchTab(tabId);
  });
});

function switchTab(tabId) {
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.getAttribute("data-tab") === tabId);
  });
  document.querySelectorAll(".tab-pane").forEach(el => {
    el.classList.toggle("active", el.id === tabId);
  });
  const [title, sub] = TAB_TITLES[tabId] || ["PulsePC", ""];
  document.getElementById("topbar-title").textContent = title;
  document.getElementById("topbar-subtitle").textContent = sub;

  // Lazy load tab data when switching
  if (tabId === "tab-optimizer") {
    loadWindowsTweaks();
    testPingOnly();
    pollGameBoosterStatus();
    loadBenchmarkData();
  } else if (tabId === "tab-games") {
    loadGames();
  } else if (tabId === "tab-manager") {
    loadProcesses();
  } else if (tabId === "tab-repair") {
    loadHardwareSpecs();
    loadBatteryHealth();
    setTimeout(() => checkUpdates(true), 3500);
    loadHistoryStats();
  }
}

function switchManagerSubTab(subId, btnEl) {
  ["sub-processes", "sub-startup", "sub-programs"].forEach(id => {
    document.getElementById(id).style.display = id === subId ? "block" : "none";
  });
  document.querySelectorAll(".sub-nav-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");

  if (subId === "sub-processes") loadProcesses();
  if (subId === "sub-startup") loadStartupItems();
  if (subId === "sub-programs") loadInstalledPrograms();
}

// Toast Notification
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 4200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Canvas Gauge & Sparklines
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Sizes the canvas backing store to its on-screen size and the device pixel ratio.
// Returns null while the pane is hidden (zero size).
function setupCanvas(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function scoreColor(score) {
  if (score < 55) return "var(--bad)";
  if (score < 75) return "var(--warn)";
  return "var(--lime)";
}

// Draws one rounded arc with a glow; value is 0..100 of a full turn.
function drawArc(ctx, cx, cy, radius, width, value, color, track) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = track;
  ctx.lineWidth = width;
  ctx.stroke();

  const v = Math.max(0, Math.min(100, value));
  if (v <= 0) return;
  const start = -Math.PI / 2;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * (v / 100));
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

function drawScoreRing(score) {
  const canvas = document.getElementById("scoreRingCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);
  const color = score < 55 ? cssVar("--bad") : score < 75 ? cssVar("--warn") : cssVar("--lime");
  drawArc(ctx, w / 2, h / 2, Math.min(w, h) / 2 - 14, 14, score, color, cssVar("--track"));
}

// Concentric rings like an activity tracker: CPU outside, RAM in the middle, main disk inside.
function drawRings(cpu, ram, disk) {
  const canvas = document.getElementById("ringsCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);
  const r0 = Math.min(w, h) / 2 - 12;
  const track = cssVar("--track");
  drawArc(ctx, w / 2, h / 2, r0, 13, cpu, cssVar("--lime"), track);
  drawArc(ctx, w / 2, h / 2, r0 - 19, 13, ram, cssVar("--lime-2"), track);
  drawArc(ctx, w / 2, h / 2, r0 - 38, 13, disk, cssVar("--lime-3"), track);
}

// Live chart: CPU (lime, filled, with markers) and RAM (soft line) over the last ~2 minutes.
function drawStrip() {
  const canvas = document.getElementById("stripCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);

  const padL = 34, padR = 10, padT = 10, padB = 8;
  const plotW = w - padL - padR;
  const yOf = (v) => padT + (1 - Math.min(100, Math.max(0, v)) / 100) * (h - padT - padB);

  // Grid and axis labels
  ctx.font = "600 11px Manrope, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  [0, 25, 50, 75, 100].forEach(v => {
    const y = yOf(v);
    ctx.strokeStyle = cssVar("--grid");
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar("--ink-3");
    ctx.fillText(`${v}`, padL - 10, y);
  });

  const plot = (data, color, width, fill, markers) => {
    if (data.length < 2) return;
    // The line grows left to right until the window fills, then scrolls.
    const stepX = plotW / (HISTORY_LEN - 1);
    const pts = data.map((v, i) => ({ x: padL + i * stepX, y: yOf(v) }));
    const trace = () => {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    };
    if (fill) {
      ctx.beginPath();
      trace();
      ctx.lineTo(pts[pts.length - 1].x, h - padB);
      ctx.lineTo(pts[0].x, h - padB);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, h - padB);
      g.addColorStop(0, cssVar("--lime-fill"));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.save();
    if (fill) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();

    if (markers) {
      ctx.fillStyle = color;
      for (let i = pts.length - 1; i >= 0; i -= 12) {
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const lp = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  plot(ramHistory, cssVar("--ram-line"), 1.6, false, false);
  plot(cpuHistory, cssVar("--lime"), 2.4, true, true);
}

function loadLevel(pct) {
  if (pct >= 85) return ["Alto", "bad"];
  if (pct >= 65) return ["Moderado", "warn"];
  return ["Tranquilo", "ok"];
}

function setTile(id, pct) {
  document.getElementById(id).textContent = Math.round(pct);
  const [label, tone] = loadLevel(pct);
  const st = document.getElementById(`${id}-st`);
  st.textContent = label;
  st.className = `tile-status ${tone}`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

const HERO_SUB = {
  "Excelente": "Tudo rodando bem. Nenhum gargalo sério no momento.",
  "Bom": "O PC está bem, com alguns pontos para acompanhar.",
  "Atenção": "Alguns recursos estão no limite. Veja o diagnóstico ao lado.",
  "Crítico": "O sistema está sobrecarregado. Comece pelo diagnóstico ao lado."
};

const ALERT_ICONS = {
  critical: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
  warning: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  healthy: '<path d="M20 6L9 17l-5-5"/>'
};

// Real-time Metrics Polling
async function pollMetrics() {
  try {
    const res = await fetch("/api/metrics");
    if (!res.ok) return;
    const d = await res.json();

    // Admin status
    const adminBox = document.getElementById("admin-status-box");
    const adminText = document.getElementById("admin-status-text");
    const btnElevate = document.getElementById("btn-elevate");
    isAdmin = !!d.is_admin;
    applyAdminState();
    if (d.is_admin) {
      adminBox.className = "admin-badge is-admin";
      adminText.textContent = "Modo Administrador";
      btnElevate.style.display = "none";
    } else {
      adminBox.className = "admin-badge not-admin";
      adminText.textContent = "Modo Padrão";
      btnElevate.style.display = "inline-flex";
    }

    // Uptime
    document.getElementById("uptime-display").textContent = d.uptime.formatted;

    // Health Score
    document.getElementById("health-score-val").textContent = d.health_score;
    document.getElementById("health-score-lbl").textContent = d.health_label;
    document.getElementById("health-score-lbl").style.color = scoreColor(d.health_score);
    drawScoreRing(d.health_score);
    document.getElementById("hero-greet").textContent = greeting();
    document.getElementById("hero-sub").textContent = HERO_SUB[d.health_label] || "";

    // Alerts
    const alertsContainer = document.getElementById("health-alerts-list");
    alertsContainer.innerHTML = d.alerts.map(a => `
      <div class="alert-item ${escapeHtml(a.level)}">
        <span class="icon-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ALERT_ICONS[a.level] || ALERT_ICONS.info}</svg></span>
        <div>
          <strong>${escapeHtml(a.title)}</strong>
          <span>${escapeHtml(a.message)}</span>
        </div>
      </div>
    `).join("");

    // CPU
    const cpuPct = d.cpu.percent;
    document.getElementById("cpu-percent-val").textContent = `${cpuPct}%`;
    document.getElementById("cpu-freq-badge").textContent = d.cpu.freq_mhz ? `${d.cpu.freq_mhz} MHz` : "Ativo";
    document.getElementById("cpu-cores-detail").textContent = `${d.cpu.cores_physical} Núcleos / ${d.cpu.cores_logical} Threads`;
    const cpuBar = document.getElementById("cpu-bar");
    cpuBar.style.width = `${cpuPct}%`;
    cpuBar.className = `progress-fill ${cpuPct > 85 ? "danger" : cpuPct > 70 ? "warn" : ""}`;

    cpuHistory.push(cpuPct);
    if (cpuHistory.length > HISTORY_LEN) cpuHistory.shift();
    document.getElementById("strip-cpu-val").textContent = `${cpuPct}%`;

    // CPU per-core bars
    const coresGrid = document.getElementById("cpu-cores-grid");
    if (coresGrid && d.cpu.per_core) {
      coresGrid.innerHTML = d.cpu.per_core.map((c, i) => `
        <div class="core-bar ${c > 85 ? "hot" : ""}" title="Núcleo ${i}: ${c.toFixed(0)}%">
          <div class="core-track"><div class="core-fill" style="height:${Math.max(4, Math.min(100, c))}%"></div></div>
          <span>${i}</span>
        </div>
      `).join("");
    }

    // RAM
    const ramPct = d.ram.percent;
    document.getElementById("ram-percent-val").textContent = `${ramPct}%`;
    document.getElementById("ram-avail-badge").textContent = `${d.ram.available_gb} GB livres`;
    document.getElementById("ram-used-detail").textContent = `${d.ram.used_gb} GB / ${d.ram.total_gb} GB em uso`;
    const ramBar = document.getElementById("ram-bar");
    ramBar.style.width = `${ramPct}%`;
    ramBar.className = `progress-fill ${ramPct > 88 ? "danger" : ramPct > 75 ? "warn" : ""}`;

    ramHistory.push(ramPct);
    if (ramHistory.length > HISTORY_LEN) ramHistory.shift();
    document.getElementById("strip-ram-val").textContent = `${ramPct}%`;
    drawStrip();

    // Hero tiles + concentric rings (main disk = the system drive, or the first one listed)
    const mainDisk = (d.disks || []).find(dk => /^c:/i.test(dk.mountpoint)) || (d.disks || [])[0];
    const diskPct = mainDisk ? mainDisk.percent : 0;
    setTile("tile-cpu", cpuPct);
    setTile("tile-ram", ramPct);

    // Tile GPU
    if (d.gpu && d.gpu.load !== null && d.gpu.load !== undefined) {
      setTile("tile-gpu", d.gpu.load);
      const vramShort = (d.gpu.mem_used_mb && d.gpu.mem_total_mb)
        ? `${(d.gpu.mem_used_mb / 1024).toFixed(1)}/${(d.gpu.mem_total_mb / 1024).toFixed(0)} GB`
        : (d.gpu.vendor || "Ativa");
      const gpuSt = document.getElementById("tile-gpu-st");
      if (gpuSt) gpuSt.textContent = vramShort;
    } else {
      const gpuVal = document.getElementById("tile-gpu");
      if (gpuVal) gpuVal.textContent = "--";
      const gpuSt = document.getElementById("tile-gpu-st");
      if (gpuSt) {
        gpuSt.textContent = "Standby";
        gpuSt.className = "tile-status ok";
      }
    }

    // Tile Battery & Top Pill
    const bat = d.battery;
    const topPill = document.getElementById("battery-top-pill");
    const tileBat = document.getElementById("tile-bat");
    const tileBatUnit = document.getElementById("tile-bat-unit");
    const tileBatSt = document.getElementById("tile-bat-st");
    if (bat) {
      if (bat.is_laptop && bat.has_battery) {
        if (topPill) {
          topPill.style.display = "flex";
          const topLbl = document.getElementById("battery-top-label");
          if (topLbl) topLbl.textContent = bat.power_plugged ? "Carregando" : "Bateria";
          const topVal = document.getElementById("battery-top-val");
          if (topVal) topVal.textContent = `${bat.percent_remaining}%`;
        }
        if (tileBat) tileBat.textContent = bat.percent_remaining;
        if (tileBatUnit) tileBatUnit.textContent = "%";
        if (tileBatSt) {
          tileBatSt.textContent = bat.power_plugged ? "Tomada (AC)" : (bat.time_remaining_formatted || "Em uso");
          tileBatSt.className = `tile-status ${bat.percent_remaining < 20 ? 'bad' : bat.percent_remaining < 40 ? 'warn' : 'ok'}`;
        }
      } else {
        if (topPill) topPill.style.display = "none";
        if (tileBat) tileBat.textContent = "AC";
        if (tileBatUnit) tileBatUnit.textContent = "";
        if (tileBatSt) {
          tileBatSt.textContent = "Alimentação 100%";
          tileBatSt.className = "tile-status ok";
        }
      }
    }

    document.getElementById("ring-cpu").textContent = `${Math.round(cpuPct)}%`;
    document.getElementById("ring-ram").textContent = `${Math.round(ramPct)}%`;
    document.getElementById("ring-disk").textContent = `${Math.round(diskPct)}%`;
    drawRings(cpuPct, ramPct, diskPct);

    // Disk I/O
    const totalIo = (d.io.disk_read_mbps + d.io.disk_write_mbps).toFixed(1);
    document.getElementById("disk-io-val").textContent = `${totalIo} MB/s`;
    document.getElementById("disk-io-detail").textContent = `Leitura: ${d.io.disk_read_mbps} MB/s | Escrita: ${d.io.disk_write_mbps} MB/s`;

    // Mini disks in Disk I/O Card
    const miniDisks = document.getElementById("dashboard-disks-mini");
    if (miniDisks && d.disks) {
      miniDisks.innerHTML = d.disks.slice(0, 2).map(dk => `
        <div style="font-size:11.5px; margin-bottom:6px;">
          <div style="display:flex; justify-content:space-between;">
            <span>Disco ${escapeHtml(dk.mountpoint)}</span>
            <strong>${dk.free_gb} GB livres (${dk.percent}%)</strong>
          </div>
          <div class="progress-bar" style="height:5px; margin:4px 0;"><div class="progress-fill ${dk.percent > 88 ? 'danger' : dk.percent > 78 ? 'warn' : ''}" style="width:${dk.percent}%"></div></div>
        </div>
      `).join("");
    }

    // Full disks list on Dashboard
    const fullDisks = document.getElementById("disks-full-list");
    if (fullDisks && d.disks) {
      fullDisks.innerHTML = d.disks.map(dk => `
        <div class="disk-item">
          <div class="disk-item-top">
            <span>Unidade (${escapeHtml(dk.mountpoint)}) — ${escapeHtml(dk.fstype)}</span>
            <span>${dk.percent}% ocupado</span>
          </div>
          <div class="progress-bar"><div class="progress-fill ${dk.percent > 88 ? 'danger' : dk.percent > 78 ? 'warn' : ''}" style="width:${dk.percent}%"></div></div>
          <div class="disk-item-sub">
            <span>Em uso: ${dk.used_gb} GB de ${dk.total_gb} GB</span>
            <strong style="color:var(--accent-emerald);">${dk.free_gb} GB disponíveis</strong>
          </div>
        </div>
      `).join("");
    }

    // Network speeds
    const downKbps = d.io.net_down_kbps;
    const upKbps = d.io.net_up_kbps;
    const downFmt = downKbps >= 1024 ? `${(downKbps / 1024).toFixed(1)} MB/s` : `${downKbps.toFixed(0)} KB/s`;
    const upFmt = upKbps >= 1024 ? `${(upKbps / 1024).toFixed(1)} MB/s` : `${upKbps.toFixed(0)} KB/s`;
    const netDetail = document.getElementById("net-io-detail");
    if (netDetail) netDetail.textContent = `${downFmt} ↓ | ${upFmt} ↑`;

    // GPU live metrics
    if (d.gpu && d.gpu.load !== null && d.gpu.load !== undefined) {
      const gpuPct = Math.round(d.gpu.load);
      const gpuLoadEl = document.getElementById("gpu-dash-load");
      if (gpuLoadEl) gpuLoadEl.textContent = `${gpuPct}%`;
      const gpuNameEl = document.getElementById("gpu-dash-name");
      if (gpuNameEl) gpuNameEl.textContent = d.gpu.name || "Placa de Vídeo";
      const gpuBadge = document.getElementById("gpu-vendor-badge");
      if (gpuBadge) {
        gpuBadge.textContent = d.gpu.vendor || "GPU";
        gpuBadge.className = "badge badge-cyan";
      }
      const gpuBar = document.getElementById("gpu-bar");
      if (gpuBar) {
        gpuBar.style.width = `${Math.min(100, Math.max(0, gpuPct))}%`;
        gpuBar.className = `progress-fill ${gpuPct > 85 ? "danger" : gpuPct > 70 ? "warn" : ""}`;
      }
      const vramEl = document.getElementById("gpu-dash-vram");
      if (vramEl) {
        if (d.gpu.mem_used_mb && d.gpu.mem_total_mb) {
          const usedGb = (d.gpu.mem_used_mb / 1024).toFixed(1);
          const totalGb = (d.gpu.mem_total_mb / 1024).toFixed(1);
          const vramPct = Math.round((d.gpu.mem_used_mb / d.gpu.mem_total_mb) * 100);
          vramEl.textContent = `${usedGb} GB / ${totalGb} GB (${vramPct}%)`;
        } else if (d.gpu.mem_used_mb) {
          vramEl.textContent = `${(d.gpu.mem_used_mb / 1024).toFixed(1)} GB Dedicada`;
        } else {
          vramEl.textContent = "Dinâmica / WDDM";
        }
      }
      const tempEl = document.getElementById("gpu-dash-temp");
      if (tempEl) {
        if (d.gpu.temp !== null && d.gpu.temp !== undefined) {
          tempEl.textContent = `${d.gpu.temp}°C`;
        } else if (d.cpu && d.cpu.temp !== null && d.cpu.temp !== undefined) {
          tempEl.textContent = `CPU: ${d.cpu.temp}°C`;
        } else {
          tempEl.textContent = "Normal (Estável)";
        }
      }
    } else if (hardwareSpecsData && hardwareSpecsData.gpus && hardwareSpecsData.gpus.length > 0) {
      const g0 = hardwareSpecsData.gpus[0];
      const gpuLoadEl = document.getElementById("gpu-dash-load");
      if (gpuLoadEl) gpuLoadEl.textContent = "Ativa";
      const gpuNameEl = document.getElementById("gpu-dash-name");
      if (gpuNameEl) gpuNameEl.textContent = g0.Name || "Placa de Vídeo";
      const vramEl = document.getElementById("gpu-dash-vram");
      if (vramEl) vramEl.textContent = g0.AdapterRAM_GB ? `${g0.AdapterRAM_GB} GB Total` : "WDDM Integrada";
      const tempEl = document.getElementById("gpu-dash-temp");
      if (tempEl) tempEl.textContent = "Operacional";
    }
  } catch (err) {
    // Ignore transient polling errors
  }
}

// Elevate to Admin
async function elevateToAdmin() {
  try {
    const res = await fetch("/api/elevate", { method: "POST" });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");
  } catch (e) {
    showToast("Erro ao solicitar permissão de Administrador.", "error");
  }
}

// 1-Click Super Boost
async function runQuickBoost() {
  const btn = document.getElementById("btn-top-quick-boost");
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> <span>Otimizando PC...</span>`;

  try {
    const res = await fetch("/api/quick-boost", { method: "POST" });
    const data = await res.json();
    const ramMb = data.ram.freed_mb;
    const diskFreed = data.cleaner.formatted_freed;
    const filesRem = data.cleaner.files_removed;

    const kept = data.cleaner.skipped_in_use > 0 ? ` ${fmtInt(data.cleaner.skipped_in_use)} arquivos em uso foram mantidos.` : "";
    showToast(
      `Super Boost concluído: ${ramMb} MB de RAM liberados, ${diskFreed} de lixo removidos (${filesRem} arquivos) e cache DNS limpo.${kept}`,
      "success"
    );
    await loadHistoryStats();
    await pollMetrics();
  } catch (e) {
    showToast("Ocorreu um erro ao executar a Otimização Rápida.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// ================= BACKGROUND SCANS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtInt = (n) => (n || 0).toLocaleString("pt-BR");

// Starts a background scan on the server and mirrors its progress into a .job-progress panel.
// Resolves with the scan result, or null if the user cancelled it.
async function runScanJob(startUrl, body, panelId, describe) {
  const panel = document.getElementById(panelId);
  const cancelBtn = panel.querySelector(".job-cancel");
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancelar";

  const res = await fetch(startUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`Falha ao iniciar a varredura (HTTP ${res.status}).`);
  let job = await res.json();

  panel.dataset.jobId = job.job_id;
  panel.hidden = false;
  try {
    while (job.status === "running") {
      renderJobProgress(panel, job, describe);
      await sleep(400);
      const poll = await fetch(`/api/jobs/${job.job_id}`);
      if (!poll.ok) throw new Error("A varredura foi perdida pelo servidor.");
      job = await poll.json();
    }
  } finally {
    panel.hidden = true;
    delete panel.dataset.jobId;
  }
  if (job.status === "cancelled") return null;
  if (job.status === "error") throw new Error(job.error || "Erro desconhecido na varredura.");
  return job.result;
}

function renderJobProgress(panel, job, describe) {
  const p = job.progress || {};
  const determinate = p.total > 0;
  panel.querySelector(".job-label").textContent = p.label || "Preparando";
  panel.querySelector(".job-count").textContent = describe(p);
  panel.querySelector(".job-path").textContent = p.current || "";
  panel.classList.toggle("indeterminate", !determinate);
  panel.querySelector(".job-fill").style.width = determinate ? `${Math.min(100, (p.done / p.total) * 100)}%` : "";
}

async function cancelJob(panelId) {
  const panel = document.getElementById(panelId);
  const jobId = panel.dataset.jobId;
  if (!jobId) return;
  const btn = panel.querySelector(".job-cancel");
  btn.disabled = true;
  btn.textContent = "Cancelando";
  try {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  } catch (e) {}
}

// ================= ADMIN AWARENESS =================
function applyAdminState() {
  document.querySelectorAll("[data-requires-admin]").forEach(el => {
    el.disabled = isAdmin === false;
    el.title = isAdmin === false ? "Requer modo administrador" : "";
  });
  document.querySelectorAll(".admin-only-note").forEach(el => {
    el.hidden = isAdmin !== false;
  });
}

// ================= CONFIRMATION DIALOG =================
let modalResolve = null;
let modalReturnFocus = null;

// Opens the in-app confirmation dialog. Resolves true when the user confirms.
// items: [{ name, detail }] shown as a list (first 6, then a count of the rest).
function confirmDialog({ title, message = "", items = [], total = "", note = "", confirmLabel = "Confirmar", tone = "primary" }) {
  if (modalResolve) closeModal(false);
  const root = document.getElementById("modal-backdrop");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-message").textContent = message;

  const list = document.getElementById("modal-list");
  const shown = items.slice(0, 6);
  list.innerHTML = shown.map(it => `
    <li><span class="modal-item-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span><span class="modal-item-detail">${escapeHtml(it.detail || "")}</span></li>
  `).join("") + (items.length > shown.length ? `<li class="modal-more">e mais ${fmtInt(items.length - shown.length)}</li>` : "");
  list.hidden = items.length === 0;

  const totalEl = document.getElementById("modal-total");
  totalEl.textContent = total;
  totalEl.hidden = !total;

  const noteEl = document.getElementById("modal-note");
  noteEl.textContent = note;
  noteEl.hidden = !note;
  noteEl.classList.toggle("danger", tone === "danger");

  const confirmBtn = document.getElementById("modal-confirm");
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = `btn ${tone === "danger" ? "btn-danger-solid" : "btn-primary"}`;

  modalReturnFocus = document.activeElement;
  root.hidden = false;
  // For destructive actions the safe choice gets focus, so Enter doesn't delete by accident.
  (tone === "danger" ? document.getElementById("modal-cancel") : confirmBtn).focus();
  return new Promise(resolve => { modalResolve = resolve; });
}

function closeModal(result) {
  document.getElementById("modal-backdrop").hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  if (resolve) resolve(result);
}

document.getElementById("modal-cancel").addEventListener("click", () => closeModal(false));
document.getElementById("modal-confirm").addEventListener("click", () => closeModal(true));
document.getElementById("modal-backdrop").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal-backdrop") closeModal(false);
});
document.addEventListener("keydown", (e) => {
  if (!modalResolve) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal(false);
  } else if (e.key === "Tab") {
    // Keep focus inside the dialog
    const a = document.getElementById("modal-cancel");
    const b = document.getElementById("modal-confirm");
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
    else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    else if (document.activeElement !== a && document.activeElement !== b) { e.preventDefault(); a.focus(); }
  }
});

// ================= CLEANER MODULE =================
const JUNK_PLACEHOLDER = `<div class="card" style="text-align:center; padding:40px; color:var(--text-secondary);">
  Clique em <strong>Analisar Arquivos Inúteis</strong> para ver quanto espaço pode ser recuperado com segurança.
</div>`;

async function scanJunkFiles(opts = {}) {
  const btnScan = document.getElementById("btn-scan-junk");
  const btnClean = document.getElementById("btn-clean-junk");
  const container = document.getElementById("cleaner-categories-container");

  if (!opts.keepResult) document.getElementById("cleaner-result").hidden = true;
  btnScan.disabled = true;
  btnClean.disabled = true;
  container.innerHTML = "";

  try {
    const data = await runScanJob("/api/jobs/cleaner-scan", {}, "junk-progress",
      p => p.total ? `Etapa ${Math.min(p.done + 1, p.total)} de ${p.total}, ${fmtInt(p.scanned)} arquivos contados` : "");
    if (!data) {
      container.innerHTML = JUNK_PLACEHOLDER;
      showToast("Análise cancelada.", "info");
      return;
    }
    lastJunkScan = data;
    renderJunkScan(data);
  } catch (e) {
    container.innerHTML = JUNK_PLACEHOLDER;
    showToast(`Erro ao analisar arquivos inúteis: ${e.message}`, "error");
  } finally {
    btnScan.disabled = false;
  }
}

function renderJunkScan(data) {
  const container = document.getElementById("cleaner-categories-container");
  const blocked = data.categories.filter(c => c.blocked);

  document.getElementById("cleaner-summary-title").textContent =
    `Encontrados ${data.total_formatted} em ${fmtInt(data.total_files)} arquivos inúteis`;
  document.getElementById("cleaner-summary-sub").textContent =
    `Revise as categorias abaixo e clique em "Limpar Selecionados" para recuperar espaço.`;

  const note = document.getElementById("cleaner-admin-note");
  if (blocked.length) {
    note.innerHTML = `
      <span>${blocked.length === 1 ? "1 categoria precisa" : `${blocked.length} categorias precisam`} do modo administrador e ${blocked.length === 1 ? "ficou bloqueada" : "ficaram bloqueadas"}: ${escapeHtml(blocked.map(c => c.name.replace(/\s*\(.*\)$/, "")).join(", "))}.</span>
      <button class="btn btn-sm btn-secondary" onclick="elevateToAdmin()">Reabrir como administrador</button>`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  container.innerHTML = data.categories.map(cat => `
    <div class="category-row ${cat.blocked ? "is-blocked" : ""}">
      <div class="category-left">
        <input type="checkbox" class="junk-cat-check" value="${escapeHtml(cat.id)}" ${cat.default_checked && !cat.blocked ? "checked" : ""} ${cat.blocked ? "disabled" : ""} onchange="updateCleanButton()" />
        <div>
          <div class="category-title">
            ${escapeHtml(cat.name)}
            ${cat.blocked
              ? `<span class="badge badge-amber" style="margin-left:6px;">Requer administrador</span>`
              : `<span class="badge badge-green" style="margin-left:6px;">Seguro</span>`}
          </div>
          <div class="category-desc">${escapeHtml(cat.description)}</div>
          ${cat.samples && cat.samples.length ? `<div class="category-samples">Ex: ${escapeHtml(cat.samples.slice(0, 2).join(" | "))}</div>` : ""}
        </div>
      </div>
      <div class="category-right">
        <div style="font-size:16px; font-weight:700; color:${cat.size_bytes > 0 && !cat.blocked ? 'var(--cobalt)' : 'var(--text-muted)'};">
          ${cat.blocked && cat.size_bytes === 0 ? "--" : escapeHtml(cat.size_formatted)}
        </div>
        <div style="font-size:12px; color:var(--text-secondary);">
          ${cat.blocked && cat.file_count === 0 ? "sem acesso" : `${fmtInt(cat.file_count)} itens`}
        </div>
      </div>
    </div>
  `).join("");
  updateCleanButton();
}

function updateCleanButton() {
  document.getElementById("btn-clean-junk").disabled =
    document.querySelectorAll(".junk-cat-check:checked").length === 0;
}

async function cleanSelectedJunk() {
  const checked = Array.from(document.querySelectorAll(".junk-cat-check:checked")).map(el => el.value);
  if (!checked.length) {
    showToast("Selecione pelo menos uma categoria para limpar.", "error");
    return;
  }
  const cats = (lastJunkScan?.categories || []).filter(c => checked.includes(c.id));
  const totalBytes = cats.reduce((s, c) => s + c.size_bytes, 0);
  const ok = await confirmDialog({
    title: "Limpar arquivos inúteis?",
    message: cats.length === 1 ? "Esta categoria será limpa:" : `Estas ${cats.length} categorias serão limpas:`,
    items: cats.map(c => ({ name: c.name, detail: c.size_formatted })),
    total: `Até ${formatBytesJs(totalBytes)} serão liberados`,
    note: checked.includes("recycle_bin")
      ? "Esvaziar a Lixeira é permanente. Arquivos em uso por outros programas são mantidos."
      : "Arquivos em uso por outros programas são mantidos automaticamente.",
    confirmLabel: "Limpar agora"
  });
  if (!ok) return;

  const btnClean = document.getElementById("btn-clean-junk");
  btnClean.disabled = true;
  btnClean.innerHTML = `<span class="spinner"></span> <span>Limpando...</span>`;

  try {
    const res = await fetch("/api/cleaner/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories: checked })
    });
    const data = await res.json();
    renderCleanResult(data);
    showToast(`Limpeza concluída: ${data.formatted_freed} liberados.`, "success");
    btnClean.innerHTML = `<span>Limpar Selecionados</span>`;
    await loadHistoryStats();
    await scanJunkFiles({ keepResult: true });
  } catch (e) {
    showToast("Erro durante a limpeza de arquivos.", "error");
  } finally {
    btnClean.innerHTML = `<span>Limpar Selecionados</span>`;
    updateCleanButton();
  }
}

function renderCleanResult(data) {
  const el = document.getElementById("cleaner-result");
  const rows = data.categories.map(c => {
    let status = "";
    if (c.skipped_no_admin) status = `<span class="badge badge-amber">Pulada: requer administrador</span>`;
    else if (c.skipped_in_use > 0) status = `<span class="result-muted">${fmtInt(c.skipped_in_use)} em uso, mantidos</span>`;
    return `<li><span class="result-name">${escapeHtml(c.name)}</span><span class="result-right">${status}<strong>${escapeHtml(c.formatted_freed)}</strong></span></li>`;
  }).join("");
  const kept = data.skipped_in_use > 0
    ? ` ${fmtInt(data.skipped_in_use)} arquivos estavam em uso por outros programas e foram mantidos.`
    : "";
  el.innerHTML = `
    <div class="result-head">
      <div>
        <div class="result-big">${escapeHtml(data.formatted_freed)}</div>
        <div class="result-sub">liberados, ${fmtInt(data.files_removed)} arquivos removidos.${kept}</div>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="document.getElementById('cleaner-result').hidden = true">Fechar</button>
    </div>
    <ul class="result-list">${rows}</ul>`;
  el.hidden = false;
}

function formatBytesJs(b) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return i === 0 ? `${Math.round(b)} B` : `${b.toFixed(1)} ${units[i]}`;
}
const formatBytes = formatBytesJs;

// ================= LARGE FILES SCANNER =================
async function loadScannerPresets() {
  try {
    const res = await fetch("/api/scanner/presets");
    const data = await res.json();
    const sel = document.getElementById("lf-preset-select");
    if (data.presets && data.presets.length) {
      sel.innerHTML = data.presets.map(p => `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)}</option>`).join("");
      document.getElementById("lf-custom-path").value = data.presets[0].path;
    }
  } catch (e) {}
}

function onPresetChange() {
  const val = document.getElementById("lf-preset-select").value;
  if (val) {
    document.getElementById("lf-custom-path").value = val;
  }
}

const lfEmptyRow = (text) => `<tr><td colspan="7" style="text-align:center; padding:34px; color:var(--text-secondary);">${text}</td></tr>`;

async function scanLargeFiles() {
  const targetPath = document.getElementById("lf-custom-path").value.trim();
  const minSizeMb = parseInt(document.getElementById("lf-min-size").value, 10) || 100;
  const catFilter = document.getElementById("lf-category").value;
  const btn = document.getElementById("btn-scan-large");
  const tbody = document.getElementById("lf-table-body");

  btn.disabled = true;
  document.getElementById("lf-summary-grid").style.display = "none";
  document.getElementById("lf-check-all").checked = false;
  tbody.innerHTML = lfEmptyRow(`Procurando arquivos maiores que ${minSizeMb} MB...`);

  try {
    const data = await runScanJob("/api/jobs/large-files",
      { target_path: targetPath || null, min_size_mb: minSizeMb, category_filter: catFilter },
      "lf-progress",
      p => `${fmtInt(p.scanned)} arquivos analisados, ${fmtInt(p.found)} grandes encontrados`);
    if (!data) {
      lastLargeFiles = [];
      tbody.innerHTML = lfEmptyRow("Busca cancelada. Ajuste o local ou o tamanho mínimo e busque de novo.");
      showToast("Busca cancelada.", "info");
      return;
    }
    renderLargeFiles(data, minSizeMb);
  } catch (e) {
    tbody.innerHTML = lfEmptyRow("Não foi possível concluir a busca.");
    showToast(`Erro ao escanear arquivos grandes: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function renderLargeFiles(data, minSizeMb) {
  const tbody = document.getElementById("lf-table-body");
  lastLargeFiles = data.files || [];

  document.getElementById("lf-summary-grid").style.display = "grid";
  document.getElementById("lf-total-badge").textContent =
    `${fmtInt(data.total_matching_count)} arquivos (${data.total_large_formatted})`;

  const catBars = document.getElementById("lf-categories-bars");
  if (data.categories && data.categories.length) {
    catBars.innerHTML = data.categories.map(c => `
      <div style="margin-bottom:9px;">
        <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:3px;">
          <span>${escapeHtml(c.category)} (${c.count})</span>
          <strong>${escapeHtml(c.size_formatted)} (${c.percent}%)</strong>
        </div>
        <div class="progress-bar" style="height:6px; margin:0;"><div class="progress-fill" style="width:${c.percent}%"></div></div>
      </div>
    `).join("");
  } else {
    catBars.innerHTML = `<div style="font-size:12.5px; color:var(--text-secondary);">Nenhum arquivo encontrado com esses filtros.</div>`;
  }

  const topFoldersEl = document.getElementById("lf-top-folders");
  if (data.top_folders && data.top_folders.length) {
    topFoldersEl.innerHTML = data.top_folders.slice(0, 5).map(f => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); font-size:12px;">
        <span class="path-cell" style="max-width:340px;" title="${escapeHtml(f.folder)}">${escapeHtml(f.folder)}</span>
        <div style="display:flex; align-items:center; gap:8px;">
          <strong style="color:var(--accent-cyan);">${escapeHtml(f.size_formatted)}</strong>
          <button class="btn btn-sm btn-secondary" style="padding:3px 7px;" onclick="openPathInExplorer(${JSON.stringify(f.folder).replace(/"/g, '&quot;')})">Abrir</button>
        </div>
      </div>
    `).join("");
  } else {
    topFoldersEl.innerHTML = `<div style="font-size:12.5px; color:var(--text-secondary);">Sem pastas acumuladas.</div>`;
  }

  if (!lastLargeFiles.length) {
    tbody.innerHTML = lfEmptyRow(`Nenhum arquivo maior que ${minSizeMb} MB encontrado neste local.`);
    return;
  }
  tbody.innerHTML = lastLargeFiles.map((f, idx) => `
    <tr>
      <td>
        <input type="checkbox" class="lf-row-check" data-idx="${idx}" ${f.protected ? "disabled" : ""} />
      </td>
      <td>
        <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(f.name)}</div>
        ${f.protected ? `<span class="badge badge-amber" title="${escapeHtml(f.protection_reason)}">Protegido pelo Sistema</span>` : ""}
      </td>
      <td><span class="badge badge-cyan">${escapeHtml(f.category)}</span></td>
      <td style="font-weight:700; color:var(--cobalt);">${escapeHtml(f.size_formatted)}</td>
      <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(f.modified)}</td>
      <td><div class="path-cell" title="${escapeHtml(f.path)}">${escapeHtml(f.folder)}</div></td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="btn btn-sm btn-secondary" onclick="openFileByIdx(${idx})">Pasta</button>
        ${!f.protected ? `<button class="btn btn-sm btn-danger" onclick="trashFileByIdx(${idx})">Lixeira</button>` : ""}
      </td>
    </tr>
  `).join("");
}

function toggleAllLargeFiles(checked) {
  document.querySelectorAll(".lf-row-check:not(:disabled)").forEach(cb => {
    cb.checked = checked;
  });
}

async function openPathInExplorer(pathStr) {
  await fetch("/api/scanner/open-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: pathStr })
  });
}

function openFileByIdx(idx) {
  const f = lastLargeFiles[idx];
  if (f) openPathInExplorer(f.path);
}

function trashConfirmOptions(files, permanent) {
  const totalBytes = files.reduce((s, f) => s + (f.size_bytes || 0), 0);
  const n = files.length;
  const items = files.map(f => ({ name: f.name, detail: f.size_formatted }));
  if (permanent) {
    return {
      title: n === 1 ? "Excluir permanentemente?" : `Excluir ${n} arquivos permanentemente?`,
      message: "Os arquivos abaixo serão apagados do disco:",
      items,
      total: `${formatBytesJs(totalBytes)} no total`,
      note: "Eles não passam pela Lixeira e não podem ser recuperados.",
      confirmLabel: n === 1 ? "Excluir arquivo" : `Excluir ${n} arquivos`,
      tone: "danger"
    };
  }
  return {
    title: n === 1 ? "Mover para a Lixeira?" : `Mover ${n} arquivos para a Lixeira?`,
    message: "Os arquivos abaixo vão para a Lixeira do Windows:",
    items,
    total: `${formatBytesJs(totalBytes)} no total`,
    note: "Você pode restaurá-los pela Lixeira enquanto ela não for esvaziada.",
    confirmLabel: "Mover para a Lixeira"
  };
}

async function trashFileByIdx(idx) {
  const f = lastLargeFiles[idx];
  if (!f) return;
  if (!(await confirmDialog(trashConfirmOptions([f], false)))) return;
  await removeFilesApi([f.path], false);
  await scanLargeFiles();
}

async function removeSelectedLargeFiles(permanent) {
  const files = Array.from(document.querySelectorAll(".lf-row-check:checked"))
    .map(cb => lastLargeFiles[Number(cb.getAttribute("data-idx"))])
    .filter(Boolean);
  if (!files.length) {
    showToast("Selecione pelo menos um arquivo na tabela primeiro.", "error");
    return;
  }
  if (!(await confirmDialog(trashConfirmOptions(files, permanent)))) return;

  await removeFilesApi(files.map(f => f.path), permanent);
  await scanLargeFiles();
}

async function removeFilesApi(paths, permanent) {
  try {
    const res = await fetch("/api/scanner/remove-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, permanent })
    });
    const data = await res.json();
    if (data.removed_count > 0) {
      const verb = permanent ? "excluído(s)" : "movido(s) para a Lixeira";
      showToast(`${data.removed_count} arquivo(s) ${verb}, ${data.formatted_freed} liberados.`, "success");
      await loadHistoryStats();
    }
    if (data.errors && data.errors.length) {
      showToast(data.errors[0], "error");
    }
  } catch (e) {
    showToast("Erro ao remover arquivos.", "error");
  }
}

// ================= DUPLICATES SCANNER =================
const DUP_PLACEHOLDER = `<div class="card" style="text-align:center; padding:40px; color:var(--text-secondary);">
  Clique em <strong>Buscar Duplicados</strong> para localizar arquivos idênticos ocupando espaço em dobro.
</div>`;

async function scanDuplicates() {
  const targetPath = document.getElementById("dup-custom-path").value.trim();
  const minKb = parseInt(document.getElementById("dup-min-kb").value, 10) || 100;
  const btn = document.getElementById("btn-scan-dup");
  const container = document.getElementById("dup-groups-container");

  btn.disabled = true;
  document.getElementById("btn-select-dup-copies").disabled = true;
  document.getElementById("btn-trash-dups").disabled = true;
  document.getElementById("dup-summary-bar").style.display = "none";
  container.innerHTML = "";

  try {
    const data = await runScanJob("/api/jobs/duplicates",
      { target_path: targetPath || null, min_size_kb: minKb },
      "dup-progress",
      p => p.total ? `${fmtInt(p.done)} de ${fmtInt(p.total)} arquivos` : `${fmtInt(p.scanned)} arquivos listados`);
    if (!data) {
      lastDupGroups = [];
      container.innerHTML = DUP_PLACEHOLDER;
      showToast("Busca cancelada.", "info");
      return;
    }
    renderDuplicates(data);
  } catch (e) {
    container.innerHTML = DUP_PLACEHOLDER;
    showToast(`Erro ao procurar arquivos duplicados: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function renderDuplicates(data) {
  const container = document.getElementById("dup-groups-container");
  lastDupGroups = data.groups || [];

  document.getElementById("dup-summary-bar").style.display = "block";
  document.getElementById("dup-summary-text").textContent =
    `${data.groups_count} grupos de arquivos idênticos encontrados (${data.total_extra_copies} cópias extras)`;
  document.getElementById("dup-wasted-badge").textContent =
    `${data.total_wasted_formatted} desperdiçados`;

  const hasDups = lastDupGroups.length > 0;
  document.getElementById("btn-select-dup-copies").disabled = !hasDups;
  document.getElementById("btn-trash-dups").disabled = !hasDups;

  if (!hasDups) {
    container.innerHTML = `<div class="card" style="text-align:center; padding:40px; color:var(--accent-emerald);">Nenhum arquivo duplicado encontrado nas pastas analisadas.</div>`;
    return;
  }

  container.innerHTML = lastDupGroups.map((g, gi) => `
    <div class="card" style="padding:14px 18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div>
          <strong style="font-size:14px;">${escapeHtml(g.name)}</strong>
          <span class="badge badge-cyan" style="margin-left:8px;">${g.count} cópias (${escapeHtml(g.size_formatted)} cada)</span>
        </div>
        <span class="badge badge-amber">Recuperável: ${escapeHtml(g.wasted_formatted)}</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${g.files.map((f, fi) => `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:7px 10px; background:var(--paper); border-radius:6px; font-size:12.5px;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <input type="checkbox" class="dup-file-check" data-group="${gi}" data-file="${fi}" data-original="${f.is_original ? '1' : '0'}" ${!f.is_original ? 'checked' : ''} />
              ${f.is_original ? `<span class="badge badge-green">Original</span>` : `<span class="badge badge-red">Cópia Extra</span>`}
              <span class="path-cell" style="max-width:none;" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
              <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(f.modified)}</span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;" onclick="openPathInExplorer(${JSON.stringify(f.path).replace(/"/g, '&quot;')})">Pasta</button>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function autoSelectDuplicateCopies() {
  document.querySelectorAll(".dup-file-check").forEach(cb => {
    cb.checked = cb.getAttribute("data-original") === "0";
  });
  showToast("Todas as cópias extras foram selecionadas (mantendo 1 original de cada arquivo).", "info");
}

async function trashSelectedDuplicates() {
  const files = Array.from(document.querySelectorAll(".dup-file-check:checked")).map(cb => {
    const g = lastDupGroups[Number(cb.getAttribute("data-group"))];
    const f = g && g.files[Number(cb.getAttribute("data-file"))];
    return f ? { name: f.path, path: f.path, size_bytes: g.size_bytes, size_formatted: g.size_formatted, is_original: f.is_original } : null;
  }).filter(Boolean);
  if (!files.length) {
    showToast("Nenhuma cópia duplicada selecionada.", "error");
    return;
  }
  const opts = trashConfirmOptions(files, false);
  const originals = files.filter(f => f.is_original).length;
  if (originals) {
    opts.note = `${originals === 1 ? "1 arquivo marcado é o original" : `${originals} arquivos marcados são originais`} do grupo. ${opts.note}`;
  }
  if (!(await confirmDialog(opts))) return;
  await removeFilesApi(files.map(f => f.path), false);
  await scanDuplicates();
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

// ================= OPTIMIZER & TURBO MODULE =================
async function optimizeRamNow() {
  const btn = document.getElementById("btn-opt-ram");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/optimizer/ram", { method: "POST" });
    const data = await res.json();
    const resEl = document.getElementById("opt-ram-result");
    if (resEl) {
      resEl.textContent = `${data.freed_formatted} recuperados (${data.percent_before}% → ${data.percent_after}%) em ${data.trimmed_processes} processos!`;
    }
    showToast(`Memória RAM otimizada! ${data.freed_formatted} liberados (${data.percent_before}% → ${data.percent_after}%).`, "success");
    await pollMetrics();
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao otimizar Memória RAM.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function purgeStandbyNow() {
  const btn = document.getElementById("btn-opt-standby");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/optimizer/standby", { method: "POST" });
    const data = await res.json();
    const resEl = document.getElementById("opt-ram-result");
    if (resEl) {
      const kernelMsg = data.purged_kernel_standby ? " (Standby Kernel limpa)" : "";
      resEl.textContent = `${data.freed_formatted} recuperados${kernelMsg} (${data.percent_before}% → ${data.percent_after}%)!`;
    }
    showToast(`Standby List & RAM Real limpas! ${data.freed_formatted} liberados (${data.percent_before}% → ${data.percent_after}%).`, "success");
    await pollMetrics();
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao limpar Standby List.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================= GAME BOOSTER MODULE =================
async function pollGameBoosterStatus() {
  try {
    const res = await fetch("/api/game-booster/status");
    const data = await res.json();

    const badge = document.getElementById("booster-status-badge");
    const details = document.getElementById("booster-active-details");
    const toggle = document.getElementById("toggle-game-booster");

    if (toggle && toggle.checked !== data.enabled) {
      toggle.checked = data.enabled;
    }

    if (data.active_game) {
      if (badge) {
        badge.textContent = `🎮 ${data.active_game.name} (Turbo Ativo)`;
        badge.className = "badge badge-green";
      }
      if (details) {
        details.textContent = `🔥 Prioridade Alta ativa | Standby limpa | ${data.throttled_apps_count || 0} apps desacelerados`;
        details.style.color = "var(--accent-emerald)";
      }
    } else if (data.enabled) {
      if (badge) {
        badge.textContent = "Detector Ativo";
        badge.className = "badge badge-amber";
      }
      if (details) {
        details.textContent = data.last_session 
          ? `Último jogo: ${data.last_session.name} (fechado às ${data.last_session.ended_at})`
          : "Monitorando processos em segundo plano...";
        details.style.color = "var(--text-secondary)";
      }
    } else {
      if (badge) {
        badge.textContent = "Desativado";
        badge.className = "badge badge-cyan";
      }
      if (details) {
        details.textContent = "Detector automático pausado.";
        details.style.color = "var(--text-secondary)";
      }
    }
  } catch (e) {}
}

async function toggleGameBooster(enabled) {
  try {
    const res = await fetch("/api/game-booster/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    showToast(enabled ? "Detector automático de jogos ativado!" : "Detector automático de jogos desativado.", "info");
    await pollGameBoosterStatus();
  } catch (e) {
    showToast("Erro ao alterar modo do Game Booster.", "error");
  }
}

async function openBoostProcessModal() {
  const modal = document.getElementById("boost-modal-backdrop");
  const list = document.getElementById("boost-candidates-list");
  if (!modal || !list) return;

  list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12.5px;">Buscando processos em execução...</div>`;
  modal.hidden = false;

  try {
    const res = await fetch("/api/game-booster/running-candidates");
    const data = await res.json();
    const candidates = data.candidates || [];

    if (candidates.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12.5px;">Nenhum jogo ou app pesado detectado no momento.</div>`;
      return;
    }

    list.innerHTML = candidates.map(c => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:10px;">
        <div style="min-width:0; overflow:hidden;">
          <div style="font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px;">
            ${escapeHtml(c.name)}
            ${c.is_known_game ? `<span class="badge badge-green" style="font-size:10px;">Jogo</span>` : `<span class="badge badge-cyan" style="font-size:10px;">App</span>`}
          </div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
            ${escapeHtml(c.exe_name)} (PID: ${c.pid}) • RAM: ${c.ram_mb} MB
          </div>
        </div>
        <button class="btn btn-purple" style="padding:6px 14px; font-size:12px; font-weight:600;" onclick="boostProcessNow(${c.pid}, '${escapeHtml(c.name)}')">
          Otimizar Agora
        </button>
      </div>
    `).join("");
  } catch (e) {
    list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12.5px;">Erro ao carregar processos.</div>`;
  }
}

function closeBoostProcessModal() {
  const modal = document.getElementById("boost-modal-backdrop");
  if (modal) modal.hidden = true;
}

async function boostProcessNow(pid, title) {
  closeBoostProcessModal();
  try {
    const res = await fetch("/api/game-booster/boost-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, title })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Modo Turbo ativado com sucesso para '${title}'!`, "success");
      await pollGameBoosterStatus();
      await pollMetrics();
      await loadHistoryStats();
    } else {
      showToast(`Não foi possível otimizar: ${data.error || 'Erro'}`, "error");
    }
  } catch (e) {
    showToast("Erro ao otimizar processo.", "error");
  }
}

// ================= BENCHMARK MODULE (PulseScore 10s) =================
let benchmarkPollTimer = null;

async function loadBenchmarkData() {
  try {
    const res = await fetch("/api/benchmark/history");
    const data = await res.json();
    if (data.latest) {
      renderBenchmarkResults(data.latest, data.gain);
    }
  } catch (e) {}
}

function renderBenchmarkResults(result, gain) {
  if (!result) return;
  const scoreEl = document.getElementById("bench-main-score");
  const gainEl = document.getElementById("bench-gain-badge");
  const timeEl = document.getElementById("bench-timestamp");

  const cpuScoreEl = document.getElementById("bench-cpu-score");
  const cpuSubEl = document.getElementById("bench-cpu-sub");

  const ramScoreEl = document.getElementById("bench-ram-score");
  const ramSubEl = document.getElementById("bench-ram-sub");

  const diskScoreEl = document.getElementById("bench-disk-score");
  const diskSubEl = document.getElementById("bench-disk-sub");

  if (scoreEl) scoreEl.textContent = result.pulse_score ? result.pulse_score.toLocaleString("pt-BR") : "--";
  if (timeEl && result.timestamp) timeEl.textContent = `Último teste: ${result.timestamp}`;

  if (cpuScoreEl) cpuScoreEl.textContent = `${(result.cpu_score || 0).toLocaleString("pt-BR")} pts`;
  if (cpuSubEl) cpuSubEl.textContent = `${((result.cpu_ops_sec || 0) / 1000000).toFixed(1)}M ops/seg`;

  if (ramScoreEl) ramScoreEl.textContent = `${(result.ram_score || 0).toLocaleString("pt-BR")} pts`;
  if (ramSubEl) ramSubEl.textContent = `${((result.ram_mbs || 0) / 1024).toFixed(1)} GB/s (${result.ram_mbs || 0} MB/s)`;

  if (diskScoreEl) diskScoreEl.textContent = `${(result.disk_score || 0).toLocaleString("pt-BR")} pts`;
  if (diskSubEl) diskSubEl.textContent = `G: ${result.disk_write_mbs || 0} MB/s | L: ${result.disk_read_mbs || 0} MB/s`;

  if (gainEl) {
    if (gain && gain.percent !== undefined) {
      const isPos = gain.is_positive;
      const sign = gain.percent >= 0 ? "+" : "";
      gainEl.innerHTML = `
        <span class="badge ${isPos ? 'badge-green' : 'badge-amber'}" style="font-size:11px; font-weight:700;">
          ${sign}${gain.percent}% (${sign}${gain.diff_points} pts pós-otimização)
        </span>
      `;
    } else {
      gainEl.innerHTML = `<span class="badge badge-cyan" style="font-size:11px;">Linha de Base Gravada</span>`;
    }
  }
}

async function startPulseBenchmark() {
  const btn = document.getElementById("btn-start-benchmark");
  const progressWrap = document.getElementById("bench-progress-wrap");
  const progressBar = document.getElementById("bench-progress-bar");
  const stageTxt = document.getElementById("bench-stage-txt");
  const pctTxt = document.getElementById("bench-pct-txt");

  if (btn) btn.disabled = true;
  if (progressWrap) progressWrap.style.display = "block";
  if (progressBar) progressBar.style.width = "5%";
  if (pctTxt) pctTxt.textContent = "5%";
  if (stageTxt) stageTxt.textContent = "Iniciando teste de desempenho...";

  try {
    const res = await fetch("/api/benchmark/start", { method: "POST" });
    const startData = await res.json();
    if (!startData.success) {
      showToast(startData.message || "Erro ao iniciar benchmark.", "error");
      if (btn) btn.disabled = false;
      if (progressWrap) progressWrap.style.display = "none";
      return;
    }

    if (benchmarkPollTimer) clearInterval(benchmarkPollTimer);
    benchmarkPollTimer = setInterval(async () => {
      try {
        const sRes = await fetch("/api/benchmark/status");
        const st = await sRes.json();

        if (progressBar) progressBar.style.width = `${st.progress || 0}%`;
        if (pctTxt) pctTxt.textContent = `${st.progress || 0}%`;
        if (stageTxt) stageTxt.textContent = st.stage || "Executando teste...";

        if (st.status === "completed") {
          clearInterval(benchmarkPollTimer);
          renderBenchmarkResults(st.latest_result, st.gain);
          if (btn) btn.disabled = false;
          showToast(`Benchmark concluído! PulseScore: ${st.latest_result?.pulse_score?.toLocaleString("pt-BR")} pts!`, "success");
          await loadHistoryStats();
          setTimeout(() => {
            if (progressWrap) progressWrap.style.display = "none";
          }, 3000);
        } else if (st.status === "error") {
          clearInterval(benchmarkPollTimer);
          if (btn) btn.disabled = false;
          showToast(`Erro no benchmark: ${st.error || 'Falha'}`, "error");
          if (progressWrap) progressWrap.style.display = "none";
        }
      } catch (err) {}
    }, 600);

  } catch (e) {
    showToast("Erro ao conectar com o serviço de benchmark.", "error");
    if (btn) btn.disabled = false;
    if (progressWrap) progressWrap.style.display = "none";
  }
}

async function activateTurboMode() {
  const btn = document.getElementById("btn-opt-turbo");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/optimizer/turbo", { method: "POST" });
    const data = await res.json();
    const resEl = document.getElementById("opt-turbo-result");
    if (resEl) {
      resEl.textContent = `Plano Ativo: ${data.power_plan} | +${data.ram_freed_mb} MB RAM livre!`;
    }
    showToast(`Modo Turbo Ativado! Plano '${data.power_plan}' definido e ${data.ram_freed_mb} MB de RAM liberados.`, "success");
    await pollMetrics();
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao ativar Modo Turbo.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function optimizeNetworkNow() {
  const btn = document.getElementById("btn-opt-net");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/optimizer/network", { method: "POST" });
    const data = await res.json();
    if (data.pings) {
      document.getElementById("ping-cf").textContent = data.pings.cloudflare_ms !== null ? `${data.pings.cloudflare_ms} ms` : "Sem resp.";
      document.getElementById("ping-gg").textContent = data.pings.google_ms !== null ? `${data.pings.google_ms} ms` : "Sem resp.";
    }
    showToast("Cache DNS e tabelas de rede otimizados com sucesso!", "success");
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao otimizar rede.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testPingOnly() {
  try {
    const res = await fetch("/api/optimizer/ping");
    const data = await res.json();
    document.getElementById("ping-cf").textContent = data.cloudflare_ms !== null ? `${data.cloudflare_ms} ms` : "Sem resp.";
    document.getElementById("ping-gg").textContent = data.google_ms !== null ? `${data.google_ms} ms` : "Sem resp.";
  } catch (e) {}
}

async function loadWindowsTweaks() {
  try {
    const res = await fetch("/api/optimizer/tweaks");
    const data = await res.json();
    renderWindowsTweaks(data.tweaks || []);
  } catch (e) {}
}

function renderWindowsTweaks(tweaks) {
  const container = document.getElementById("tweaks-list-container");
  if (!container) return;
  container.innerHTML = tweaks.map(t => `
    <div class="category-row">
      <div class="category-left">
        <div>
          <div class="category-title">
            ${escapeHtml(t.title)}
            ${t.optimized ? `<span class="badge badge-green" style="margin-left:8px;">Otimizado</span>` : `<span class="badge badge-cyan" style="margin-left:8px;">Padrão do Windows</span>`}
          </div>
          <div class="category-desc">${escapeHtml(t.description)}</div>
        </div>
      </div>
      <div class="category-right">
        <label class="switch">
          <input type="checkbox" ${t.optimized ? "checked" : ""} onchange="toggleTweak('${escapeHtml(t.id)}', this.checked)" />
          <span class="slider"></span>
        </label>
      </div>
    </div>
  `).join("");
}

async function toggleTweak(tweakId, enable) {
  try {
    const res = await fetch("/api/optimizer/tweaks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tweak_id: tweakId, enable })
    });
    const data = await res.json();
    if (data.tweaks) renderWindowsTweaks(data.tweaks);
    showToast(enable ? "Ajuste de desempenho ativado!" : "Configuração padrão restaurada.", "success");
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao aplicar ajuste do Windows.", "error");
  }
}

// ================= MANAGER: PROCESSES, STARTUP & PROGRAMS =================
async function loadProcesses() {
  const sortBy = document.getElementById("proc-sort")?.value || "ram";
  try {
    const res = await fetch(`/api/manager/processes?sort_by=${encodeURIComponent(sortBy)}`);
    const data = await res.json();
    currentProcesses = data.processes || [];
    document.getElementById("proc-hogs-badge").textContent = `${data.hogs_count} vilões de recursos`;
    renderProcessesTable();
  } catch (e) {}
}

function renderProcessesTable() {
  const tbody = document.getElementById("proc-table-body");
  if (!tbody) return;
  const q = (document.getElementById("proc-search")?.value || "").toLowerCase();
  const filtered = currentProcesses.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q));

  tbody.innerHTML = filtered.map(p => `
    <tr>
      <td style="color:var(--text-secondary); font-family:Consolas,monospace;">${p.pid}</td>
      <td style="font-weight:600;">${escapeHtml(p.name)}</td>
      <td>
        ${p.is_hog ? `<span class="badge badge-red">Alto Consumo</span>` : p.protected ? `<span class="badge badge-cyan">Sistema Windows</span>` : `<span class="badge badge-green">Normal</span>`}
      </td>
      <td style="font-weight:600; color:${p.cpu_percent > 20 ? 'var(--bad)' : 'var(--text-primary)'};">${p.cpu_percent}%</td>
      <td style="font-weight:700; color:${p.ram_mb > 500 ? 'var(--warn)' : 'var(--cobalt)'};">${escapeHtml(p.ram_formatted)} (${p.ram_percent}%)</td>
      <td style="text-align:right;">
        ${p.protected
          ? `<span style="font-size:11.5px; color:var(--text-muted);">Protegido</span>`
          : `<button class="btn btn-sm btn-danger" onclick="killProcessById(${p.pid}, ${JSON.stringify(p.name).replace(/"/g, '&quot;')})">Encerrar</button>`
        }
      </td>
    </tr>
  `).join("");
}

async function killProcessById(pid, name) {
  const proc = currentProcesses.find(p => p.pid === pid);
  const ok = await confirmDialog({
    title: `Encerrar ${name}?`,
    message: "O programa será fechado imediatamente:",
    items: [{ name: `${name} (PID ${pid})`, detail: proc ? `${proc.ram_formatted} de RAM` : "" }],
    note: "Qualquer trabalho não salvo neste programa será perdido.",
    confirmLabel: "Encerrar processo",
    tone: "danger"
  });
  if (!ok) return;
  try {
    const res = await fetch("/api/manager/kill-process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid })
    });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");
    await loadProcesses();
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao encerrar processo.", "error");
  }
}

async function loadStartupItems() {
  const container = document.getElementById("startup-list-container");
  if (!container) return;
  container.innerHTML = `<div class="card" style="text-align:center; padding:30px;"><span class="spinner"></span> Carregando programas de inicialização...</div>`;
  try {
    const res = await fetch("/api/manager/startup");
    const data = await res.json();
    if (typeof data.is_admin === "boolean") {
      isAdmin = data.is_admin;
      applyAdminState();
    }
    renderStartupItems(data.items || []);
  } catch (e) {}
}

function renderStartupItems(items) {
  const container = document.getElementById("startup-list-container");
  if (!items.length) {
    container.innerHTML = `<div class="card" style="text-align:center; padding:30px; color:var(--text-secondary);">Nenhum item de inicialização encontrado.</div>`;
    return;
  }
  container.innerHTML = items.map((item, idx) => {
    const locked = item.requires_admin && isAdmin === false;
    return `
    <div class="category-row ${locked ? "is-blocked" : ""}">
      <div class="category-left">
        <div>
          <div class="category-title">
            ${escapeHtml(item.name)}
            ${item.enabled ? `<span class="badge badge-green" style="margin-left:8px;">Inicia com o Windows</span>` : `<span class="badge badge-amber" style="margin-left:8px;">Desativado no Boot</span>`}
            <span class="badge badge-cyan" style="margin-left:4px;">${escapeHtml(item.location)}</span>
            ${locked ? `<span class="badge badge-amber" style="margin-left:4px;">Requer administrador</span>` : ""}
          </div>
          <div class="category-samples" style="margin-top:4px;">${escapeHtml(item.command)}</div>
        </div>
      </div>
      <div class="category-right">
        <label class="switch" ${locked ? 'title="Requer modo administrador"' : ""}>
          <input type="checkbox" ${item.enabled ? "checked" : ""} ${locked ? "disabled" : ""} onchange="toggleStartup(${JSON.stringify(item.id).replace(/"/g, '&quot;')}, this.checked)" />
          <span class="slider"></span>
        </label>
      </div>
    </div>
  `;
  }).join("");
}

async function toggleStartup(itemId, enable) {
  try {
    const res = await fetch("/api/manager/startup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId, enable })
    });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");
    if (data.items) renderStartupItems(data.items);
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao alterar item de inicialização.", "error");
  }
}

async function loadInstalledPrograms() {
  const tbody = document.getElementById("prog-table-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px;"><span class="spinner"></span> Listando programas instalados no Windows...</td></tr>`;
  try {
    const res = await fetch("/api/manager/programs");
    const data = await res.json();
    currentPrograms = data.programs || [];
    document.getElementById("prog-count-badge").textContent = `${currentPrograms.length} programas instalados`;
    renderProgramsTable();
  } catch (e) {}
}

function renderProgramsTable() {
  const tbody = document.getElementById("prog-table-body");
  if (!tbody) return;
  const q = (document.getElementById("prog-search")?.value || "").toLowerCase();
  const filtered = currentPrograms.filter(p => !q || p.name.toLowerCase().includes(q) || p.publisher.toLowerCase().includes(q));

  tbody.innerHTML = filtered.map((p, idx) => `
    <tr>
      <td style="font-weight:600;">
        ${escapeHtml(p.name)}
        ${p.is_ghost ? `<span class="badge badge-amber" style="margin-left:6px; font-size:10px;" title="A pasta original deste programa já foi apagada do disco, restando apenas este registro órfão no Windows.">👻 Registro Fantasma</span>` : ""}
      </td>
      <td style="color:var(--text-secondary);">${escapeHtml(p.publisher)}</td>
      <td><span class="badge badge-cyan">${escapeHtml(p.version || "--")}</span></td>
      <td style="font-weight:700; color:${p.is_ghost ? 'var(--text-secondary)' : (p.size_bytes > 500 * 1024 * 1024 ? 'var(--warn)' : 'var(--text-primary)')};" title="${p.is_ghost ? 'Tamanho gravado no Registro antes da pasta ser apagada (não ocupa espaço real no disco)' : ''}">
        ${escapeHtml(p.size_formatted)}${p.is_ghost ? ` <span style="font-size:11px; font-weight:500; opacity:0.75;">(órfão)</span>` : ""}
      </td>
      <td style="color:var(--text-secondary); font-size:12px;">${escapeHtml(p.install_date)}</td>
      <td style="text-align:right;">
        <div style="display:flex; gap:6px; justify-content:flex-end;">
          <button class="btn btn-sm btn-secondary" title="Caçar pastas órfãs e chaves de registro residuais" onclick="scanLeftoversForApp(${JSON.stringify(p.name).replace(/"/g, '&quot;')}, ${JSON.stringify(p.publisher).replace(/"/g, '&quot;')})">Deep Clean</button>
          <button class="btn btn-sm btn-danger" onclick="uninstallProgram(${JSON.stringify(p.uninstall_string).replace(/"/g, '&quot;')}, ${JSON.stringify(p.name).replace(/"/g, '&quot;')})">${p.is_ghost ? "Remover Órfão" : "Desinstalar"}</button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function uninstallProgram(uninstallString, appName) {
  const prog = currentPrograms.find(p => p.uninstall_string === uninstallString);
  if (prog && prog.is_ghost) {
    const cleanGhost = await confirmDialog({
      title: `Registro Fantasma: ${appName}`,
      message: "A pasta e o desinstalador deste programa já foram apagados do seu disco anteriormente, restando apenas uma entrada fantasma no Registro do Windows.",
      items: [{ name: appName, detail: "Não ocupa espaço real no disco" }],
      note: "Deseja abrir o Deep Clean agora para remover essa entrada órfã da lista de programas do Windows?",
      confirmLabel: "🧹 Limpar Registro Fantasma"
    });
    if (cleanGhost) {
      scanLeftoversForApp(appName, prog.publisher || "");
    }
    return;
  }

  const ok = await confirmDialog({
    title: `Desinstalar ${appName}?`,
    message: "Vamos abrir o desinstalador oficial do programa:",
    items: [{ name: appName, detail: prog && prog.size_bytes > 0 ? prog.size_formatted : "" }],
    note: "Nada é removido até você confirmar na janela do desinstalador.",
    confirmLabel: "Abrir desinstalador"
  });
  if (!ok) return;
  try {
    const res = await fetch("/api/manager/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uninstall_string: uninstallString, app_name: appName })
    });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");

    if (data.ghost_entry) {
      scanLeftoversForApp(appName, prog ? prog.publisher : "");
      return;
    }

    if (data.success) {
      setTimeout(async () => {
        const wantDeepClean = await confirmDialog({
          title: "Caçador de Sobras (Deep Clean)",
          message: `O desinstalador oficial de '${appName}' foi iniciado na janela do Windows.`,
          note: "Quando a desinstalação terminar, deseja fazer uma varredura profunda em busca de pastas órfãs e chaves de registro deixadas para trás?",
          confirmLabel: "🧹 Caçar Sobras Agora"
        });
        if (wantDeepClean) {
          scanLeftoversForApp(appName, prog ? prog.publisher : "");
        }
      }, 1800);
    }
  } catch (e) {
    showToast("Erro ao iniciar desinstalador.", "error");
  }
}



// ================= DEEP CLEAN / LEFTOVER SCANNER MODULE =================
let currentLeftovers = null;

async function scanLeftoversForApp(appName, publisher = "") {
  const modal = document.getElementById("leftovers-modal-backdrop");
  const list = document.getElementById("leftovers-list");
  const title = document.getElementById("leftovers-modal-title");
  const badge = document.getElementById("leftovers-count-badge");
  const desc = document.getElementById("leftovers-modal-desc");
  const sizeEl = document.getElementById("leftovers-total-size");
  const btnClean = document.getElementById("btn-confirm-clean-leftovers");

  if (!modal || !list) return;

  if (title) title.textContent = `🧹 Caçador de Sobras: ${appName}`;
  if (badge) {
    badge.textContent = "Buscando...";
    badge.className = "badge badge-amber";
  }
  if (desc) desc.textContent = "Varrendo AppData, ProgramData, atalhos e chaves do Registro por pastas e arquivos deixados para trás...";
  if (sizeEl) sizeEl.textContent = "Calculando tamanho...";
  if (btnClean) btnClean.disabled = true;

  list.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-secondary); font-size:13px;"><span class="spinner" style="display:inline-block; margin-right:8px;"></span>Escaneando sobras no disco e no Registro...</div>`;
  modal.hidden = false;

  try {
    const res = await fetch("/api/manager/leftovers/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_name: appName, publisher: publisher })
    });
    const data = await res.json();
    currentLeftovers = data;

    if (badge) {
      badge.textContent = `${data.total_items} sobras encontradas`;
      badge.className = data.total_items > 0 ? "badge badge-green" : "badge badge-cyan";
    }

    if (data.total_items === 0) {
      list.innerHTML = `
        <div style="text-align:center; padding:30px; color:var(--accent-emerald);">
          <div style="font-size:24px; margin-bottom:8px;">✨</div>
          <div style="font-weight:700; font-size:14px;">Nenhuma sobra encontrada!</div>
          <div style="font-size:12.5px; color:var(--text-secondary); margin-top:4px;">O aplicativo não deixou pastas órfãs ou chaves no registro nos locais padrão.</div>
        </div>
      `;
      if (sizeEl) sizeEl.textContent = "Total selecionado: 0 B";
      if (btnClean) btnClean.disabled = true;
      return;
    }

    let itemsHtml = "";

    // Folders
    if (data.folders && data.folders.length > 0) {
      itemsHtml += `<div style="font-size:11px; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary); font-weight:700; margin-top:4px;">Pastas Residuais no Disco (${data.folders.length})</div>`;
      data.folders.forEach((f, idx) => {
        itemsHtml += `
          <label style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <input type="checkbox" class="leftover-folder-cb" data-idx="${idx}" checked onchange="updateLeftoversSelectedTotal()">
              <div style="min-width:0; overflow:hidden;">
                <div style="font-weight:600; font-size:12.5px;">📁 ${escapeHtml(f.name)}</div>
                <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${escapeHtml(f.path)}</div>
              </div>
            </div>
            <span style="font-weight:700; font-size:12px; color:var(--accent-emerald); flex-shrink:0;">${escapeHtml(f.size_formatted)}</span>
          </label>
        `;
      });
    }

    // Files / Shortcuts
    if (data.files && data.files.length > 0) {
      itemsHtml += `<div style="font-size:11px; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary); font-weight:700; margin-top:10px;">Atalhos & Arquivos Órfãos (${data.files.length})</div>`;
      data.files.forEach((f, idx) => {
        itemsHtml += `
          <label style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <input type="checkbox" class="leftover-file-cb" data-idx="${idx}" checked onchange="updateLeftoversSelectedTotal()">
              <div style="min-width:0; overflow:hidden;">
                <div style="font-weight:600; font-size:12.5px;">📄 ${escapeHtml(f.name)}</div>
                <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${escapeHtml(f.path)}</div>
              </div>
            </div>
            <span style="font-size:11.5px; color:var(--text-secondary); flex-shrink:0;">${escapeHtml(f.size_formatted)}</span>
          </label>
        `;
      });
    }

    // Registry Keys
    if (data.registry_keys && data.registry_keys.length > 0) {
      itemsHtml += `<div style="font-size:11px; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary); font-weight:700; margin-top:10px;">Chaves Residuais no Registro do Windows (${data.registry_keys.length})</div>`;
      data.registry_keys.forEach((rk, idx) => {
        const subDesc = rk.is_uninstall_entry
          ? "Entrada fantasma na lista de Programas Instalados do Windows"
          : "Chave de configuração órfã";
        const badgeLbl = rk.is_uninstall_entry ? "👻 Registro Fantasma" : "Registro";
        itemsHtml += `
          <label style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <input type="checkbox" class="leftover-reg-cb" data-idx="${idx}" checked onchange="updateLeftoversSelectedTotal()">
              <div style="min-width:0; overflow:hidden;">
                <div style="font-weight:600; font-size:12.5px;">🔑 ${escapeHtml(rk.display)}</div>
                <div style="font-size:11px; color:var(--text-secondary);">${subDesc}</div>
              </div>
            </div>
            <span class="badge badge-amber" style="font-size:10px; flex-shrink:0;">${badgeLbl}</span>
          </label>
        `;
      });
    }

    list.innerHTML = itemsHtml;
    if (btnClean) btnClean.disabled = false;
    updateLeftoversSelectedTotal();

  } catch (e) {
    list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12.5px;">Erro ao escanear sobras: ${e.message}</div>`;
  }
}

function updateLeftoversSelectedTotal() {
  if (!currentLeftovers) return;
  const folderCbs = document.querySelectorAll(".leftover-folder-cb");
  const fileCbs = document.querySelectorAll(".leftover-file-cb");
  const regCbs = document.querySelectorAll(".leftover-reg-cb");

  let totalBytes = 0;
  let count = 0;

  folderCbs.forEach(cb => {
    if (cb.checked) {
      const idx = parseInt(cb.getAttribute("data-idx"));
      totalBytes += (currentLeftovers.folders[idx]?.size_bytes || 0);
      count++;
    }
  });

  fileCbs.forEach(cb => {
    if (cb.checked) {
      const idx = parseInt(cb.getAttribute("data-idx"));
      totalBytes += (currentLeftovers.files[idx]?.size_bytes || 0);
      count++;
    }
  });

  regCbs.forEach(cb => {
    if (cb.checked) count++;
  });

  const sizeEl = document.getElementById("leftovers-total-size");
  if (sizeEl) {
    sizeEl.textContent = `Total selecionado: ${formatBytesJs(totalBytes)} (${count} itens)`;
  }

  const btnClean = document.getElementById("btn-confirm-clean-leftovers");
  if (btnClean) btnClean.disabled = count === 0;
}

function closeLeftoversModal() {
  const modal = document.getElementById("leftovers-modal-backdrop");
  if (modal) modal.hidden = true;
}

async function cleanSelectedLeftovers() {
  if (!currentLeftovers) return;

  const folderCbs = document.querySelectorAll(".leftover-folder-cb:checked");
  const fileCbs = document.querySelectorAll(".leftover-file-cb:checked");
  const regCbs = document.querySelectorAll(".leftover-reg-cb:checked");

  const foldersToClean = Array.from(folderCbs).map(cb => {
    const idx = parseInt(cb.getAttribute("data-idx"));
    return currentLeftovers.folders[idx].path;
  });

  const filesToClean = Array.from(fileCbs).map(cb => {
    const idx = parseInt(cb.getAttribute("data-idx"));
    return currentLeftovers.files[idx].path;
  });

  const regToClean = Array.from(regCbs).map(cb => {
    const idx = parseInt(cb.getAttribute("data-idx"));
    return currentLeftovers.registry_keys[idx];
  });

  const btnClean = document.getElementById("btn-confirm-clean-leftovers");
  if (btnClean) {
    btnClean.disabled = true;
    btnClean.textContent = "Eliminando sobras...";
  }

  try {
    const res = await fetch("/api/manager/leftovers/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folders: foldersToClean,
        files: filesToClean,
        registry_keys: regToClean,
        app_name: currentLeftovers.app_name
      })
    });
    const data = await res.json();
    closeLeftoversModal();

    if (data.success && (data.removed_folders + data.removed_files + data.removed_keys) > 0) {
      showToast(`Deep Clean concluído! ${data.cleaned_formatted} recuperados (${data.removed_folders + data.removed_files} itens e ${data.removed_keys} chaves).`, "success");
      await loadHistoryStats();
      await loadInstalledPrograms();
    } else if (data.errors && data.errors.length > 0) {
      showToast(data.errors[0], "error");
    } else {
      showToast("Não foi possível eliminar algumas sobras.", "error");
    }
  } catch (e) {
    showToast("Erro ao processar Deep Clean.", "error");
  } finally {
    if (btnClean) {
      btnClean.disabled = false;
      btnClean.textContent = "Eliminar Sobras (Lixeira)";
    }
  }
}


// ================= INACTIVE NODE_MODULES CLEANER =================
let currentNodeModules = [];

async function scanNodeModulesNow() {
  const btn = document.getElementById("btn-scan-nodemodules");
  const resultsDiv = document.getElementById("nodemodules-results");
  const list = document.getElementById("nodemodules-list");
  const summary = document.getElementById("nodemodules-summary");

  if (btn) btn.disabled = true;
  if (summary) summary.textContent = "Escaneando projetos inativos (>30 dias)...";
  if (resultsDiv) resultsDiv.style.display = "block";
  if (list) list.innerHTML = `<div style="text-align:center; padding:18px; color:var(--text-secondary); font-size:12.5px;"><span class="spinner" style="display:inline-block; margin-right:8px;"></span>Varrendo pastas de usuário por node_modules...</div>`;

  try {
    const res = await fetch("/api/cleaner/dev/node-modules?days_inactive=30");
    const data = await res.json();
    currentNodeModules = data.projects || [];

    if (summary) {
      summary.textContent = `${data.total_projects} projetos inativos encontrados (${data.total_formatted} recuperáveis)`;
    }

    if (currentNodeModules.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:18px; color:var(--accent-emerald); font-size:12.5px;">✨ Nenhuma pasta node_modules inativa (>30 dias) encontrada!</div>`;
      return;
    }

    list.innerHTML = currentNodeModules.map((p, idx) => `
      <label style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
        <div style="display:flex; align-items:center; gap:10px; min-width:0;">
          <input type="checkbox" class="nm-project-cb" data-idx="${idx}" checked>
          <div style="min-width:0; overflow:hidden;">
            <div style="font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px;">
              📦 ${escapeHtml(p.project_name)}
              <span class="badge badge-amber" style="font-size:10px;">Parado há ${p.days_inactive} dias</span>
            </div>
            <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${escapeHtml(p.path)}</div>
          </div>
        </div>
        <span style="font-weight:700; font-size:12.5px; color:var(--accent-emerald); flex-shrink:0;">${escapeHtml(p.size_formatted)}</span>
      </label>
    `).join("");

  } catch (e) {
    if (list) list.innerHTML = `<div style="text-align:center; padding:18px; color:var(--text-secondary); font-size:12.5px;">Erro ao buscar node_modules.</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cleanSelectedNodeModules() {
  const cbs = document.querySelectorAll(".nm-project-cb:checked");
  if (cbs.length === 0) {
    showToast("Selecione pelo menos um projeto para limpar.", "info");
    return;
  }

  const paths = Array.from(cbs).map(cb => {
    const idx = parseInt(cb.getAttribute("data-idx"));
    return currentNodeModules[idx].path;
  });

  const ok = await confirmDialog({
    title: "Mover node_modules para a Lixeira?",
    message: `Você selecionou ${paths.length} pasta(s) node_modules inativas.`,
    note: "Se você voltar a trabalhar nesses projetos no futuro, basta rodar 'npm install' novamente para reinstalar.",
    confirmLabel: "Mover para a Lixeira"
  });
  if (!ok) return;

  const btn = document.getElementById("btn-clean-nodemodules");
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/cleaner/dev/node-modules/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`${data.cleaned_formatted} liberados! ${data.removed_count} pasta(s) node_modules enviadas para a Lixeira.`, "success");
      await loadHistoryStats();
      await scanNodeModulesNow();
    } else {
      showToast("Erro ao limpar node_modules.", "error");
    }
  } catch (e) {
    showToast("Erro ao conectar ao serviço de limpeza.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}


// ================= REPAIR, HARDWARE SPECS & HISTORY =================
async function createSystemRestorePoint() {
  showToast("Solicitando criação de Ponto de Restauração ao Windows...", "info");
  try {
    const res = await fetch("/api/repair/restore-point", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "PulsePC Otimizador - Ponto de Seguranca" })
    });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");
    await loadHistoryStats();
  } catch (e) {
    showToast("Erro ao criar ponto de restauração.", "error");
  }
}

async function runRepairTool(toolId) {
  const outBox = document.getElementById("repair-output-box");
  outBox.style.display = "block";
  outBox.textContent = "Executando ferramenta do Windows... Aguarde...";
  try {
    const res = await fetch("/api/repair/run-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_id: toolId })
    });
    const data = await res.json();
    showToast(data.message, data.success ? "success" : "error");
    outBox.textContent = data.output ? `${data.message}\n\n${data.output}` : data.message;
    await loadHistoryStats();
  } catch (e) {
    outBox.textContent = "Erro ao executar ferramenta de reparo.";
  }
}

async function loadHardwareSpecs() {
  try {
    const res = await fetch("/api/hardware");
    const d = await res.json();
    hardwareSpecsData = d;

    // Update S.M.A.R.T. section on Dashboard
    const smartEl = document.getElementById("physical-disks-smart");
    if (smartEl && d.physical_disks) {
      if (d.physical_disks.length === 0) {
        smartEl.innerHTML = `<div style="font-size:12.5px; color:var(--text-secondary);">Disco Físico Principal: Status Saudável (S.M.A.R.T. OK)</div>`;
      } else {
        smartEl.innerHTML = d.physical_disks.map(pd => {
          const isHealthy = String(pd.HealthStatus || "Healthy").toLowerCase() === "healthy";
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--paper); border:1px solid var(--border-color); border-radius:8px; margin-bottom:6px; font-size:12.5px;">
              <div>
                <strong>${escapeHtml(pd.FriendlyName || "Disco Físico")}</strong>
                <span class="badge badge-cyan" style="margin-left:6px;">${escapeHtml(pd.MediaType || pd.BusType || "SSD/NVMe")} — ${pd.Size_GB || 0} GB</span>
              </div>
              <span class="badge ${isHealthy ? 'badge-green' : 'badge-red'}">
                S.M.A.R.T.: ${isHealthy ? "Saudável (100%)" : escapeHtml(pd.HealthStatus)}
              </span>
            </div>
          `;
        }).join("");
      }
    }

    // Update Hardware Specs Card on Tab 7
    const specBox = document.getElementById("hardware-specs-container");
    if (specBox) {
      const gpusStr = (d.gpus || []).map(g => `${g.Name} ${g.AdapterRAM_GB ? `(${g.AdapterRAM_GB} GB)` : ""}`).join(" | ") || "N/A";
      const ramsStr = (d.rams || []).map(r => `${r.Capacity_GB} GB ${r.Speed ? `@ ${r.Speed} MHz` : ""} (${(r.Manufacturer || "").trim()})`).join(" + ") || "Memória Integrada";
      const disksStr = (d.physical_disks || []).map(pd => `${pd.FriendlyName} (${pd.Size_GB} GB - ${pd.MediaType || "SSD"})`).join(" | ") || "Disco Local";

      specBox.innerHTML = `
        <div class="spec-row"><span>Sistema Operacional</span><span>${escapeHtml(d.os?.Caption || "Windows")} (${escapeHtml(d.os?.OSArchitecture || "64-bit")} - Build ${escapeHtml(d.os?.BuildNumber || "")})</span></div>
        <div class="spec-row"><span>Nome do Computador</span><span>${escapeHtml(d.os?.CSName || "--")}</span></div>
        <div class="spec-row"><span>Processador (CPU)</span><span>${escapeHtml(d.cpu?.Name || "--")} (${d.cpu?.NumberOfCores || "--"}C / ${d.cpu?.NumberOfLogicalProcessors || "--"}T)</span></div>
        <div class="spec-row"><span>Placa-Mãe</span><span>${escapeHtml(d.board?.Manufacturer || "")} ${escapeHtml(d.board?.Product || "")}</span></div>
        <div class="spec-row"><span>Versão da BIOS</span><span>${escapeHtml(d.bios?.SMBIOSBIOSVersion || "--")}</span></div>
        <div class="spec-row"><span>Placa de Vídeo (GPU)</span><span>${escapeHtml(gpusStr)}</span></div>
        <div class="spec-row"><span>Módulos de Memória RAM</span><span>${escapeHtml(ramsStr)}</span></div>
        <div class="spec-row"><span>Discos Físicos</span><span>${escapeHtml(disksStr)}</span></div>
      `;
    }
  } catch (e) {}
}

function copyHardwareReport() {
  if (!hardwareSpecsData) return;
  const d = hardwareSpecsData;
  const text = [
    "=== RELATÓRIO DE HARDWARE PULSEPC PRO ===",
    `SO: ${d.os?.Caption || ""} (Build ${d.os?.BuildNumber || ""})`,
    `CPU: ${d.cpu?.Name || ""} (${d.cpu?.NumberOfCores} núcleos / ${d.cpu?.NumberOfLogicalProcessors} threads)`,
    `Placa-Mãe: ${d.board?.Manufacturer || ""} ${d.board?.Product || ""}`,
    `GPU: ${(d.gpus || []).map(g => g.Name).join(", ")}`,
    `RAM: ${(d.rams || []).map(r => `${r.Capacity_GB}GB ${r.Speed || ""}MHz`).join(" + ")}`,
    `Discos: ${(d.physical_disks || []).map(p => `${p.FriendlyName} (${p.Size_GB}GB - S.M.A.R.T: ${p.HealthStatus})`).join(", ")}`
  ].join("\n");

  navigator.clipboard.writeText(text).then(() => {
    showToast("Ficha técnica copiada para a área de transferência!", "success");
  });
}

async function loadBatteryHealth(force = false) {
  const container = document.getElementById("battery-health-container");
  if (!container) return;
  if (force) {
    container.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-secondary);"><span class="spinner"></span> Atualizando dados da bateria...</div>`;
  }
  try {
    const res = await fetch(`/api/battery/report?force=${force ? 'true' : 'false'}`);
    const bat = await res.json();

    if (!bat.is_laptop || !bat.has_battery) {
      container.innerHTML = `
        <div style="display:flex; align-items:center; gap:16px; padding:16px 20px; background:var(--paper); border:1px solid var(--border-color); border-radius:12px;">
          <div style="width:48px; height:48px; border-radius:12px; background:rgba(34,197,94,0.15); border:1px solid rgba(34,197,94,0.3); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#22c55e" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <div style="flex:1;">
            <div style="display:flex; align-items:center; gap:8px;">
              <strong style="font-size:15px; color:var(--text-primary);">${escapeHtml(bat.device_type || "Computador Desktop")}</strong>
              <span class="badge badge-green">Alimentação Contínua AC</span>
            </div>
            <p style="font-size:12.5px; color:var(--text-secondary); margin-top:4px; line-height:1.4;">
              ${escapeHtml(bat.message || "Dispositivo conectado permanentemente à rede elétrica via fonte. Desgaste químico de bateria: 0% (Inexistente).")}
            </p>
          </div>
          <div style="text-align:right;">
            <div style="font-size:22px; font-weight:800; color:var(--accent-emerald);">100%</div>
            <div style="font-size:11px; color:var(--text-secondary);">Estabilidade Energética</div>
          </div>
        </div>
      `;
      return;
    }

    // Laptop with battery
    const healthTone = bat.status_tone === 'great' || bat.status_tone === 'ok' ? 'badge-green' : (bat.status_tone === 'warn' ? 'badge-amber' : 'badge-red');
    const healthColor = bat.status_tone === 'great' || bat.status_tone === 'ok' ? 'var(--accent-emerald)' : (bat.status_tone === 'warn' ? 'var(--accent-amber)' : 'var(--accent-rose)');

    container.innerHTML = `
      <div style="display:grid; grid-template-columns: 240px 1fr; gap:20px; align-items:center; padding:16px; background:var(--paper); border:1px solid var(--border-color); border-radius:12px;">
        <div style="text-align:center; padding:12px; background:var(--sunken); border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:11.5px; font-weight:700; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px;">Saúde da Bateria</div>
          <div style="font-size:38px; font-weight:800; color:${healthColor}; margin:4px 0; font-variant-numeric:tabular-nums;">
            ${bat.health_percent}%
          </div>
          <div class="progress-bar" style="height:7px; margin:8px 0;">
            <div class="progress-fill" style="width:${bat.health_percent}%; background:${healthColor};"></div>
          </div>
          <div style="font-size:12px; color:var(--text-secondary);">
            Desgaste acumulado: <strong style="color:var(--text-primary);">${bat.wear_percent}%</strong>
          </div>
        </div>

        <div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div style="font-size:14px; font-weight:700;">
              ${escapeHtml(bat.manufacturer || "Bateria")} — ${escapeHtml(bat.chemistry || "Li-ion")}
            </div>
            <span class="badge ${healthTone}">${escapeHtml(bat.status_label)}</span>
          </div>

          <div class="grid-3" style="gap:10px; margin-bottom:10px;">
            <div class="disk-item" style="padding:10px 12px; margin:0;">
              <div style="font-size:11px; color:var(--text-secondary);">Capacidade de Fábrica</div>
              <strong style="font-size:14px;">${bat.design_capacity_mwh ? (bat.design_capacity_mwh / 1000).toFixed(1) + ' Wh' : '--'}</strong>
              <div style="font-size:10.5px; color:var(--text-secondary);">${bat.design_capacity_mwh ? bat.design_capacity_mwh + ' mWh' : ''}</div>
            </div>
            <div class="disk-item" style="padding:10px 12px; margin:0;">
              <div style="font-size:11px; color:var(--text-secondary);">Capacidade Atual Máx.</div>
              <strong style="font-size:14px; color:${healthColor};">${bat.full_charge_capacity_mwh ? (bat.full_charge_capacity_mwh / 1000).toFixed(1) + ' Wh' : '--'}</strong>
              <div style="font-size:10.5px; color:var(--text-secondary);">${bat.full_charge_capacity_mwh ? bat.full_charge_capacity_mwh + ' mWh' : ''}</div>
            </div>
            <div class="disk-item" style="padding:10px 12px; margin:0;">
              <div style="font-size:11px; color:var(--text-secondary);">Ciclos de Carga</div>
              <strong style="font-size:14px;">${bat.cycle_count !== null ? bat.cycle_count : 'Não informado'}</strong>
              <div style="font-size:10.5px; color:var(--text-secondary);">${bat.power_plugged ? 'Conectado à tomada' : 'Na bateria'}</div>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--text-secondary); padding-top:4px;">
            <span>Carga Atual: <strong style="color:var(--text-primary);">${bat.percent_remaining}%</strong></span>
            <span>Autonomia Estimada: <strong style="color:var(--text-primary);">${escapeHtml(bat.time_remaining_formatted || "--")}</strong></span>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="padding:16px; color:var(--accent-rose);">Erro ao carregar dados de bateria.</div>`;
  }
}

async function openOfficialBatteryHtml() {
  try {
    showToast("Gerando relatório oficial de bateria do Windows...", "info");
    const res = await fetch("/api/battery/generate-html", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast("Relatório de bateria gerado e aberto com sucesso!", "success");
    } else {
      showToast(data.error || "Não foi possível gerar o relatório de bateria.", "error");
    }
  } catch (err) {
    showToast("Erro ao abrir relatório de bateria.", "error");
  }
}

async function loadHistoryStats() {
  try {
    const res = await fetch("/api/history");
    const h = await res.json();

    document.getElementById("sidebar-total-cleaned").textContent = h.total_bytes_formatted || "0 B";
    document.getElementById("sidebar-total-ram").textContent = `${h.total_ram_freed_mb || 0} MB`;

    const histBytes = document.getElementById("hist-total-bytes");
    if (histBytes) {
      histBytes.textContent = h.total_bytes_formatted || "0 B";
      document.getElementById("hist-total-ram").textContent = `${h.total_ram_freed_mb || 0} MB`;
      document.getElementById("hist-total-files").textContent = (h.total_files_removed || 0).toLocaleString("pt-BR");
    }

    const actionsList = document.getElementById("history-actions-list");
    if (actionsList) {
      const actions = h.actions || [];
      if (!actions.length) {
        actionsList.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-secondary); font-size:12.5px;">Nenhuma otimização registrada ainda.</div>`;
      } else {
        actionsList.innerHTML = actions.map(a => `
          <div style="padding:9px 12px; background:var(--paper); border:1px solid var(--border-color); border-radius:8px; font-size:12px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
              <strong style="color:var(--text-primary);">${escapeHtml(a.title)}</strong>
              <span style="color:var(--text-muted); font-size:11px;">${escapeHtml(a.timestamp)}</span>
            </div>
            <div style="color:var(--text-secondary);">${escapeHtml(a.details)}</div>
          </div>
        `).join("");
      }
    }
  } catch (e) {}
}

// Initialize App
window.addEventListener("DOMContentLoaded", async () => {
  await pollMetrics();
  setInterval(pollMetrics, 1600);
  loadScannerPresets();
  loadHistoryStats();
  loadHardwareSpecs();
  pollGameBoosterStatus();
  setInterval(pollGameBoosterStatus, 3000);
  loadBenchmarkData();
  setTimeout(() => checkUpdates(true), 3500);
});

window.addEventListener("resize", drawStrip);
// Canvases inside a hidden tab have no size; redraw when the dashboard comes back.
document.querySelector('.nav-item[data-tab="tab-dashboard"]').addEventListener("click", () => requestAnimationFrame(pollMetrics));


// ================= UPDATER MODULE =================
let pendingUpdate = null;
let updatePollTimer = null;

async function checkUpdates(silent = true) {
  const btnSidebar = document.getElementById("btn-check-update-sidebar");
  if (!silent && btnSidebar) {
    btnSidebar.disabled = true;
    btnSidebar.textContent = "...";
  }

  try {
    const res = await fetch("/api/updater/check");
    const data = await res.json();

    const versionTag = document.getElementById("sidebar-version-tag");
    if (versionTag && data.current_version) {
      versionTag.textContent = `v${data.current_version}`;
    }

    if (data.has_update) {
      pendingUpdate = data;
      const banner = document.getElementById("update-banner");
      if (banner) {
        banner.style.display = "flex";
        document.getElementById("update-title").textContent = `Nova versão ${data.tag_name || data.latest_version} disponível!`;
        document.getElementById("update-desc").textContent = `Versão atual: v${data.current_version} • Novos recursos e melhorias prontos para instalação.`;
      }
      if (!silent) {
        showToast(`Nova versão ${data.tag_name || data.latest_version} encontrada!`, "info");
      }
    } else {
      if (!silent) {
        showToast(`Você já está na versão mais recente (v${data.current_version || "1.0.0"})!`, "success");
      }
    }
  } catch (e) {
    if (!silent) {
      showToast("Não foi possível verificar atualizações no momento.", "error");
    }
  } finally {
    if (!silent && btnSidebar) {
      btnSidebar.disabled = false;
      btnSidebar.textContent = "Verificar";
    }
  }
}

function checkUpdatesManually() {
  checkUpdates(false);
}

function dismissUpdateBanner() {
  const banner = document.getElementById("update-banner");
  if (banner) banner.style.display = "none";
}

async function startUpdateProcess() {
  if (!pendingUpdate || !pendingUpdate.download_url) {
    showToast("Link de download não disponível.", "error");
    return;
  }

  const btn = document.getElementById("btn-start-update");
  btn.disabled = true;
  btn.textContent = "Baixando...";

  const progressWrap = document.getElementById("update-progress-wrap");
  const progressBar = document.getElementById("update-progress-bar");
  const progressLabel = document.getElementById("update-progress-label");
  if (progressWrap) progressWrap.style.display = "block";

  try {
    const res = await fetch("/api/updater/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ download_url: pendingUpdate.download_url })
    });
    const d = await res.json();
    if (!d.success && d.message !== "Download já em andamento.") {
      showToast(d.message, "error");
      btn.disabled = false;
      btn.textContent = "Atualizar Agora";
      return;
    }

    // Poll download status
    if (updatePollTimer) clearInterval(updatePollTimer);
    updatePollTimer = setInterval(async () => {
      try {
        const sRes = await fetch("/api/updater/status");
        const st = await sRes.json();

        if (st.status === "downloading") {
          const pct = st.percent || 0;
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (progressLabel) progressLabel.textContent = `Baixando... ${pct}%`;
        } else if (st.status === "ready") {
          clearInterval(updatePollTimer);
          if (progressBar) progressBar.style.width = "100%";
          if (progressLabel) progressLabel.textContent = "Instalação pronta! Iniciando...";
          showToast("Download concluído! Iniciando o instalador...", "success");

          // Apply update
          setTimeout(async () => {
            await fetch("/api/updater/apply", { method: "POST" });
          }, 800);
        } else if (st.status === "error") {
          clearInterval(updatePollTimer);
          showToast(`Erro ao baixar atualização: ${st.error_message || "Falha na conexão"}`, "error");
          btn.disabled = false;
          btn.textContent = "Tentar Novamente";
        }
      } catch (e) {
        clearInterval(updatePollTimer);
      }
    }, 600);
  } catch (e) {
    showToast("Erro ao iniciar download da atualização.", "error");
    btn.disabled = false;
    btn.textContent = "Atualizar Agora";
  }
}
