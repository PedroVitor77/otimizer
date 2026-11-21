// ================= TESTES DE PERIFÉRICOS =================
// Mouse, Teclado, Controle/Gamepad, Monitor e Áudio (100% client-side)

let peripheralsActiveTab = false;
let peripheralsSubTab = "sub-periph-mouse";

// ---------------- LIFECYCLE ----------------
function onPeripheralsTabEnter() {
  peripheralsActiveTab = true;
  initPeripheralsOnce();
  onPeripheralsSubTabChange(peripheralsSubTab);
}

function onPeripheralsTabLeave() {
  peripheralsActiveTab = false;
  stopGamepadLoop();
  stopMonitorLoop();
  stopMicTest(true);
  exitPixelTest();
  stopTypingTimer();
  if (reactionTimer) {
    clearTimeout(reactionTimer);
    reactionTimer = null;
  }
}

function onPeripheralsSubTabChange(subId) {
  peripheralsSubTab = subId;
  stopGamepadLoop();
  stopMonitorLoop();
  if (subId !== "sub-periph-keyboard") {
    stopTypingTimer();
  }
  if (subId !== "sub-periph-display-audio") {
    stopMicTest(true);
  }
  if (!peripheralsActiveTab) return;

  if (subId === "sub-periph-mouse") {
    drawMousePollingChart();
  } else if (subId === "sub-periph-keyboard") {
    renderKeyboardGrid();
    initTypingGame();
  } else if (subId === "sub-periph-gamepad") {
    ensureGamepadVisualLabels();
    startGamepadLoop();
  } else if (subId === "sub-periph-display-audio") {
    updateMonitorStaticInfo();
    startMonitorLoop();
  }
}

let peripheralsInitialized = false;
function initPeripheralsOnce() {
  if (peripheralsInitialized) return;
  peripheralsInitialized = true;
  bindMouseTester();
  renderKeyboardGrid();
  initTypingGame();
  ensureGamepadVisualLabels();
  updateMonitorStaticInfo();
}

// =========================================================================
// 1. MOUSE TESTER (Buttons, Double-Click, Polling Rate, Reaction, CPS)
// =========================================================================
const MOUSE_DC_THRESHOLD_MS = 80;
const mouseBtnCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
const mouseLastDownAt = {};
let mouseScrollUp = 0;
let mouseScrollDown = 0;
let mouseDcAlerts = 0;
const mouseSvgMap = {
  0: "m-svg-left",
  1: "m-svg-middle",
  2: "m-svg-right",
  3: "m-svg-side4",
  4: "m-svg-side5",
};
const mouseBtnNames = {
  0: "Botão Esquerdo (LMB)",
  1: "Botão do Meio (MMB)",
  2: "Botão Direito (RMB)",
  3: "Lateral Voltar (MB4)",
  4: "Lateral Avançar (MB5)",
};

// Polling Rate state
let pollingTimestamps = [];
const pollingHistory = [];
let pollingPeakHz = 0;
let pollingSamplesSum = 0;
let pollingSamplesCount = 0;
let pollingLastDrawAt = 0;
let scrollFlashTimer = null;

function bindMouseTester() {
  const pad = document.getElementById("mouse-test-pad");
  const pollZone = document.getElementById("mouse-polling-zone");
  if (pad) {
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
    pad.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const b = e.button;
      const now = performance.now();
      if (mouseBtnCounts[b] === undefined) mouseBtnCounts[b] = 0;
      mouseBtnCounts[b] += 1;

      const cntEl = document.getElementById(`m-cnt-${b}`);
      if (cntEl) cntEl.textContent = String(mouseBtnCounts[b]);
      const chipEl = document.getElementById(`m-stat-${b}`);
      if (chipEl) chipEl.classList.add("active");
      const svgEl = document.getElementById(mouseSvgMap[b]);
      if (svgEl) {
        svgEl.classList.add("active", "tested");
      }

      const prev = mouseLastDownAt[b];
      mouseLastDownAt[b] = now;
      const intervalEl = document.getElementById("mouse-last-interval");
      const titleEl = document.getElementById("mouse-pad-title");
      const detailEl = document.getElementById("mouse-pad-detail");
      const dcBadge = document.getElementById("mouse-dc-badge");

      if (titleEl) titleEl.textContent = mouseBtnNames[b] || `Botão ${b}`;

      if (prev !== undefined) {
        const delta = now - prev;
        if (intervalEl) intervalEl.textContent = `Intervalo: ${delta.toFixed(1)} ms`;
        if (delta > 0 && delta <= MOUSE_DC_THRESHOLD_MS) {
          mouseDcAlerts += 1;
          pad.classList.add("alert-dc");
          if (chipEl) chipEl.classList.add("warn-dc");
          if (dcBadge) {
            dcBadge.textContent = `${mouseDcAlerts} double-click${mouseDcAlerts > 1 ? "s" : ""} suspeito${mouseDcAlerts > 1 ? "s" : ""}`;
            dcBadge.className = "badge badge-amber";
          }
          if (detailEl) detailEl.textContent = `Alerta: clique duplo rápido detectado (${delta.toFixed(1)} ms) no ${mouseBtnNames[b] || "botão"}!`;
        } else {
          pad.classList.remove("alert-dc");
          if (detailEl) detailEl.textContent = `Switch normal — intervalo de ${delta.toFixed(0)} ms`;
        }
      } else {
        if (intervalEl) intervalEl.textContent = "Intervalo: primeiro clique";
        if (detailEl) detailEl.textContent = "Clique novamente para medir o intervalo entre cliques";
      }
    });

    window.addEventListener("mouseup", (e) => {
      const b = e.button;
      const chipEl = document.getElementById(`m-stat-${b}`);
      if (chipEl) chipEl.classList.remove("active");
      const svgEl = document.getElementById(mouseSvgMap[b]);
      if (svgEl) svgEl.classList.remove("active");
    });

    pad.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.deltaY < 0) mouseScrollUp += 1;
      else if (e.deltaY > 0) mouseScrollDown += 1;
      const cntEl = document.getElementById("m-cnt-scroll");
      if (cntEl) cntEl.textContent = `${mouseScrollUp} / ${mouseScrollDown}`;

      const upEl = document.getElementById("m-svg-scroll-up");
      const dnEl = document.getElementById("m-svg-scroll-down");
      const statEl = document.getElementById("m-stat-scroll");
      if (upEl) upEl.classList.toggle("active", e.deltaY < 0);
      if (dnEl) dnEl.classList.toggle("active", e.deltaY > 0);
      if (e.deltaY < 0 && upEl) upEl.classList.add("tested");
      if (e.deltaY > 0 && dnEl) dnEl.classList.add("tested");
      if (statEl) statEl.classList.add("active");

      const titleEl = document.getElementById("mouse-pad-title");
      if (titleEl) titleEl.textContent = e.deltaY < 0 ? "Scroll para Cima ↑" : "Scroll para Baixo ↓";
      clearTimeout(scrollFlashTimer);
      scrollFlashTimer = setTimeout(() => {
        if (upEl) upEl.classList.remove("active");
        if (dnEl) dnEl.classList.remove("active");
        if (statEl) statEl.classList.remove("active");
      }, 140);
    }, { passive: false });
  }

  if (pollZone) {
    pollZone.addEventListener("pointermove", (e) => {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      const list = events && events.length ? events : [e];
      const now = performance.now();
      for (let i = 0; i < list.length; i++) {
        pollingTimestamps.push(list[i].timeStamp || now);
      }
      const cutoff = (list[list.length - 1].timeStamp || now) - 1000;
      while (pollingTimestamps.length && pollingTimestamps[0] < cutoff) {
        pollingTimestamps.shift();
      }
      const hz = pollingTimestamps.length;
      if (hz > pollingPeakHz) pollingPeakHz = hz;
      if (hz >= 20) {
        pollingSamplesSum += hz;
        pollingSamplesCount += 1;
      }

      if (now - pollingLastDrawAt >= 65) {
        pollingLastDrawAt = now;
        pollingHistory.push(hz);
        if (pollingHistory.length > 60) pollingHistory.shift();
        updatePollingUi(hz);
        drawMousePollingChart();
      }
    });
  }
}

