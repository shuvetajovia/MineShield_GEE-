/**
 * Sensors Module — fetches /sensors and renders sensor cards
 */
const SensorsModule = (() => {
  async function load() {
    const data = await API.get('/sensors');
    if (!data) return;
    render(data.sensors || []);
  }

  function render(sensors) {
    const container = document.getElementById('sensor-list');
    if (!container) return;
    if (!sensors || sensors.length === 0) {
      container.innerHTML = '<div style="padding:12px;color:var(--text-muted)">No sensors available</div>';
      return;
    }
    container.innerHTML = sensors.map(s => `
      <div class="sensor-card ${s.status.toLowerCase()}">
        <div class="sc-left">
          <div class="sc-type">${s.type}</div>
          <div class="sc-loc">${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}</div>
        </div>
        <div class="sc-right">
          <div class="sc-value">${s.value} ${s.unit}</div>
          <div class="sc-status">${s.status}</div>
          <div class="sc-trend">Δ ${s.trend}</div>
        </div>
      </div>
    `).join('');
  }

  // Auto-refresh
  let timer = null;
  function start() {
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(load, 5000);
  }

  // Init on DOM ready
  document.addEventListener('DOMContentLoaded', start);

  return { load, start };
})();
