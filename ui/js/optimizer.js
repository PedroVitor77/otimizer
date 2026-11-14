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

let _boosterPollingInFlight = false;

// ================= GAME BOOSTER MODULE =================
async function pollGameBoosterStatus() {
  if (_boosterPollingInFlight) return;
  _boosterPollingInFlight = true;
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
  finally {
    _boosterPollingInFlight = false;
  }
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
        <button class="btn btn-purple btn-boost-candidate" data-pid="${Number(c.pid)}" data-name="${escapeHtml(c.name)}" style="padding:6px 14px; font-size:12px; font-weight:600;">
          Otimizar Agora
        </button>
      </div>
    `).join("");
    list.querySelectorAll(".btn-boost-candidate").forEach(btn => {
      btn.addEventListener("click", () => {
        boostProcessNow(Number(btn.dataset.pid), btn.dataset.name || "");
      });
    });
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
      if (typeof pollGamerTelemetry === "function") {
        await pollGamerTelemetry();
      }
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