function updatePollingUi(hz) {
  const curEl = document.getElementById("mouse-hz-current");
  const peakEl = document.getElementById("mouse-hz-peak");
  const avgEl = document.getElementById("mouse-hz-avg");
  const tierEl = document.getElementById("mouse-polling-tier");
  if (curEl) curEl.textContent = String(hz);
  if (peakEl) peakEl.textContent = `${pollingPeakHz} Hz`;
  const avg = pollingSamplesCount ? Math.round(pollingSamplesSum / pollingSamplesCount) : 0;
  if (avgEl) avgEl.textContent = `${avg} Hz`;

  if (tierEl) {
    if (pollingPeakHz >= 1800) {
      tierEl.textContent = "Ultra (2000+ Hz)";
      tierEl.className = "badge badge-green";
    } else if (pollingPeakHz >= 850) {
      tierEl.textContent = "Gamer (1000 Hz)";
      tierEl.className = "badge badge-green";
    } else if (pollingPeakHz >= 400) {
      tierEl.textContent = "Rápido (500 Hz)";
      tierEl.className = "badge badge-cyan";
    } else if (pollingPeakHz >= 100) {
      tierEl.textContent = "Padrão (125–250 Hz)";
      tierEl.className = "badge badge-amber";
    } else {
      tierEl.textContent = "Mova o mouse";
      tierEl.className = "badge badge-cyan";
    }
  }
}

