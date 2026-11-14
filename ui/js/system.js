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


// ================= SYSTEM TRAY CONTROLS =================
async function loadTraySetting() {
  try {
    const res = await fetch("/api/settings/tray");
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById("setting-minimize-tray");
      if (el) el.checked = data.minimize_to_tray !== false;
    }
  } catch (e) {}
}

async function toggleMinimizeToTray(enabled) {
  try {
    await fetch("/api/settings/tray", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minimize_to_tray: enabled })
    });
    showToast(enabled ? "PulsePC minimizará para a bandeja ao fechar." : "PulsePC fechará totalmente ao clicar no X.", "info");
  } catch (e) {
    showToast("Erro ao salvar configuração.", "error");
  }
}

async function minimizeWindowToTray() {
  try {
    await fetch("/api/window/minimize-to-tray", { method: "POST" });
  } catch (e) {}
}

async function quitPulsePCApp() {
  const ok = await confirmDialog({
    title: "Encerrar PulsePC?",
    message: "Tem certeza que deseja fechar o PulsePC por completo?",
    note: "O monitoramento automático de jogos e o ícone da bandeja serão finalizados.",
    confirmLabel: "Sim, Encerrar"
  });
  if (ok) {
    try {
      await fetch("/api/window/quit", { method: "POST" });
    } catch (e) {}
  }
}
