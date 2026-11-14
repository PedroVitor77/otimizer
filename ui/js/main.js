// Initialize App
window.addEventListener("DOMContentLoaded", async () => {
  await pollMetrics();
  setInterval(() => {
    if (!document.hidden) pollMetrics();
  }, 1600);
  loadScannerPresets();
  loadHistoryStats();
  loadHardwareSpecs();
  pollGameBoosterStatus();
  setInterval(() => {
    if (!document.hidden) pollGameBoosterStatus();
  }, 3000);
  loadBenchmarkData();
  loadTraySetting();
  loadGamerTweaks();
  setInterval(() => {
    if (document.hidden) return;
    const tabGames = document.getElementById("tab-games");
    if (tabGames && tabGames.classList.contains("active")) {
      const mon = document.getElementById("sub-gamer-monitor");
      if (mon && mon.style.display !== "none") {
        pollGamerTelemetry();
      }
    }
  }, 1600);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollMetrics();
      pollGameBoosterStatus();
    }
  });
  setTimeout(() => checkUpdates(true), 3500);
  // Count of pending program updates for the badge. Once per launch: it runs `winget upgrade`.
  setTimeout(async () => {
    try {
      const r = await fetch("/api/software-updater/scan");
      const d = await r.json();
      const b = document.getElementById("badge-upgrades-count");
      if (b && d.total > 0) {
        b.textContent = d.total;
        b.style.display = "inline-block";
      }
    } catch (e) {}
  }, 8000);
});

window.addEventListener("resize", drawStrip);
// Canvases inside a hidden tab have no size; redraw when the dashboard comes back.
document.querySelector('.nav-item[data-tab="tab-dashboard"]').addEventListener("click", () => requestAnimationFrame(pollMetrics));


