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

    if (!res.ok) {
      const errDetail = data && data.detail ? (Array.isArray(data.detail) ? (data.detail[0]?.msg || JSON.stringify(data.detail[0])) : data.detail) : "Erro na resposta do servidor.";
      showToast(`Erro ao limpar sobras: ${errDetail}`, "error");
      return;
    }

    const totalRemoved = (data.removed_folders || 0) + (data.removed_files || 0) + (data.removed_keys || 0);
    if (data.success && totalRemoved > 0) {
      showToast(`Deep Clean concluído! ${data.cleaned_formatted} recuperados (${data.removed_folders + data.removed_files} itens e ${data.removed_keys} chaves).`, "success");
      await loadHistoryStats();
      await loadInstalledPrograms();
    } else if (data.errors && data.errors.length > 0) {
      showToast(data.errors[0], "error");
    } else {
      showToast("As sobras selecionadas já foram removidas do sistema.", "info");
      await loadInstalledPrograms();
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