function drawMousePollingChart() {
  const canvas = document.getElementById("mousePollingCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);

  const maxHz = Math.max(1000, pollingPeakHz * 1.15);
  // Guide lines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(frac => {
    const y = h * frac;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  });

  if (pollingHistory.length < 2) {
    ctx.fillStyle = "rgba(167, 178, 172, 0.65)";
    ctx.font = "600 12px Manrope, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Mova o cursor em círculos aqui para medir o Polling Rate (Hz)", w / 2, h / 2 + 4);
    return;
  }

  const pts = pollingHistory.map((v, i) => ({
    x: (i / Math.max(1, pollingHistory.length - 1)) * (w - 8) + 4,
    y: h - 6 - (Math.min(maxHz, v) / maxHz) * (h - 14),
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = cssVar("--lime") || "#9BE22D";
  ctx.lineWidth = 2.2;
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

function resetMouseTest() {
  Object.keys(mouseBtnCounts).forEach(k => {
    mouseBtnCounts[k] = 0;
    const cntEl = document.getElementById(`m-cnt-${k}`);
    if (cntEl) cntEl.textContent = "0";
    const chipEl = document.getElementById(`m-stat-${k}`);
    if (chipEl) chipEl.classList.remove("active", "warn-dc");
  });
  Object.keys(mouseLastDownAt).forEach(k => delete mouseLastDownAt[k]);
  mouseScrollUp = 0;
  mouseScrollDown = 0;
  mouseDcAlerts = 0;
  pollingTimestamps = [];
  pollingHistory.length = 0;
  pollingPeakHz = 0;
  pollingSamplesSum = 0;
  pollingSamplesCount = 0;

  document.querySelectorAll(".mouse-diagram .m-part").forEach(el => el.classList.remove("active", "tested"));
  const pad = document.getElementById("mouse-test-pad");
  if (pad) pad.classList.remove("alert-dc");
  const scEl = document.getElementById("m-cnt-scroll");
  if (scEl) scEl.textContent = "0 / 0";
  const intEl = document.getElementById("mouse-last-interval");
  if (intEl) intEl.textContent = "Intervalo: -- ms";
  const dcEl = document.getElementById("mouse-dc-badge");
  if (dcEl) {
    dcEl.textContent = "0 double-clicks suspeitos";
    dcEl.className = "badge badge-green";
  }
  const titleEl = document.getElementById("mouse-pad-title");
  if (titleEl) titleEl.textContent = "Clique e role o scroll aqui";
  const detEl = document.getElementById("mouse-pad-detail");
  if (detEl) detEl.textContent = "Testa LMB, RMB, Meio, Laterais (MB4/MB5) e Scroll";
  updatePollingUi(0);
  drawMousePollingChart();
}

// Reaction Time Tester
let reactionState = "idle"; // idle | waiting | ready
let reactionTimer = null;
let reactionStartAt = 0;
const reactionScores = [];

function handleReactionClick() {
  const pad = document.getElementById("reaction-pad");
  const title = document.getElementById("reaction-pad-title");
  const sub = document.getElementById("reaction-pad-sub");
  if (!pad || !title || !sub) return;

  if (reactionState === "idle") {
    reactionState = "waiting";
    pad.className = "reaction-pad waiting";
    title.textContent = "Aguarde o verde...";
    sub.textContent = "Não clique antes da cor mudar!";
    const delay = 1400 + Math.random() * 2400;
    reactionTimer = setTimeout(() => {
      reactionState = "ready";
      reactionStartAt = performance.now();
      pad.className = "reaction-pad ready";
      title.textContent = "CLIQUE AGORA!";
      sub.textContent = "Reaja o mais rápido possível";
    }, delay);
  } else if (reactionState === "waiting") {
    clearTimeout(reactionTimer);
    reactionTimer = null;
    reactionState = "idle";
    pad.className = "reaction-pad";
    title.textContent = "Muito cedo!";
    sub.textContent = "Você clicou antes da luz verde. Clique para tentar de novo.";
  } else if (reactionState === "ready") {
    const ms = Math.round(performance.now() - reactionStartAt);
    reactionState = "idle";
    pad.className = "reaction-pad";
    reactionScores.push(ms);
    if (reactionScores.length > 5) reactionScores.shift();
    const best = Math.min(...reactionScores);
    const avg = Math.round(reactionScores.reduce((a, b) => a + b, 0) / reactionScores.length);
    const bestEl = document.getElementById("reaction-best");
    const avgEl = document.getElementById("reaction-avg");
    if (bestEl) bestEl.textContent = `${best} ms`;
    if (avgEl) avgEl.textContent = `${avg} ms`;
    const rating = ms < 190 ? "Reflexo Pro!" : ms < 250 ? "Muito rápido" : ms < 320 ? "Bom" : "Normal";
    title.textContent = `${ms} ms`;
    sub.textContent = `${rating} — clique novamente para outra rodada`;
  }
}

// CPS Tester (5 seconds)
let cpsRunning = false;
let cpsCooldownUntil = 0;
let cpsClicks = 0;
let cpsEndAt = 0;
let cpsBest = 0;
let cpsInterval = null;

function handleCpsMouseDown(e) {
  if (e && e.button !== 0) return;
  const now = performance.now();
  if (!cpsRunning && now < cpsCooldownUntil) return;

  const pad = document.getElementById("cps-pad");
  const title = document.getElementById("cps-pad-title");
  const sub = document.getElementById("cps-pad-sub");

  if (!cpsRunning) {
    cpsRunning = true;
    cpsClicks = 1;
    cpsEndAt = now + 5000;
    if (pad) pad.className = "reaction-pad ready";
    if (title) title.textContent = "1 clique";
    if (sub) sub.textContent = "Tempo restante: 5.0s";
    clearInterval(cpsInterval);
    cpsInterval = setInterval(() => {
      const rem = (cpsEndAt - performance.now()) / 1000;
      if (rem <= 0) {
        clearInterval(cpsInterval);
        cpsRunning = false;
        cpsCooldownUntil = performance.now() + 900;
        const finalCps = +(cpsClicks / 5).toFixed(1);
        if (finalCps > cpsBest) {
          cpsBest = finalCps;
          const bestEl = document.getElementById("cps-best");
          if (bestEl) bestEl.textContent = `${cpsBest.toFixed(1)} CPS`;
        }
        if (pad) pad.className = "reaction-pad";
        if (title) title.textContent = `${finalCps.toFixed(1)} CPS`;
        if (sub) sub.textContent = `${cpsClicks} cliques em 5s — clique para repetir`;
      } else {
        const curCps = (cpsClicks / Math.max(0.1, 5 - rem)).toFixed(1);
        if (title) title.textContent = `${cpsClicks} cliques (${curCps} CPS)`;
        if (sub) sub.textContent = `Tempo restante: ${rem.toFixed(1)}s`;
      }
    }, 60);
  } else {
    cpsClicks += 1;
    if (title) title.textContent = `${cpsClicks} cliques`;
  }
}

// =========================================================================
// 2. KEYBOARD TESTER (ABNT2 / ANSI, NKRO, Chattering)
// =========================================================================
let kbLayoutMode = "abnt2";
let kbCaptureEnabled = true;
const kbPressedCodes = new Set();
const kbTestedCodes = new Set();
const kbLastUpAt = new Map();
const kbHistory = [];
let kbPeakNkro = 0;
let kbChatterCount = 0;
let kbTotalMapKeys = 0;

function getKeyboardRows(layout) {
  const isAbnt = layout === "abnt2";
  const main = [
    [
      { code: "Escape", label: "ESC" },
      { code: "F1", label: "F1" }, { code: "F2", label: "F2" }, { code: "F3", label: "F3" }, { code: "F4", label: "F4" },
      { code: "F5", label: "F5" }, { code: "F6", label: "F6" }, { code: "F7", label: "F7" }, { code: "F8", label: "F8" },
      { code: "F9", label: "F9" }, { code: "F10", label: "F10" }, { code: "F11", label: "F11" }, { code: "F12", label: "F12" },
    ],
    [
      { code: "Backquote", label: isAbnt ? "'" : "`" },
      { code: "Digit1", label: "1" }, { code: "Digit2", label: "2" }, { code: "Digit3", label: "3" },
      { code: "Digit4", label: "4" }, { code: "Digit5", label: "5" }, { code: "Digit6", label: "6" },
      { code: "Digit7", label: "7" }, { code: "Digit8", label: "8" }, { code: "Digit9", label: "9" },
      { code: "Digit0", label: "0" }, { code: "Minus", label: "-" }, { code: "Equal", label: "=" },
      { code: "Backspace", label: "BKSP", cls: "w-2" },
    ],
    [
      { code: "Tab", label: "TAB", cls: "w-15" },
      { code: "KeyQ", label: "Q" }, { code: "KeyW", label: "W" }, { code: "KeyE", label: "E" },
      { code: "KeyR", label: "R" }, { code: "KeyT", label: "T" }, { code: "KeyY", label: "Y" },
      { code: "KeyU", label: "U" }, { code: "KeyI", label: "I" }, { code: "KeyO", label: "O" },
      { code: "KeyP", label: "P" },
      { code: "BracketLeft", label: isAbnt ? "´" : "[" },
      { code: "BracketRight", label: isAbnt ? "[" : "]" },
      { code: "Backslash", label: isAbnt ? "]" : "\\", cls: "w-15" },
    ],
    [
      { code: "CapsLock", label: "CAPS", cls: "w-175" },
      { code: "KeyA", label: "A" }, { code: "KeyS", label: "S" }, { code: "KeyD", label: "D" },
      { code: "KeyF", label: "F" }, { code: "KeyG", label: "G" }, { code: "KeyH", label: "H" },
      { code: "KeyJ", label: "J" }, { code: "KeyK", label: "K" }, { code: "KeyL", label: "L" },
      { code: "Semicolon", label: isAbnt ? "Ç" : ";" },
      { code: "Quote", label: isAbnt ? "~" : "'" },
      { code: "Enter", label: "ENTER", cls: "w-225" },
    ],
    isAbnt
      ? [
          { code: "ShiftLeft", label: "SHIFT", cls: "w-125" },
          { code: "IntlBackslash", label: "\\" },
          { code: "KeyZ", label: "Z" }, { code: "KeyX", label: "X" }, { code: "KeyC", label: "C" },
          { code: "KeyV", label: "V" }, { code: "KeyB", label: "B" }, { code: "KeyN", label: "N" },
          { code: "KeyM", label: "M" }, { code: "Comma", label: "," }, { code: "Period", label: "." },
          { code: "Slash", label: ";" }, { code: "IntlRo", label: "/" },
          { code: "ShiftRight", label: "SHIFT", cls: "w-175" },
        ]
      : [
          { code: "ShiftLeft", label: "SHIFT", cls: "w-225" },
          { code: "KeyZ", label: "Z" }, { code: "KeyX", label: "X" }, { code: "KeyC", label: "C" },
          { code: "KeyV", label: "V" }, { code: "KeyB", label: "B" }, { code: "KeyN", label: "N" },
          { code: "KeyM", label: "M" }, { code: "Comma", label: "," }, { code: "Period", label: "." },
          { code: "Slash", label: "/" },
          { code: "ShiftRight", label: "SHIFT", cls: "w-275" },
        ],
    [
      { code: "ControlLeft", label: "CTRL", cls: "w-125" },
      { code: "MetaLeft", label: "WIN", cls: "w-125" },
      { code: "AltLeft", label: "ALT", cls: "w-125" },
      { code: "Space", label: "ESPAÇO", cls: "w-6" },
      { code: "AltRight", label: isAbnt ? "ALTGR" : "ALT", cls: "w-125" },
      { code: "ContextMenu", label: "MENU", cls: "w-125" },
      { code: "ControlRight", label: "CTRL", cls: "w-125" },
    ],
  ];

  const nav = [
    [{ code: "PrintScreen", label: "PRT" }, { code: "ScrollLock", label: "SCR" }, { code: "Pause", label: "PAU" }],
    [{ code: "Insert", label: "INS" }, { code: "Home", label: "HOM" }, { code: "PageUp", label: "PGU" }],
    [{ code: "Delete", label: "DEL" }, { code: "End", label: "END" }, { code: "PageDown", label: "PGD" }],
    [{ spacer: true }, { spacer: true }, { spacer: true }],
    [{ spacer: true }, { code: "ArrowUp", label: "↑" }, { spacer: true }],
    [{ code: "ArrowLeft", label: "←" }, { code: "ArrowDown", label: "↓" }, { code: "ArrowRight", label: "→" }],
  ];

  return { main, nav };
}

function renderKeyboardGrid() {
  const container = document.getElementById("kb-visual-grid");
  if (!container) return;
  const { main, nav } = getKeyboardRows(kbLayoutMode);
  const renderRows = (rows) =>
    rows.map(row =>
      `<div class="kb-row">${row.map(k => {
        if (k.spacer) return `<div class="kb-key spacer"></div>`;
        const cls = ["kb-key", k.cls || ""];
        if (kbTestedCodes.has(k.code)) cls.push("tested");
        if (kbPressedCodes.has(k.code)) cls.push("active");
        return `<div class="${cls.join(" ").trim()}" data-code="${escapeHtml(k.code)}">${escapeHtml(k.label)}</div>`;
      }).join("")}</div>`
    ).join("");

  container.innerHTML = `
    <div class="kb-main">${renderRows(main)}</div>
    <div class="kb-nav-col">${renderRows(nav)}</div>
  `;
  kbTotalMapKeys = container.querySelectorAll(".kb-key[data-code]").length;
  updateKeyboardStats();
}

function setKeyboardLayout(mode, btnEl) {
  kbLayoutMode = mode;
  document.querySelectorAll("#sub-periph-keyboard .seg-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  renderKeyboardGrid();
}

function toggleKeyboardCapture() {
  kbCaptureEnabled = !kbCaptureEnabled;
  const btn = document.getElementById("btn-kb-capture");
  if (btn) btn.textContent = kbCaptureEnabled ? "🔒 Captura: Ativa" : "🔓 Captura: Livre";
}

function isKeyboardTesterCapturing() {
  const cmdModal = document.getElementById("cmd-modal-backdrop");
  const modalOpen = cmdModal && !cmdModal.hidden;
  const confirmBackdrop = document.getElementById("modal-backdrop");
  const confirmOpen = confirmBackdrop && !confirmBackdrop.hidden;
  const typingFocused = document.activeElement && document.activeElement.id === "typing-hidden-input";
  return peripheralsActiveTab && peripheralsSubTab === "sub-periph-keyboard" && kbCaptureEnabled && !modalOpen && !confirmOpen && !typingFocused;
}

function updateKeyboardStats() {
  const actEl = document.getElementById("kb-active-count");
  const peakEl = document.getElementById("kb-peak-nkro");
  const testedEl = document.getElementById("kb-tested-count");
  const chatEl = document.getElementById("kb-chatter-count");
  if (actEl) actEl.textContent = String(kbPressedCodes.size);
  if (peakEl) peakEl.textContent = String(kbPeakNkro);
  if (testedEl) testedEl.textContent = `${kbTestedCodes.size} / ${kbTotalMapKeys}`;
  if (chatEl) {
    chatEl.textContent = String(kbChatterCount);
    chatEl.style.color = kbChatterCount > 0 ? "var(--bad)" : "var(--lime)";
  }
}

function resetKeyboardTest() {
  kbPressedCodes.clear();
  kbTestedCodes.clear();
  kbLastUpAt.clear();
  kbHistory.length = 0;
  kbPeakNkro = 0;
  kbChatterCount = 0;
  renderKeyboardGrid();
  const lastKey = document.getElementById("kb-last-key");
  const lastCode = document.getElementById("kb-last-code");
  const chatDet = document.getElementById("kb-chatter-detail");
  const histEl = document.getElementById("kb-history-strip");
  if (lastKey) lastKey.textContent = "--";
  if (lastCode) lastCode.textContent = "code: --";
  if (chatDet) chatDet.textContent = "Sem duplo disparo";
  if (histEl) histEl.innerHTML = `<span class="kb-pill">Pressione qualquer tecla para iniciar...</span>`;
}

window.addEventListener("keydown", (e) => {
  // Handle fullscreen pixel overlay keyboard navigation first
  const pxOverlay = document.getElementById("pixel-test-overlay");
  if (pxOverlay && !pxOverlay.hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      exitPixelTest();
    } else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
      e.preventDefault();
      nextPixelTestColor();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevPixelTestColor();
    }
    return;
  }

  if (!peripheralsActiveTab || peripheralsSubTab !== "sub-periph-keyboard") return;
  const cmdModal = document.getElementById("cmd-modal-backdrop");
  if (cmdModal && !cmdModal.hidden) return;

  const typingFocused = document.activeElement && document.activeElement.id === "typing-hidden-input";
  if (typingFocused && e.key === "Escape") {
    document.activeElement.blur();
    return;
  }
  if (kbCaptureEnabled && !typingFocused) e.preventDefault();

  const code = e.code || e.key;
  const now = performance.now();

  if (!e.repeat && kbLastUpAt.has(code)) {
    const gap = now - kbLastUpAt.get(code);
    if (gap > 0 && gap < 45) {
      kbChatterCount += 1;
      const keyEl = document.querySelector(`.kb-key[data-code="${CSS.escape(code)}"]`);
      if (keyEl) keyEl.classList.add("chatter");
      const chatDet = document.getElementById("kb-chatter-detail");
      if (chatDet) chatDet.textContent = `Suspeito em ${code} (${gap.toFixed(0)} ms)`;
    }
  }

  kbPressedCodes.add(code);
  kbTestedCodes.add(code);
  if (kbPressedCodes.size > kbPeakNkro) kbPeakNkro = kbPressedCodes.size;

  const keyEl = document.querySelector(`.kb-key[data-code="${CSS.escape(code)}"]`);
  if (keyEl) keyEl.classList.add("active", "tested");

  const label = e.key === " " ? "ESPAÇO" : e.key;
  const lastKey = document.getElementById("kb-last-key");
  const lastCode = document.getElementById("kb-last-code");
  if (lastKey) lastKey.textContent = label;
  if (lastCode) lastCode.textContent = `code: ${code}`;

  if (!e.repeat) {
    kbHistory.unshift(label);
    if (kbHistory.length > 14) kbHistory.pop();
    const histEl = document.getElementById("kb-history-strip");
    if (histEl) {
      histEl.innerHTML = kbHistory.map(k => `<span class="kb-pill">${escapeHtml(k)}</span>`).join("");
    }
  }
  updateKeyboardStats();
});

window.addEventListener("keyup", (e) => {
  if (!peripheralsActiveTab || peripheralsSubTab !== "sub-periph-keyboard") return;
  const code = e.code || e.key;
  kbPressedCodes.delete(code);
  kbLastUpAt.set(code, performance.now());
  const keyEl = document.querySelector(`.kb-key[data-code="${CSS.escape(code)}"]`);
  if (keyEl) keyEl.classList.remove("active");
  updateKeyboardStats();
});

window.addEventListener("blur", () => {
  if (!kbPressedCodes.size) return;
  kbPressedCodes.clear();
  document.querySelectorAll(".kb-key.active").forEach(el => el.classList.remove("active"));
  updateKeyboardStats();
});

// =========================================================================
// 2B. TYPING SPEED MINIGAME (WPM / Precisão)
// =========================================================================
const TYPING_WORDS_POOL = [
  "velocidade", "teclado", "sistema", "monitor", "controle", "jogada", "clique",
  "sensor", "tempo", "turbo", "quadro", "disco", "rede", "atalho", "ritmo",
  "motor", "sinal", "linha", "ponto", "chave", "mundo", "texto", "letra",
  "campo", "alvo", "fluido", "limpo", "ativo", "foco", "pulso", "frente",
  "passo", "brilho", "escudo", "estrela", "caminho", "nuvem", "bateria",
  "janela", "mouse", "porta", "tela", "som", "energia", "resposta", "processo",
  "gamer", "placa", "dados", "cabo", "fonte", "modo", "perfil", "fluxo",
  "barra", "toque", "teste", "faixa", "efeito", "plano", "salto", "curva"
];

let typingDurationSec = 30;
let typingWords = [];
let typingWordStates = []; // null | "ok" | "err"
let typingCurrentIdx = 0;
let typingStarted = false;
let typingFinished = false;
let typingStartTime = 0;
let typingTimerId = null;
let typingCorrectChars = 0;
let typingTotalChars = 0;
let typingCorrectWords = 0;
let typingCombo = 0;
let typingMaxCombo = 0;
let typingBestWpm = 0;
let typingBound = false;

function initTypingGame() {
  try {
    const saved = Number(localStorage.getItem("pulsepc_typing_best_wpm") || 0);
    if (Number.isFinite(saved) && saved > typingBestWpm) typingBestWpm = saved;
  } catch (e) {}

  if (!typingBound) {
    typingBound = true;
    const inp = document.getElementById("typing-hidden-input");
    const stage = document.getElementById("typing-stage");
    if (inp) {
      inp.addEventListener("focus", () => {
        if (stage) stage.classList.add("typing-focused");
        const hint = document.getElementById("typing-status-hint");
        if (hint && !typingStarted && !typingFinished) {
          hint.textContent = "Pronto! Comece a digitar a primeira palavra — Espaço avança";
        }
      });
      inp.addEventListener("blur", () => {
        if (stage) stage.classList.remove("typing-focused");
        const hint = document.getElementById("typing-status-hint");
        if (hint && !typingFinished) {
          hint.textContent = "Clique aqui para continuar digitando";
        }
      });
      inp.addEventListener("input", handleTypingInput);
    }
  }

  const bestEl = document.getElementById("typing-best");
  if (bestEl) bestEl.textContent = `${typingBestWpm} PPM`;
  if (!typingWords.length) resetTypingGame(false);
}

function generateTypingBatch(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    let pick = TYPING_WORDS_POOL[Math.floor(Math.random() * TYPING_WORDS_POOL.length)];
    if (list.length && pick === list[list.length - 1]) {
      pick = TYPING_WORDS_POOL[(TYPING_WORDS_POOL.indexOf(pick) + 7) % TYPING_WORDS_POOL.length];
    }
    list.push(pick);
  }
  return list;
}

function setTypingDuration(sec, btnEl) {
  typingDurationSec = sec;
  document.querySelectorAll("#typing-dur-seg .seg-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  resetTypingGame(true);
}

function focusTypingGame() {
  const inp = document.getElementById("typing-hidden-input");
  if (inp) inp.focus();
}

function stopTypingTimer() {
  if (typingTimerId) {
    clearInterval(typingTimerId);
    typingTimerId = null;
  }
}

function resetTypingGame(focusAfter) {
  stopTypingTimer();
  typingWords = generateTypingBatch(26);
  typingWordStates = new Array(typingWords.length).fill(null);
  typingCurrentIdx = 0;
  typingStarted = false;
  typingFinished = false;
  typingStartTime = 0;
  typingCorrectChars = 0;
  typingTotalChars = 0;
  typingCorrectWords = 0;
  typingCombo = 0;
  typingMaxCombo = 0;

  const inp = document.getElementById("typing-hidden-input");
  if (inp) {
    inp.value = "";
    inp.disabled = false;
  }
  const banner = document.getElementById("typing-result-banner");
  if (banner) banner.hidden = true;
  const wpmEl = document.getElementById("typing-wpm");
  const accEl = document.getElementById("typing-acc");
  const timerEl = document.getElementById("typing-timer");
  const comboEl = document.getElementById("typing-combo");
  const hintEl = document.getElementById("typing-status-hint");
  if (wpmEl) wpmEl.textContent = "0 PPM";
  if (accEl) accEl.textContent = "100%";
  if (timerEl) timerEl.textContent = `${typingDurationSec}s`;
  if (comboEl) comboEl.textContent = "0";
  if (hintEl) hintEl.textContent = "Clique aqui e comece a digitar para iniciar o cronômetro";

  renderTypingWords("");
  if (focusAfter) focusTypingGame();
}

function handleTypingInput(e) {
  if (typingFinished) return;
  const inp = e.target;
  let val = inp.value;

  if (!typingStarted && val.trim().length > 0) {
    typingStarted = true;
    typingStartTime = performance.now();
    const hint = document.getElementById("typing-status-hint");
    if (hint) hint.textContent = "Digitando... pressione Espaço após cada palavra";
    typingTimerId = setInterval(updateTypingTick, 150);
  }

  // Space submits the current word
  if (val.endsWith(" ")) {
    const typed = val.trim();
    if (!typed.length) {
      inp.value = "";
      renderTypingWords("");
      return;
    }
    const target = typingWords[typingCurrentIdx] || "";
    const isExact = typed === target;
    typingWordStates[typingCurrentIdx] = isExact ? "ok" : "err";

    const maxLen = Math.max(typed.length, target.length);
    for (let i = 0; i < maxLen; i++) {
      typingTotalChars += 1;
      if (typed[i] && typed[i] === target[i]) typingCorrectChars += 1;
    }
    if (isExact) {
      typingCorrectChars += 1; // reward space separator
      typingTotalChars += 1;
      typingCorrectWords += 1;
      typingCombo += 1;
      if (typingCombo > typingMaxCombo) typingMaxCombo = typingCombo;
    } else {
      typingCombo = 0;
    }

    typingCurrentIdx += 1;
    inp.value = "";

    // Replenish word window seamlessly so player never runs out
    if (typingCurrentIdx >= typingWords.length - 8) {
      const more = generateTypingBatch(16);
      typingWords = typingWords.concat(more);
      typingWordStates = typingWordStates.concat(new Array(more.length).fill(null));
    }
    // Keep view clean by trimming old completed words in chunks
    if (typingCurrentIdx >= 14) {
      typingWords = typingWords.slice(8);
      typingWordStates = typingWordStates.slice(8);
      typingCurrentIdx -= 8;
    }

    const comboEl = document.getElementById("typing-combo");
    if (comboEl) comboEl.textContent = String(typingCombo);
    updateTypingStatsDisplay("");
    renderTypingWords("");
    return;
  }

  updateTypingStatsDisplay(val);
  renderTypingWords(val);
}

function updateTypingTick() {
  if (!typingStarted || typingFinished) return;
  const elapsedSec = (performance.now() - typingStartTime) / 1000;
  const rem = Math.max(0, typingDurationSec - elapsedSec);
  const timerEl = document.getElementById("typing-timer");
  if (timerEl) timerEl.textContent = `${Math.ceil(rem)}s`;

  const inp = document.getElementById("typing-hidden-input");
  updateTypingStatsDisplay(inp ? inp.value : "");

  if (rem <= 0) {
    finishTypingGame();
  }
}

function updateTypingStatsDisplay(liveVal) {
  const target = typingWords[typingCurrentIdx] || "";
  let liveOk = 0;
  for (let i = 0; i < liveVal.length; i++) {
    if (liveVal[i] === target[i]) liveOk += 1;
  }
  const totalCorrect = typingCorrectChars + liveOk;
  const totalTyped = typingTotalChars + liveVal.length;
  const elapsedMin = typingStarted ? Math.max(0.02, (performance.now() - typingStartTime) / 60000) : 0;
  const wpm = elapsedMin > 0 ? Math.round((totalCorrect / 5) / elapsedMin) : 0;
  const acc = totalTyped > 0 ? Math.round((totalCorrect / totalTyped) * 100) : 100;

  const wpmEl = document.getElementById("typing-wpm");
  const accEl = document.getElementById("typing-acc");
  if (wpmEl) wpmEl.textContent = `${wpm} PPM`;
  if (accEl) accEl.textContent = `${acc}%`;
  return { wpm, acc };
}

function finishTypingGame() {
  stopTypingTimer();
  typingFinished = true;
  const inp = document.getElementById("typing-hidden-input");
  const finalLive = inp ? inp.value : "";
  if (inp) {
    inp.disabled = true;
    inp.blur();
  }
  const { wpm, acc } = updateTypingStatsDisplay(finalLive);
  if (wpm > typingBestWpm) {
    typingBestWpm = wpm;
    try { localStorage.setItem("pulsepc_typing_best_wpm", String(typingBestWpm)); } catch (e) {}
    const bestEl = document.getElementById("typing-best");
    if (bestEl) bestEl.textContent = `${typingBestWpm} PPM`;
  }

  const banner = document.getElementById("typing-result-banner");
  const head = document.getElementById("typing-result-headline");
  const det = document.getElementById("typing-result-detail");
  const hint = document.getElementById("typing-status-hint");
  if (hint) hint.textContent = "Tempo esgotado! Clique em Nova rodada para jogar novamente.";
  if (head) {
    const rank = wpm >= 85 ? "Digitação Elite!" : wpm >= 60 ? "Muito Rápido!" : wpm >= 40 ? "Ótimo Ritmo!" : "Rodada Concluída!";
    head.textContent = `${rank} ${wpm} PPM (${acc}% de precisão)`;
  }
  if (det) {
    det.textContent = `${typingCorrectWords} palavras certas · Combo máximo: ${typingMaxCombo} · Duração: ${typingDurationSec}s`;
  }
  if (banner) banner.hidden = false;
}

function renderTypingWords(currentTyped) {
  const box = document.getElementById("typing-words");
  if (!box) return;
  const visibleCount = Math.min(typingWords.length, 24);
  const parts = [];
  for (let wIdx = 0; wIdx < visibleCount; wIdx++) {
    const word = typingWords[wIdx];
    const st = typingWordStates[wIdx];
    if (wIdx < typingCurrentIdx) {
      parts.push(`<span class="typing-word ${st === "ok" ? "done-ok" : "done-err"}">${escapeHtml(word)}</span>`);
    } else if (wIdx === typingCurrentIdx) {
      let charsHtml = "";
      for (let i = 0; i < word.length; i++) {
        const ch = escapeHtml(word[i]);
        if (i < currentTyped.length) {
          charsHtml += `<span class="typing-ch ${currentTyped[i] === word[i] ? "ok" : "err"}">${ch}</span>`;
        } else if (i === currentTyped.length) {
          charsHtml += `<span class="typing-ch cur">${ch}</span>`;
        } else {
          charsHtml += `<span class="typing-ch">${ch}</span>`;
        }
      }
      if (currentTyped.length > word.length) {
        charsHtml += `<span class="typing-ch err">${escapeHtml(currentTyped.slice(word.length))}</span>`;
      }
      if (currentTyped.length >= word.length) {
        charsHtml += `<span class="typing-caret-end"></span>`;
      }
      parts.push(`<span class="typing-word active-word">${charsHtml}</span>`);
    } else {
      parts.push(`<span class="typing-word">${escapeHtml(word)}</span>`);
    }
  }
  box.innerHTML = parts.join("");
}

// =========================================================================
// 3. GAMEPAD / CONTROLE TESTER (Interactive SVG Map, Stick Drift, Rumble)
// =========================================================================
const GP_LABELS_BY_STYLE = {
  xbox: ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "VIEW", "MENU", "L3", "R3", "▲", "▼", "◀", "▶", "HOME"],
  ps: ["✕", "○", "□", "△", "L1", "R1", "L2", "R2", "SHARE", "OPT", "L3", "R3", "▲", "▼", "◀", "▶", "PS"],
};
const GP_FRIENDLY_NAMES = {
  xbox: ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View/Select", "Menu/Start", "L3", "R3", "D-Pad Cima", "D-Pad Baixo", "D-Pad Esquerda", "D-Pad Direita", "Xbox/Home"],
  ps: ["Cruz (✕)", "Círculo (○)", "Quadrado (□)", "Triângulo (△)", "L1", "R1", "L2", "R2", "Create/Share", "Options", "L3", "R3", "D-Pad Cima", "D-Pad Baixo", "D-Pad Esquerda", "D-Pad Direita", "Botão PS"],
};
let gpStyleMode = "xbox";
let gpAutoStyleChecked = false;
const gpTestedButtons = new Set();
let gpRafId = null;

function ensureGamepadVisualLabels() {
  const xboxSkin = document.getElementById("gp-skin-xbox");
  const psSkin = document.getElementById("gp-skin-ps");
  if (xboxSkin) xboxSkin.style.display = gpStyleMode === "ps" ? "none" : "inline";
  if (psSkin) psSkin.style.display = gpStyleMode === "ps" ? "inline" : "none";

  // Sync already-tested classes to whichever skin is visible
  const svg = document.getElementById("gp-controller-svg");
  if (svg) {
    for (let i = 0; i < 17; i++) {
      const tested = gpTestedButtons.has(i);
      svg.querySelectorAll(`[data-gp-btn="${i}"]`).forEach(el => {
        if (!el.classList.contains("pressed")) {
          el.classList.toggle("tested", tested);
        }
      });
    }
  }
  updateGamepadTestedBadge();
}

function setGamepadStyle(style, btnEl) {
  gpStyleMode = style === "ps" ? "ps" : "xbox";
  gpAutoStyleChecked = true;
  document.querySelectorAll("#gp-style-seg .seg-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  else {
    const target = document.getElementById(gpStyleMode === "ps" ? "gp-style-ps" : "gp-style-xbox");
    if (target) target.classList.add("active");
  }
  ensureGamepadVisualLabels();
}

function updateGamepadTestedBadge() {
  const badge = document.getElementById("gp-tested-badge");
  if (badge) {
    badge.textContent = `${gpTestedButtons.size} / 17 testados`;
    badge.className = gpTestedButtons.size === 17 ? "badge badge-green" : "badge badge-cyan";
  }
}

function resetGamepadTested() {
  gpTestedButtons.clear();
  const svg = document.getElementById("gp-controller-svg");
  if (svg) {
    svg.querySelectorAll("[data-gp-btn]").forEach(el => el.classList.remove("tested", "pressed"));
    svg.querySelectorAll("[data-gp-lbl]").forEach(el => el.classList.remove("on-pressed"));
  }
  const lastEl = document.getElementById("gp-last-btn-name");
  if (lastEl) lastEl.textContent = "--";
  clearCircularityData();
  updateGamepadTestedBadge();
}

let gpSelectedIndex = null;
let gpLastSelectorSig = "";

function getConnectedGamepads() {
  if (!navigator.getGamepads) return [];
  const pads = navigator.getGamepads();
  const list = [];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i] && pads[i].connected) list.push(pads[i]);
  }
  return list;
}

