// Real-time Metrics Polling
async function pollMetrics() {
  if (_metricsPollingInFlight) return;
  _metricsPollingInFlight = true;
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
    const gpuPctVal = (d.gpu && d.gpu.load !== null && d.gpu.load !== undefined) ? Number(d.gpu.load) : 0;
    gpuHistory.push(gpuPctVal);
    if (gpuHistory.length > 30) gpuHistory.shift();
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
    let batSparkVal = 100;
    if (bat) {
      if (bat.is_laptop && bat.has_battery) {
        batSparkVal = Number(bat.percent_remaining) || 0;
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
    batHistory.push(batSparkVal);
    if (batHistory.length > 30) batHistory.shift();

    drawMiniSparkline("tile-cpu-spark", cpuHistory.slice(-30), cssVar("--lime") || "#9BE22D");
    drawMiniSparkline("tile-ram-spark", ramHistory.slice(-30), cssVar("--cyan") || "#38BDF8");
    drawMiniSparkline("tile-gpu-spark", gpuHistory, cssVar("--purple") || "#A78BFA");
    drawMiniSparkline("tile-bat-spark", batHistory, cssVar("--lime") || "#9BE22D");

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
  } finally {
    _metricsPollingInFlight = false;
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

