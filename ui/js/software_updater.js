// ================= SOFTWARE UPDATER (WINGET) =================
let softwareUpdatesList = [];
let softwareUpdatesSelected = new Set();
let softwareUpgradePollTimer = null;

async function loadSoftwareUpdates(force = false) {
  const tbody = document.getElementById("upgrade-table-body");
  const btnScan = document.getElementById("btn-scan-upgrades");
  const statusBadge = document.getElementById("upgrade-status-badge");
  const countBadge = document.getElementById("badge-upgrades-count");

  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:36px; color:var(--text-secondary);"><span class="spinner"></span> Verificando novas versões via Windows Package Manager (winget)...</td></tr>`;
  }
  if (btnScan) btnScan.disabled = true;
  if (statusBadge) {
    statusBadge.className = "badge badge-cyan";
    statusBadge.textContent = "Verificando...";
  }

  try {
    const res = await fetch(`/api/software-updater/scan?force=${force}`);
    const data = await res.json();

    if (!data.available && data.error) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:36px; color:var(--accent-amber);">${escapeHtml(data.error)}</td></tr>`;
      }
      if (statusBadge) {
        statusBadge.className = "badge badge-amber";
        statusBadge.textContent = "Winget Indisponível";
      }
      return;
    }

    softwareUpdatesList = data.items || [];
    softwareUpdatesSelected = new Set(softwareUpdatesList.map(it => it.id));

    if (countBadge) {
      countBadge.textContent = softwareUpdatesList.length;
      countBadge.style.display = softwareUpdatesList.length > 0 ? "inline-block" : "none";
    }

    if (statusBadge) {
      if (softwareUpdatesList.length > 0) {
        statusBadge.className = "badge badge-green";
        statusBadge.textContent = `${softwareUpdatesList.length} atualizações encontradas`;
      } else {
        statusBadge.className = "badge badge-green";
        statusBadge.textContent = "Tudo Atualizado";
      }
    }

    renderSoftwareUpdatesTable();
    checkUpgradeRunningStatus();

  } catch (e) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:36px; color:var(--accent-amber);">Erro ao conectar com o serviço de atualizações.</td></tr>`;
    }
  } finally {
    if (btnScan) btnScan.disabled = false;
  }
}

function renderSoftwareUpdatesTable() {
  const tbody = document.getElementById("upgrade-table-body");
  if (!tbody) return;

  const search = (document.getElementById("upgrade-search")?.value || "").toLowerCase().trim();
  const filtered = softwareUpdatesList.filter(it => 
    it.name.toLowerCase().includes(search) || 
    it.id.toLowerCase().includes(search)
  );

  updateSelectedCountUI();

  if (softwareUpdatesList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:44px; color:var(--accent-emerald);">
          <div style="font-size:24px; margin-bottom:8px;">✓</div>
          <div style="font-weight:700; font-size:15px; margin-bottom:4px; color:var(--text-primary);">Todos os seus programas estão atualizados!</div>
          <div style="font-size:12px; color:var(--text-secondary);">O Windows Package Manager não encontrou nenhuma nova versão pendente.</div>
        </td>
      </tr>`;
    return;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--text-secondary);">Nenhum programa correspondente à busca "${escapeHtml(search)}".</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const isChecked = softwareUpdatesSelected.has(item.id);
    return `
      <tr>
        <td>
          <input type="checkbox" class="upgrade-check-item" data-id="${escapeHtml(item.id)}" ${isChecked ? "checked" : ""} />
        </td>
        <td>
          <div style="font-weight:600; font-size:13px; color:var(--text-primary);">${escapeHtml(item.name)}</div>
        </td>
        <td>
          <code style="font-size:11px; color:var(--text-secondary); background:rgba(255,255,255,0.04); padding:2px 6px; border-radius:4px;">${escapeHtml(item.id)}</code>
        </td>
        <td>
          <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(item.installed_version || "--")}</span>
        </td>
        <td>
          <span class="badge badge-green" style="font-size:11px; font-weight:700;">${escapeHtml(item.available_version || "--")}</span>
        </td>
        <td>
          <span style="font-size:11.5px; color:var(--text-muted);">${escapeHtml(item.source || "winget")}</span>
        </td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-secondary btn-upgrade-single" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">
            Atualizar
          </button>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".upgrade-check-item").forEach(cb => {
    cb.addEventListener("change", () => {
      toggleSingleUpgradeCheck(cb.dataset.id || "", cb.checked);
    });
  });
  tbody.querySelectorAll(".btn-upgrade-single").forEach(btn => {
    btn.addEventListener("click", () => {
      upgradeSingleSoftware(btn.dataset.id || "", btn.dataset.name || "");
    });
  });
}

function toggleAllUpgradesCheck(checked) {
  if (checked) {
    softwareUpdatesSelected = new Set(softwareUpdatesList.map(it => it.id));
  } else {
    softwareUpdatesSelected.clear();
  }
  document.querySelectorAll(".upgrade-check-item").forEach(cb => { cb.checked = checked; });
  updateSelectedCountUI();
}