function detectGamepadSkin(padId) {
  return /dualsense|dualshock|wireless controller|054c|playstation/i.test(padId || "") ? "ps" : "xbox";
}

function selectGamepadIndex(val) {
  const idx = Number(val);
  if (!Number.isFinite(idx)) return;
  gpSelectedIndex = idx;
  resetGamepadTested();
  const gp = getActiveGamepad();
  if (gp) {
    const detected = detectGamepadSkin(gp.id);
    setGamepadStyle(detected, document.getElementById(detected === "ps" ? "gp-style-ps" : "gp-style-xbox"));
  }
}

function syncGamepadSelector(connectedPads) {
  const sel = document.getElementById("gp-device-select");
  if (!sel) return;
  const sig = connectedPads.map(p => `${p.index}:${p.id}`).join("|");
  if (sig === gpLastSelectorSig) {
    if (gpSelectedIndex !== null && sel.value !== String(gpSelectedIndex)) {
      sel.value = String(gpSelectedIndex);
    }
    return;
  }
  gpLastSelectorSig = sig;

  if (!connectedPads.length) {
    sel.style.display = "none";
    sel.innerHTML = "";
    return;
  }

  sel.style.display = "inline-block";
  sel.innerHTML = connectedPads.map((p, pos) => {
    const shortName = (p.id || `Controle ${p.index + 1}`).replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const label = `#${pos + 1} — ${shortName.length > 32 ? shortName.slice(0, 29) + "..." : shortName}`;
    return `<option value="${p.index}">${escapeHtml(label)}</option>`;
  }).join("");
  if (gpSelectedIndex !== null) {
    sel.value = String(gpSelectedIndex);
  }
}

