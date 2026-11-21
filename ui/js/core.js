// State
const HISTORY_LEN = 90;
const cpuHistory = [];
const ramHistory = [];
const gpuHistory = [];
const batHistory = [];
let currentProcesses = [];
let currentPrograms = [];
let hardwareSpecsData = null;
let lastLargeFiles = [];
let lastDupGroups = [];
let lastJunkScan = null;
let isAdmin = null; // null until the first metrics poll answers

const TAB_TITLES = {
  "tab-dashboard": ["Painel", "Saúde do PC em tempo real"],
  "tab-games": ["Central Gamer & FPS", "Monitor ao vivo de telemetria, taxa de quadros e ferramentas gamer"],
  "tab-peripherals": ["Testes de Periféricos", "Mouse, teclado, controle, monitor e áudio em tempo real"],
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

  if (tabId !== "tab-peripherals" && typeof onPeripheralsTabLeave === "function") {
    onPeripheralsTabLeave();
  }

  // Lazy load tab data when switching
  if (tabId === "tab-optimizer") {
    loadWindowsTweaks();
    testPingOnly();
    pollGameBoosterStatus();
    loadBenchmarkData();
  } else if (tabId === "tab-games") {
    pollGamerTelemetry();
    loadGamerTweaks();
    const mon = document.getElementById("sub-gamer-monitor");
    if (!mon || mon.style.display === "none") {
      loadGames();
    }
  } else if (tabId === "tab-peripherals") {
    if (typeof onPeripheralsTabEnter === "function") onPeripheralsTabEnter();
  } else if (tabId === "tab-manager") {
    loadProcesses();
  } else if (tabId === "tab-repair") {
    loadHardwareSpecs();
    loadBatteryHealth();
    loadHistoryStats();
  }
}

function switchPeripheralsSubTab(subId, btnEl) {
  ["sub-periph-mouse", "sub-periph-keyboard", "sub-periph-gamepad", "sub-periph-display-audio"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === subId ? "block" : "none";
  });
  document.querySelectorAll("#tab-peripherals .sub-nav-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  if (typeof onPeripheralsSubTabChange === "function") {
    onPeripheralsSubTabChange(subId);
  }
}

function switchGamesSubTab(subId, btnEl) {
  ["sub-gamer-monitor", "sub-fps-estimator"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === subId ? "block" : "none";
  });
  if (btnEl && btnEl.parentElement) {
    btnEl.parentElement.querySelectorAll(".sub-nav-btn").forEach(b => b.classList.remove("active"));
    btnEl.classList.add("active");
  }

  if (subId === "sub-gamer-monitor") {
    pollGamerTelemetry();
    loadGamerTweaks();
  } else if (subId === "sub-fps-estimator") {
    loadGames();
  }
}

function switchManagerSubTab(subId, btnEl) {
  ["sub-processes", "sub-startup", "sub-programs", "sub-upgrades"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === subId ? "block" : "none";
  });
  document.querySelectorAll("#tab-manager .sub-nav-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");

  if (subId === "sub-processes") loadProcesses();
  if (subId === "sub-startup") loadStartupItems();
  if (subId === "sub-programs") loadInstalledPrograms();
  if (subId === "sub-upgrades") loadSoftwareUpdates();
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 14;
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));

  // Subtle radial outer tick ring for precision gauge look
  const totalTicks = 40;
  for (let i = 0; i < totalTicks; i++) {
    const ang = -Math.PI / 2 + (i / totalTicks) * Math.PI * 2;
    const activeTick = (i / totalTicks) * 100 <= clamped;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * (r + 9), cy + Math.sin(ang) * (r + 9));
    ctx.lineTo(cx + Math.cos(ang) * (r + 12), cy + Math.sin(ang) * (r + 12));
    ctx.strokeStyle = activeTick
      ? (clamped < 55 ? cssVar("--bad") : clamped < 75 ? cssVar("--warn") : "rgba(155, 226, 45, 0.72)")
      : "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  let strokeColor = cssVar("--bad");
  if (clamped >= 75) {
    const grad = ctx.createLinearGradient(0, h, w, 0);
    grad.addColorStop(0, cssVar("--cyan") || "#38BDF8");
    grad.addColorStop(1, cssVar("--lime") || "#9BE22D");
    strokeColor = grad;
  } else if (clamped >= 55) {
    strokeColor = cssVar("--warn");
  }
  drawArc(ctx, cx, cy, r, 13, clamped, strokeColor, cssVar("--track"));
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

  plot(ramHistory, cssVar("--cyan") || cssVar("--ram-line") || "#38BDF8", 2.0, false, false);
  plot(cpuHistory, cssVar("--lime"), 2.4, true, true);
}

