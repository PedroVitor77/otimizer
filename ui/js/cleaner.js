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