function getActiveGamepad() {
  const connected = getConnectedGamepads();
  if (!connected.length) {
    gpSelectedIndex = null;
    return null;
  }
  const chosen = connected.find(p => p.index === gpSelectedIndex);
  if (chosen) return chosen;
  gpSelectedIndex = connected[0].index;
  return connected[0];
}

const GP_CIRC_BINS = 72;
let gpCircularityActive = false;
const gpCircData = {
  ls: new Float32Array(GP_CIRC_BINS),
  rs: new Float32Array(GP_CIRC_BINS),
};

function clearCircularityData() {
  gpCircData.ls.fill(0);
  gpCircData.rs.fill(0);
  const lsEl = document.getElementById("gp-ls-circ");
  const rsEl = document.getElementById("gp-rs-circ");
  if (lsEl) lsEl.textContent = gpCircularityActive ? "Gire 360°..." : "--";
  if (rsEl) rsEl.textContent = gpCircularityActive ? "Gire 360°..." : "--";
}

function toggleCircularityTest() {
  gpCircularityActive = !gpCircularityActive;
  clearCircularityData();
  const btn = document.getElementById("btn-gp-circ");
  if (btn) {
    if (gpCircularityActive) {
      btn.textContent = "◎ Circularidade: Ativa (Limpar/Parar)";
      btn.classList.remove("btn-secondary");
      btn.classList.add("btn-boost");
    } else {
      btn.textContent = "◎ Testar Circularidade";
      btn.classList.remove("btn-boost");
      btn.classList.add("btn-secondary");
    }
  }
}