// Lightweight inline sparkline for Hero KPI tiles
function drawMiniSparkline(canvasId, data, color, maxVal = 100) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data || data.length < 2) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);

  const pad = 2;
  const pts = data.map((v, i) => ({
    x: (i / Math.max(1, data.length - 1)) * (w - pad * 2) + pad,
    y: h - pad - (Math.max(0, Math.min(maxVal, v)) / maxVal) * (h - pad * 2)
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();
  ctx.fillStyle = color.startsWith("#") ? `${color}22` : "rgba(155, 226, 45, 0.14)";
  ctx.fill();
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

let _metricsPollingInFlight = false;


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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if (typeof isKeyboardTesterCapturing === "function" && isKeyboardTesterCapturing()) {
      return;
    }
    e.preventDefault();
    const cmdModal = document.getElementById("cmd-modal-backdrop");
    if (cmdModal && cmdModal.hidden) openCommandPalette();
    else closeCommandPalette();
    return;
  }
  const cmdModal = document.getElementById("cmd-modal-backdrop");
  if (cmdModal && !cmdModal.hidden) {
    handleCommandPaletteKey(e);
    return;
  }
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

// ================= Quick Command Palette (Ctrl+K) =================
const COMMAND_PALETTE_ITEMS = [
  { title: "Painel", desc: "Saúde do PC, CPU, RAM, GPU e discos em tempo real", tag: "Aba", run: () => switchTab("tab-dashboard") },
  { title: "Jogos e FPS", desc: "Monitor gamer ao vivo, frametime, GPU e ping BR", tag: "Aba", run: () => switchTab("tab-games") },
  { title: "Testes de Periféricos", desc: "Mouse, teclado, controle, monitor e áudio", tag: "Aba", run: () => switchTab("tab-peripherals") },
  { title: "Testar Mouse (Polling Rate & Double-Click)", desc: "Medir Hz, clique duplo, tempo de reação e CPS", tag: "Teste", run: () => { switchTab("tab-peripherals"); switchPeripheralsSubTab("sub-periph-mouse", document.getElementById("btn-sub-periph-mouse")); } },
  { title: "Testar Teclado (NKRO & Chattering)", desc: "Layout ABNT2/ANSI, anti-ghosting e duplo disparo", tag: "Teste", run: () => { switchTab("tab-peripherals"); switchPeripheralsSubTab("sub-periph-keyboard", document.getElementById("btn-sub-periph-keyboard")); } },
  { title: "Testar Controle / Gamepad (Stick Drift)", desc: "Analógicos X/Y, gatilhos, botões e vibração", tag: "Teste", run: () => { switchTab("tab-peripherals"); switchPeripheralsSubTab("sub-periph-gamepad", document.getElementById("btn-sub-periph-gamepad")); } },
  { title: "Testar Monitor & Áudio (Dead Pixel / Estéreo)", desc: "Dead pixel em tela cheia, Hz, ghosting, som L/R e mic", tag: "Teste", run: () => { switchTab("tab-peripherals"); switchPeripheralsSubTab("sub-periph-display-audio", document.getElementById("btn-sub-periph-display")); } },
  { title: "Limpeza", desc: "Caches, temporários e resíduos de atualização", tag: "Aba", run: () => switchTab("tab-cleaner") },
  { title: "Arquivos grandes", desc: "Encontrar arquivos que mais consomem espaço", tag: "Aba", run: () => switchTab("tab-large-files") },
  { title: "Duplicados", desc: "Localizar cópias idênticas para liberar disco", tag: "Aba", run: () => switchTab("tab-duplicates") },
  { title: "Otimizar e Turbo", desc: "RAM, energia, rede, benchmark e tweaks do Windows", tag: "Aba", run: () => switchTab("tab-optimizer") },
  { title: "Processos e apps", desc: "Gerenciar processos, inicialização e aplicativos", tag: "Aba", run: () => switchTab("tab-manager") },
  { title: "Reparo e histórico", desc: "SFC/DISM, ficha técnica, bateria e ganhos totais", tag: "Aba", run: () => switchTab("tab-repair") },
  { title: "Otimização rápida (Super Boost)", desc: "Limpar memória e aplicar otimização imediata", tag: "Ação", run: () => typeof runQuickBoost === "function" && runQuickBoost() },
  { title: "Purga de Memória Standby", desc: "Liberar cache standby da RAM sem reiniciar", tag: "Ação", run: () => typeof purgeStandbyListQuick === "function" && purgeStandbyListQuick() },
  { title: "Ativar / Ocultar Overlay HUD", desc: "Alternar barra flutuante gamer no topo da tela", tag: "Ação", run: () => typeof toggleFloatingGamerHUD === "function" && toggleFloatingGamerHUD() },
  { title: "Calculadora & Estimativa de FPS", desc: "Simular FPS estimado por placa de vídeo e CPU", tag: "Gamer", run: () => { switchTab("tab-games"); switchGamesSubTab("sub-fps-estimator", document.getElementById("btn-sub-fps-estimator")); } }
];

let cmdFiltered = COMMAND_PALETTE_ITEMS.slice();
let cmdSelectedIndex = 0;

function renderCommandPaletteList() {
  const listEl = document.getElementById("cmd-palette-list");
  if (!listEl) return;
  if (!cmdFiltered.length) {
    listEl.innerHTML = `<li class="cmd-empty">Nenhum comando encontrado.</li>`;
    return;
  }
  cmdSelectedIndex = Math.max(0, Math.min(cmdSelectedIndex, cmdFiltered.length - 1));
  listEl.innerHTML = cmdFiltered.map((item, idx) => `
    <li class="cmd-item ${idx === cmdSelectedIndex ? "selected" : ""}" data-cmd-idx="${idx}">
      <div>
        <div class="cmd-item-title">${escapeHtml(item.title)}</div>
        <div class="cmd-item-desc">${escapeHtml(item.desc)}</div>
      </div>
      <span class="cmd-item-tag">${escapeHtml(item.tag)}</span>
    </li>
  `).join("");
  listEl.querySelectorAll(".cmd-item").forEach(li => {
    li.addEventListener("click", () => {
      const idx = Number(li.getAttribute("data-cmd-idx"));
      executeCommandItem(idx);
    });
  });
}

function executeCommandItem(idx) {
  const item = cmdFiltered[idx];
  closeCommandPalette();
  if (item && typeof item.run === "function") item.run();
}

function openCommandPalette() {
  const backdrop = document.getElementById("cmd-modal-backdrop");
  const input = document.getElementById("cmd-palette-input");
  if (!backdrop || !input) return;
  cmdFiltered = COMMAND_PALETTE_ITEMS.slice();
  cmdSelectedIndex = 0;
  input.value = "";
  backdrop.hidden = false;
  renderCommandPaletteList();
  setTimeout(() => input.focus(), 10);
}

function closeCommandPalette() {
  const backdrop = document.getElementById("cmd-modal-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function handleCommandPaletteKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (cmdFiltered.length) {
      cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdFiltered.length;
      renderCommandPaletteList();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (cmdFiltered.length) {
      cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFiltered.length) % cmdFiltered.length;
      renderCommandPaletteList();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    executeCommandItem(cmdSelectedIndex);
  }
}

const cmdInputEl = document.getElementById("cmd-palette-input");
if (cmdInputEl) {
  cmdInputEl.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    cmdFiltered = !q
      ? COMMAND_PALETTE_ITEMS.slice()
      : COMMAND_PALETTE_ITEMS.filter(it =>
          it.title.toLowerCase().includes(q) ||
          it.desc.toLowerCase().includes(q) ||
          it.tag.toLowerCase().includes(q)
        );
    cmdSelectedIndex = 0;
    renderCommandPaletteList();
  });
}
const cmdBackdropEl = document.getElementById("cmd-modal-backdrop");
if (cmdBackdropEl) {
  cmdBackdropEl.addEventListener("mousedown", (e) => {
    if (e.target.id === "cmd-modal-backdrop") closeCommandPalette();
  });
}