function toggleSingleUpgradeCheck(pkgId, checked) {
  if (checked) softwareUpdatesSelected.add(pkgId);
  else softwareUpdatesSelected.delete(pkgId);
  updateSelectedCountUI();
}

function updateSelectedCountUI() {
  const countEl = document.getElementById("upgrade-selected-count");
  if (countEl) countEl.textContent = softwareUpdatesSelected.size;
  const btnAll = document.getElementById("btn-upgrade-all");
  if (btnAll) btnAll.disabled = softwareUpdatesSelected.size === 0;
}

async function upgradeAllSelectedSoftware() {
  const ids = Array.from(softwareUpdatesSelected);
  if (!ids.length) {
    showToast("Selecione pelo menos um programa para atualizar.", "info");
    return;
  }

  const ok = await confirmDialog({
    title: `Atualizar ${ids.length} Programa(s)?`,
    message: `O PulsePC iniciará o download e instalação silenciosa das novas versões selecionadas via Windows Package Manager.`,
    note: "Os programas podem fechar e reabrir brevemente durante a atualização.",
    confirmLabel: "Iniciar Atualizações"
  });
  if (!ok) return;

  try {
    const res = await fetch("/api/software-updater/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_ids: ids })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Atualização iniciada em segundo plano!", "info");
      startUpgradePolling();
    } else {
      showToast(data.message || "Não foi possível iniciar a atualização.", "error");
    }
  } catch (e) {
    showToast("Erro ao iniciar atualização.", "error");
  }
}

async function upgradeSingleSoftware(pkgId, pkgName) {
  try {
    const res = await fetch("/api/software-updater/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_ids: [pkgId] })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Atualizando ${pkgName}...`, "info");
      startUpgradePolling();
    } else {
      showToast(data.message || "Falha ao iniciar.", "error");
    }
  } catch (e) {
    showToast("Erro ao iniciar atualização.", "error");
  }
}

function startUpgradePolling() {
  const banner = document.getElementById("upgrade-progress-banner");
  if (banner) banner.style.display = "block";

  if (softwareUpgradePollTimer) clearInterval(softwareUpgradePollTimer);
  softwareUpgradePollTimer = setInterval(pollUpgradeProgress, 1000);
  pollUpgradeProgress();
}

async function checkUpgradeRunningStatus() {
  try {
    const res = await fetch("/api/software-updater/status");
    const st = await res.json();
    if (st.status === "upgrading") {
      startUpgradePolling();
    }
  } catch (e) {}
}

async function pollUpgradeProgress() {
  try {
    const res = await fetch("/api/software-updater/status");
    const st = await res.json();

    const banner = document.getElementById("upgrade-progress-banner");
    const title = document.getElementById("upgrade-current-title");
    const sub = document.getElementById("upgrade-current-subtitle");
    const bar = document.getElementById("upgrade-progress-bar");
    const countLbl = document.getElementById("upgrade-count-label");
    const pctLbl = document.getElementById("upgrade-percent-label");

    if (st.status === "upgrading") {
      if (banner) banner.style.display = "block";
      if (title) title.textContent = `Atualizando: ${st.current_package || "Programa..."}`;
      if (sub) {
        const lastLog = (st.logs && st.logs.length) ? st.logs[st.logs.length - 1] : "Instalando em segundo plano...";
        sub.textContent = lastLog;
      }
      if (bar) bar.style.width = `${st.percent || 0}%`;
      if (countLbl) countLbl.textContent = `${st.current_index || 0} de ${st.total || 0} processados (${(st.completed || []).length} concluídos)`;
      if (pctLbl) pctLbl.textContent = `${st.percent || 0}%`;
    } else if (st.status === "finished" || st.status === "cancelled") {
      clearInterval(softwareUpgradePollTimer);
      softwareUpgradePollTimer = null;
      if (bar) bar.style.width = "100%";
      if (pctLbl) pctLbl.textContent = "100%";

      const completedCount = (st.completed || []).length;
      const failedCount = (st.failed || []).length;

      if (title) {
        title.textContent = st.status === "cancelled" ? "Atualizações canceladas." : "Atualizações finalizadas!";
      }
      if (sub) {
        sub.textContent = `${completedCount} programa(s) atualizados com sucesso${failedCount ? `, ${failedCount} com falha` : ""}.`;
      }

      showToast(`Atualizações concluídas: ${completedCount} programa(s) atualizados com sucesso!`, "success");
      setTimeout(() => {
        if (banner) banner.style.display = "none";
        loadSoftwareUpdates(true);
        loadHistoryStats();
      }, 3000);
    }
  } catch (e) {}
}

async function cancelSoftwareUpgradeJob() {
  try {
    await fetch("/api/software-updater/cancel", { method: "POST" });
    showToast("Cancelando processo de atualização...", "info");
  } catch (e) {}
}