function recordCircularitySample(prefix, x, y) {
  if (!gpCircularityActive) return;
  const r = Math.hypot(x, y);
  if (r < 0.65) return; // only sample near the outer rim while spinning
  const angle = Math.atan2(y, x);
  const norm = (angle + Math.PI) / (2 * Math.PI);
  const bin = Math.floor(norm * GP_CIRC_BINS) % GP_CIRC_BINS;
  const arr = gpCircData[prefix];
  if (r > arr[bin]) arr[bin] = r;
}

function computeCircularityAvgError(prefix) {
  const arr = gpCircData[prefix];
  let sumErr = 0;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > 0) {
      sumErr += Math.abs(arr[i] - 1.0) * 100;
      count += 1;
    }
  }
  if (count < 4) return null;
  return sumErr / count;
}

function drawStickCanvas(canvasId, prefix, x, y, avgErr) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 14;

  // Draw circularity trace wedges when Circularity Test is active
  if (gpCircularityActive) {
    const arr = gpCircData[prefix];
    const step = (Math.PI * 2) / GP_CIRC_BINS;
    for (let i = 0; i < GP_CIRC_BINS; i++) {
      const r = arr[i];
      if (r <= 0) continue;
      const a0 = -Math.PI + i * step;
      const a1 = a0 + step + 0.015;
      const drawR = Math.min(1.25, r) * radius;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, drawR, a0, a1);
      ctx.closePath();
      ctx.fillStyle = r > 1.06 ? "rgba(245, 184, 61, 0.42)" : "rgba(56, 189, 248, 0.36)";
      ctx.fill();
    }
  }

  // Ideal unit circle (r = 1.0)
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 10% deadzone ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.12, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(56, 189, 248, 0.35)";
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crosshair
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // Live position vector + dot (preserve direction beyond unit circle up to 1.2)
  const rawR = Math.hypot(x, y);
  const scale = rawR > 1.2 ? 1.2 / rawR : 1;
  const px = cx + x * scale * radius;
  const py = cy + y * scale * radius;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.strokeStyle = "rgba(155, 226, 45, 0.65)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(px, py, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = cssVar("--lime") || "#9BE22D";
  ctx.fill();

  // Overlay Avg Error inside circle during Circularity Test (like hardwaretester.com)
  if (gpCircularityActive && avgErr !== null) {
    ctx.fillStyle = "rgba(8, 10, 12, 0.76)";
    ctx.fillRect(cx - 44, cy + 16, 88, 22);
    ctx.fillStyle = avgErr <= 5 ? "#9BE22D" : avgErr <= 12 ? "#38BDF8" : "#f5b83d";
    ctx.font = "800 11px Manrope, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`Erro: ${avgErr.toFixed(1)}%`, cx, cy + 27);
  }
}

function updateStickMetrics(prefix, x, y, canvasId) {
  recordCircularitySample(prefix, x, y);
  const avgErr = gpCircularityActive ? computeCircularityAvgError(prefix) : null;
  drawStickCanvas(canvasId, prefix, x, y, avgErr);

  const mag = Math.min(100, Math.hypot(x, y) * 100);
  const xEl = document.getElementById(`gp-${prefix}-x`);
  const yEl = document.getElementById(`gp-${prefix}-y`);
  const mEl = document.getElementById(`gp-${prefix}-mag`);
  const cEl = document.getElementById(`gp-${prefix}-circ`);
  const bEl = document.getElementById(`gp-${prefix}-drift-badge`);

  if (xEl) xEl.textContent = x.toFixed(4);
  if (yEl) yEl.textContent = y.toFixed(4);
  if (mEl) mEl.textContent = `${mag.toFixed(1)}%`;
  if (cEl) {
    cEl.textContent = !gpCircularityActive
      ? "--"
      : (avgErr === null ? "Gire 360°..." : `${avgErr.toFixed(1)}%`);
  }
  if (bEl) {
    if (mag <= 5) {
      bEl.textContent = "Centro OK";
      bEl.className = "badge badge-green";
    } else if (mag <= 18) {
      bEl.textContent = "Possível drift";
      bEl.className = "badge badge-amber";
    } else {
      bEl.textContent = "Em movimento";
      bEl.className = "badge badge-cyan";
    }
  }
}

function pollGamepadFrame() {
  if (!peripheralsActiveTab || peripheralsSubTab !== "sub-periph-gamepad") {
    gpRafId = null;
    return;
  }

  const connectedPads = getConnectedGamepads();
  const gp = getActiveGamepad();
  syncGamepadSelector(connectedPads);
  const statusBadge = document.getElementById("gp-status-badge");
  const nameEl = document.getElementById("gp-device-name");
  const rumbleBtn = document.getElementById("btn-gp-rumble");

  if (!gp) {
    if (statusBadge) {
      statusBadge.textContent = "Aguardando controle";
      statusBadge.className = "badge badge-cyan";
    }
    if (nameEl) nameEl.textContent = "Conecte um controle (Xbox, DualSense, DualShock ou genérico) e pressione qualquer botão";
    if (rumbleBtn) rumbleBtn.disabled = true;
    updateStickMetrics("ls", 0, 0, "gamepadStickLeft");
    updateStickMetrics("rs", 0, 0, "gamepadStickRight");
  } else {
    if (!gpAutoStyleChecked) {
      const detected = detectGamepadSkin(gp.id);
      setGamepadStyle(detected, document.getElementById(detected === "ps" ? "gp-style-ps" : "gp-style-xbox"));
      gpAutoStyleChecked = true;
    }

    if (statusBadge) {
      statusBadge.textContent = connectedPads.length > 1 ? `${connectedPads.length} conectados` : "Conectado";
      statusBadge.className = "badge badge-green";
    }
    if (nameEl) nameEl.textContent = gp.id;
    if (rumbleBtn) rumbleBtn.disabled = false;

    const axes = gp.axes || [];
    const lx = axes[0] || 0;
    const ly = axes[1] || 0;
    const rx = axes[2] || 0;
    const ry = axes[3] || 0;
    updateStickMetrics("ls", lx, ly, "gamepadStickLeft");
    updateStickMetrics("rs", rx, ry, "gamepadStickRight");

    const activeSkin = document.getElementById(gpStyleMode === "ps" ? "gp-skin-ps" : "gp-skin-xbox");

    // Animate thumbsticks inside active SVG controller skin
    if (activeSkin) {
      const lsKnob = activeSkin.querySelector('[data-gp-stick="ls"]');
      const rsKnob = activeSkin.querySelector('[data-gp-stick="rs"]');
      if (lsKnob) lsKnob.setAttribute("transform", `translate(${(lx * 11).toFixed(1)}, ${(ly * 11).toFixed(1)})`);
      if (rsKnob) rsKnob.setAttribute("transform", `translate(${(rx * 11).toFixed(1)}, ${(ry * 11).toFixed(1)})`);
    }

    const lt = gp.buttons[6] ? Math.round(gp.buttons[6].value * 100) : 0;
    const rt = gp.buttons[7] ? Math.round(gp.buttons[7].value * 100) : 0;
    const ltVal = document.getElementById("gp-lt-val");
    const rtVal = document.getElementById("gp-rt-val");
    const ltBar = document.getElementById("gp-lt-bar");
    const rtBar = document.getElementById("gp-rt-bar");
    if (ltVal) ltVal.textContent = `${lt}%`;
    if (rtVal) rtVal.textContent = `${rt}%`;
    if (ltBar) ltBar.style.width = `${lt}%`;
    if (rtBar) rtBar.style.width = `${rt}%`;

    const styleLabels = GP_LABELS_BY_STYLE[gpStyleMode] || GP_LABELS_BY_STYLE.xbox;
    const friendlyNames = GP_FRIENDLY_NAMES[gpStyleMode] || GP_FRIENDLY_NAMES.xbox;
    if (activeSkin) {
      const maxTrigH = gpStyleMode === "ps" ? 46 : 50;
      const baseTrigY = gpStyleMode === "ps" ? 58 : 62;
      const ltH = (lt / 100) * maxTrigH;
      const rtH = (rt / 100) * maxTrigH;
      const ltFill = activeSkin.querySelector('[data-gp-trigger-fill="lt"]');
      const rtFill = activeSkin.querySelector('[data-gp-trigger-fill="rt"]');
      const ltSvgLbl = activeSkin.querySelector('[data-gp-trigger-lbl="lt"]');
      const rtSvgLbl = activeSkin.querySelector('[data-gp-trigger-lbl="rt"]');
      if (ltFill) {
        ltFill.setAttribute("height", ltH.toFixed(1));
        ltFill.setAttribute("y", (baseTrigY - ltH).toFixed(1));
      }
      if (rtFill) {
        rtFill.setAttribute("height", rtH.toFixed(1));
        rtFill.setAttribute("y", (baseTrigY - rtH).toFixed(1));
      }
      if (ltSvgLbl) ltSvgLbl.textContent = `${styleLabels[6]} ${lt}%`;
      if (rtSvgLbl) rtSvgLbl.textContent = `${styleLabels[7]} ${rt}%`;
    }

    const prevTestedSize = gpTestedButtons.size;
    for (let i = 0; i < 17; i++) {
      const btnObj = gp.buttons[i];
      const pressed = Boolean(btnObj && (btnObj.pressed || btnObj.value > 0.15));
      if (pressed) {
        gpTestedButtons.add(i);
        const lastEl = document.getElementById("gp-last-btn-name");
        if (lastEl) lastEl.textContent = friendlyNames[i] || `Botão ${i}`;
      }
      if (activeSkin) {
        const el = activeSkin.querySelector(`[data-gp-btn="${i}"]`);
        const lbl = activeSkin.querySelector(`[data-gp-lbl="${i}"]`);
        if (el) {
          el.classList.toggle("pressed", pressed);
          el.classList.toggle("tested", !pressed && gpTestedButtons.has(i));
        }
        if (lbl) lbl.classList.toggle("on-pressed", pressed);
      }
    }
    if (gpTestedButtons.size !== prevTestedSize) {
      updateGamepadTestedBadge();
    }
  }

  gpRafId = requestAnimationFrame(pollGamepadFrame);
}

function startGamepadLoop() {
  if (gpRafId) return;
  gpRafId = requestAnimationFrame(pollGamepadFrame);
}

function stopGamepadLoop() {
  if (gpRafId) {
    cancelAnimationFrame(gpRafId);
    gpRafId = null;
  }
}

async function testGamepadVibration() {
  const gp = getActiveGamepad();
  if (!gp) {
    showToast("Nenhum controle conectado.", "info");
    return;
  }
  const actuator = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
  if (actuator && typeof actuator.playEffect === "function") {
    try {
      await actuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration: 450,
        weakMagnitude: 0.65,
        strongMagnitude: 0.85,
      });
      showToast("Pulso de vibração enviado ao controle!", "success");
      return;
    } catch (e) {
      // Fallback message below
    }
  }
  showToast("Este controle ou navegador não expõe API de vibração.", "info");
}

// =========================================================================
// 4. MONITOR & ÁUDIO TESTER (Hz, Dead Pixel, Ghosting, Stereo, Mic)
// =========================================================================
const PIXEL_TEST_COLORS = [
  { name: "Vermelho", hex: "#ff0000" },
  { name: "Verde", hex: "#00ff00" },
  { name: "Azul", hex: "#0000ff" },
  { name: "Branco", hex: "#ffffff" },
  { name: "Preto", hex: "#000000" },
  { name: "Cinza 50%", hex: "#808080" },
];
let pixelColorIdx = 0;
let monitorRafId = null;
let monitorLastTs = 0;
let monitorFrameCount = 0;
let monitorHzWindowStart = 0;
let ghostingSpeedPx = 960;
let ghostingOffset = 0;

function updateMonitorStaticInfo() {
  const resEl = document.getElementById("mon-res-val");
  const dprEl = document.getElementById("mon-dpr-val");
  const dpr = window.devicePixelRatio || 1;
  if (resEl) {
    const physW = Math.round(window.screen.width * dpr);
    const physH = Math.round(window.screen.height * dpr);
    resEl.textContent = `${window.screen.width} × ${window.screen.height} (Física ~${physW}×${physH})`;
  }
  if (dprEl) dprEl.textContent = `${Math.round(dpr * 100)}% (${dpr.toFixed(2)}x)`;
}

function setGhostingSpeed(pxPerSec, btnEl) {
  ghostingSpeedPx = pxPerSec;
  document.querySelectorAll("#sub-periph-display-audio .seg-btn").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
}

function monitorLoopFrame(ts) {
  if (!peripheralsActiveTab || peripheralsSubTab !== "sub-periph-display-audio") {
    monitorRafId = null;
    return;
  }

  if (!monitorHzWindowStart) monitorHzWindowStart = ts;
  monitorFrameCount += 1;
  const elapsed = ts - monitorHzWindowStart;
  if (elapsed >= 700) {
    const hz = Math.round((monitorFrameCount * 1000) / elapsed);
    const hzEl = document.getElementById("mon-hz-val");
    const badgeEl = document.getElementById("mon-hz-badge");
    if (hzEl) hzEl.textContent = `${hz} Hz`;
    if (badgeEl) badgeEl.textContent = `${hz} Hz ao vivo`;
    monitorFrameCount = 0;
    monitorHzWindowStart = ts;
  }

  const dt = monitorLastTs ? Math.min(0.05, (ts - monitorLastTs) / 1000) : 0.016;
  monitorLastTs = ts;
  drawGhostingStrip(dt);

  monitorRafId = requestAnimationFrame(monitorLoopFrame);
}

function drawGhostingStrip(dt) {
  const canvas = document.getElementById("monitorGhostingCanvas");
  if (!canvas) return;
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;

  const lanes = [
    { bg: "#101418", fg: "#9BE22D", accent: "#ffffff" },
    { bg: "#1e293b", fg: "#38BDF8", accent: "#f8fafc" },
    { bg: "#090b0d", fg: "#f8fafc", accent: "#9BE22D" },
  ];
  const laneH = h / lanes.length;
  const spacing = 190;
  ghostingOffset = (ghostingOffset + ghostingSpeedPx * dt) % spacing;

  lanes.forEach((lane, idx) => {
    const y0 = idx * laneH;
    ctx.fillStyle = lane.bg;
    ctx.fillRect(0, y0, w, laneH);

    for (let x = ghostingOffset - spacing; x < w + spacing; x += spacing) {
      // Crisp high-contrast target block (UFO-like silhouette)
      const by = y0 + 6;
      const bh = laneH - 12;
      ctx.fillStyle = lane.fg;
      ctx.fillRect(x, by, 38, bh);
      ctx.fillStyle = lane.accent;
      ctx.fillRect(x + 15, by + 3, 8, bh - 6);
    }
  });
}

function startMonitorLoop() {
  if (monitorRafId) return;
  monitorLastTs = 0;
  monitorFrameCount = 0;
  monitorHzWindowStart = 0;
  monitorRafId = requestAnimationFrame(monitorLoopFrame);
}

function stopMonitorLoop() {
  if (monitorRafId) {
    cancelAnimationFrame(monitorRafId);
    monitorRafId = null;
  }
}

function applyPixelOverlayColor() {
  const overlay = document.getElementById("pixel-test-overlay");
  const hint = document.getElementById("pixel-test-hint");
  if (!overlay) return;
  const color = PIXEL_TEST_COLORS[pixelColorIdx % PIXEL_TEST_COLORS.length];
  overlay.style.background = color.hex;
  if (hint) {
    hint.textContent = `Cor: ${color.name} (${pixelColorIdx + 1}/${PIXEL_TEST_COLORS.length}) · Clique / Espaço para avançar · ESC para sair`;
  }
}

function startPixelTest(idx = 0) {
  pixelColorIdx = idx;
  const overlay = document.getElementById("pixel-test-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  applyPixelOverlayColor();
  if (overlay.requestFullscreen) {
    overlay.requestFullscreen().catch(() => {});
  }
}

function nextPixelTestColor() {
  pixelColorIdx = (pixelColorIdx + 1) % PIXEL_TEST_COLORS.length;
  applyPixelOverlayColor();
}

function prevPixelTestColor() {
  pixelColorIdx = (pixelColorIdx - 1 + PIXEL_TEST_COLORS.length) % PIXEL_TEST_COLORS.length;
  applyPixelOverlayColor();
}

function exitPixelTest() {
  const overlay = document.getElementById("pixel-test-overlay");
  if (overlay) overlay.hidden = true;
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener("fullscreenchange", () => {
  const overlay = document.getElementById("pixel-test-overlay");
  if (overlay && !overlay.hidden && !document.fullscreenElement) {
    overlay.hidden = true;
  }
});

// Stereo Audio Test (Web Audio API)
let sharedAudioCtx = null;
function playStereoTone(panVal) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      showToast("Web Audio não disponível neste ambiente.", "error");
      return;
    }
    if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
    if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume();

    const now = sharedAudioCtx.currentTime;
    const osc = sharedAudioCtx.createOscillator();
    const gain = sharedAudioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(panVal < 0 ? 440 : panVal > 0 ? 554.37 : 493.88, now);
    osc.frequency.setValueAtTime(panVal < 0 ? 523.25 : panVal > 0 ? 659.25 : 587.33, now + 0.18);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    if (typeof sharedAudioCtx.createStereoPanner === "function") {
      const panner = sharedAudioCtx.createStereoPanner();
      panner.pan.setValueAtTime(panVal, now);
      osc.connect(gain).connect(panner).connect(sharedAudioCtx.destination);
    } else {
      osc.connect(gain).connect(sharedAudioCtx.destination);
    }

    osc.start(now);
    osc.stop(now + 0.48);
  } catch (e) {
    showToast("Não foi possível reproduzir o som de teste.", "error");
  }
}

// Optional Microphone Level Meter
let micStream = null;
let micAudioCtx = null;
let micRafId = null;
let micPeakPct = 0;

async function toggleMicTest() {
  if (micStream) {
    stopMicTest(false);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("API de microfone não disponível neste ambiente.", "error");
    return;
  }
  const statusEl = document.getElementById("mic-status-text");
  const btnEl = document.getElementById("btn-mic-toggle");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    micAudioCtx = new AudioCtx();
    const source = micAudioCtx.createMediaStreamSource(micStream);
    const analyser = micAudioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    micPeakPct = 0;
    if (statusEl) statusEl.textContent = "Captando áudio ao vivo — fale algo no microfone";
    if (btnEl) {
      btnEl.textContent = "■ Parar Microfone";
      btnEl.classList.remove("btn-primary");
      btnEl.classList.add("btn-danger");
    }

    const tickMic = () => {
      if (!micStream) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const pct = Math.min(100, Math.round(rms * 240));
      if (pct > micPeakPct) micPeakPct = pct;

      const bar = document.getElementById("mic-level-bar");
      const val = document.getElementById("mic-level-val");
      const pk = document.getElementById("mic-peak-val");
      if (bar) bar.style.width = `${pct}%`;
      if (val) val.textContent = `${pct}%`;
      if (pk) pk.textContent = `${micPeakPct}%`;

      micRafId = requestAnimationFrame(tickMic);
    };
    micRafId = requestAnimationFrame(tickMic);
  } catch (e) {
    stopMicTest(true);
    showToast("Permissão de microfone negada ou dispositivo não encontrado.", "error");
  }
}

function stopMicTest(silent) {
  if (micRafId) {
    cancelAnimationFrame(micRafId);
    micRafId = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (micAudioCtx) {
    micAudioCtx.close().catch(() => {});
    micAudioCtx = null;
  }
  const statusEl = document.getElementById("mic-status-text");
  const btnEl = document.getElementById("btn-mic-toggle");
  const bar = document.getElementById("mic-level-bar");
  const val = document.getElementById("mic-level-val");
  if (statusEl) statusEl.textContent = "Inativo — só acessa o microfone ao clicar em testar";
  if (btnEl) {
    btnEl.textContent = "🎙️ Testar Microfone";
    btnEl.classList.remove("btn-danger");
    btnEl.classList.add("btn-primary");
  }
  if (bar) bar.style.width = "0%";
  if (val) val.textContent = "0%";
  if (!silent) showToast("Teste de microfone encerrado.", "info");
}
