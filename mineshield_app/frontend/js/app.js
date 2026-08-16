/**
 * MineShield — Main App Module
 * Router, page lifecycle, data orchestration
 */
const App = (() => {
  let currentPage = 'dashboard';
  let refreshTimer = null;
  const REFRESH_INTERVAL = 30000; // 30 seconds

  /* ── Page navigation ── */
  function navigate(page) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    // Show target
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll(`[data-page="${page}"]`).forEach(n => {
      n.classList.add('active');
      const ind = n.querySelector('.nav-indicator');
      if (ind) ind.style.display = 'block';
    });
    document.querySelectorAll(`.nav-item:not([data-page="${page}"]) .nav-indicator`).forEach(ind => {
      ind.style.display = 'none';
    });

    currentPage = page;

    // Initialize page-specific modules on first visit
    switch (page) {
      case 'map':      MapModule.init(); break;
      case 'analytics': loadAnalytics(); break;
      case 'explain':   loadExplain(); break;
      case 'terrain':   loadTerrain(); break;
      case 'weather':   loadWeather(); break;
      case 'workers':   WorkerModule.refresh(); break;
      case 'drone':     DroneModule.load(); break;
      case 'alerts':    AlertsModule.load(); break;
      case 'risk':      RiskModule.runLivePrediction(); break;
    }
  }

  /* ── Topbar navigation ── */
  function initNav() {
    document.querySelectorAll('[data-page]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        const page = el.getAttribute('data-page');
        if (page) navigate(page);
      });
    });

    // Sidebar toggle
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('collapsed');
    });

    // Mine selector
    document.getElementById('mine-selector')?.addEventListener('change', () => {
      document.getElementById('dash-mine-id').textContent =
        document.getElementById('mine-selector').value;
      refreshAll();
    });
  }

  /* ── Toast notification ── */
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '✅', warning: '⚠️', error: '🚨', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  /* ── Timestamp ── */
  function updateTimestamp() {
    const el = document.getElementById('dash-timestamp');
    if (el) el.textContent = new Date().toLocaleString('en-IN');
  }

  /* ── Dashboard data load ── */
  async function loadDashboard() {
    updateTimestamp();

    // Load prediction
    const predData = await API.getLivePrediction();
    if (predData) {
      RiskModule.render(predData);
    } else {
      RiskModule.renderDemo();
    }

    // Load weather
    const wxData = await API.getWeather();
    if (wxData) {
      renderWeatherKPI(wxData);
      renderDashWeatherWidget(wxData);
    }

    // Load alerts
    await AlertsModule.load();

    // Load analytics (for trend chart)
    const analyticsData = await API.getAnalytics();
    if (analyticsData) {
      Charts.renderDashTrend(analyticsData);
    }
  }

  function renderWeatherKPI(wx) {
    const temp   = document.getElementById('kpi-temp');
    const hum    = document.getElementById('kpi-humidity');
    const rain   = document.getElementById('kpi-rainfall');
    const rainSub= document.getElementById('kpi-rain-sub');
    const topbarTemp = document.getElementById('topbar-temp');
    const topbarCond = document.getElementById('topbar-condition');

    if (temp)    temp.textContent = `${wx.temperature_c}°C`;
    if (hum)     hum.textContent  = `Humidity: ${wx.humidity}%`;
    if (rain)    rain.textContent = `${wx.rainfall_7d_mm} mm`;
    if (rainSub) rainSub.textContent = `Today: ${wx.rainfall_today_mm} mm`;
    if (topbarTemp) topbarTemp.textContent = `${wx.temperature_c}°C`;
    if (topbarCond) topbarCond.textContent = wx.condition;
  }

  function renderDashWeatherWidget(wx) {
    const container = document.getElementById('dash-weather-widget');
    if (!container) return;
    container.innerHTML = `
      <div class="weather-widget-row"><span class="wwl">Temperature</span><span class="wwv">${wx.temperature_c}°C</span></div>
      <div class="weather-widget-row"><span class="wwl">Humidity</span><span class="wwv">${wx.humidity}%</span></div>
      <div class="weather-widget-row"><span class="wwl">Wind</span><span class="wwv">${wx.wind_speed_kmh} km/h ${wx.wind_direction}</span></div>
      <div class="weather-widget-row"><span class="wwl">Today's Rain</span><span class="wwv" style="color:${wx.rainfall_today_mm > 50 ? 'var(--risk-critical)' : 'var(--blue)'}">${wx.rainfall_today_mm} mm</span></div>
      <div class="weather-widget-row"><span class="wwl">7-Day Rain</span><span class="wwv" style="color:${wx.rainfall_7d_mm > 150 ? 'var(--risk-critical)' : 'var(--text-primary)'}">${wx.rainfall_7d_mm} mm</span></div>
      <div class="weather-widget-row"><span class="wwl">Pressure</span><span class="wwv">${wx.pressure_hpa} hPa</span></div>
      ${wx.risk_flag ? '<div style="padding:8px;background:rgba(239,68,68,0.1);border-radius:6px;color:var(--risk-critical);font-size:0.78rem;margin-top:6px">⚠️ Rainfall threshold exceeded</div>' : ''}
    `;
  }

  /* ── Weather page ── */
  async function loadWeather() {
    const data = await API.getWeather();
    if (!data) { showToast('Could not load weather data', 'error'); return; }

    document.getElementById('w-temp').textContent      = `${data.temperature_c}°C`;
    document.getElementById('w-condition').textContent = data.condition;
    document.getElementById('w-min').textContent       = `${data.temperature_min_c}°C`;
    document.getElementById('w-max').textContent       = `${data.temperature_max_c}°C`;
    document.getElementById('w-humidity').textContent  = `${data.humidity}%`;
    document.getElementById('w-pressure').textContent  = `${data.pressure_hpa} hPa`;
    document.getElementById('w-wind').textContent      = `${data.wind_speed_kmh} km/h ${data.wind_direction}`;
    document.getElementById('w-vis').textContent       = `${data.visibility_km} km`;

    // Rainfall bars
    const maxRain = 500;
    const rainfalls = [
      { id: 'today', val: data.rainfall_today_mm },
      { id: '3d',    val: data.rainfall_3d_mm },
      { id: '7d',    val: data.rainfall_7d_mm },
      { id: '30d',   val: data.rainfall_30d_mm },
    ];
    rainfalls.forEach(r => {
      const el  = document.getElementById(`rf-${r.id}`);
      const bar = document.getElementById(`rfb-${r.id}`);
      if (el)  el.textContent   = `${r.val} mm`;
      if (bar) bar.style.width  = `${Math.min(100, (r.val / maxRain) * 100)}%`;
    });

    // Hourly rainfall chart
    Charts.renderHourlyRain(data.hourly_rain_mm);

    // Forecast
    const strip = document.getElementById('forecast-strip');
    if (strip && data.forecast) {
      const COND_EMOJI = { 'Heavy Rain': '⛈', 'Light Rain': '🌧', 'Overcast': '☁️', 'Cloudy': '🌥', 'Sunny': '☀️', 'Clear': '🌙', 'Partly Cloudy': '⛅' };
      strip.innerHTML = data.forecast.map(f => `
        <div class="forecast-item">
          <div class="fc-day">${f.day}</div>
          <div class="fc-cond">${COND_EMOJI[f.condition] || '🌤'}</div>
          <div class="fc-temp">${f.temp_max}° / ${f.temp_min}°</div>
          <div class="fc-rain">💧 ${f.rainfall} mm</div>
        </div>
      `).join('');
    }

    // Risk flag
    const flagCard = document.getElementById('weather-risk-flag');
    if (flagCard) flagCard.style.display = data.risk_flag ? 'block' : 'none';
  }

  /* ── Analytics page ── */
  async function loadAnalytics() {
    const data = await API.getAnalytics();
    if (!data) return;

    Charts.renderAnalyticsRisk(data);
    Charts.renderAnalyticsRain(data);
    Charts.renderAlertDist(data.alert_statistics);
    Charts.renderWorkerExposure(data.worker_exposure, 'analyticsExposureChart');

    const avgRisk = data.daily_risk.reduce((s, d) => s + d.probability, 0) / data.daily_risk.length;
    document.getElementById('stat-predictions').textContent = data.total_predictions?.toLocaleString() || '--';
    document.getElementById('stat-alerts').textContent      = data.total_alerts || '--';
    document.getElementById('stat-critical').textContent    = data.critical_events || '--';
    document.getElementById('stat-avgrisk').textContent     = avgRisk.toFixed(3);
  }

  /* ── Explainable AI page ── */
  async function loadExplain() {
    const data = await API.getExplain(15);
    if (!data) return;

    Charts.renderShapBar(data.all_features);
    Charts.renderShapWaterfall(data.all_features);

    const tbody = document.getElementById('shap-tbody');
    if (tbody) {
      tbody.innerHTML = data.all_features.map((f, i) => {
        const barW = Math.min(100, (f.abs_shap / data.all_features[0].abs_shap) * 100);
        const isPos = f.shap > 0;
        return `
          <tr>
            <td style="color:var(--text-muted)">${i + 1}</td>
            <td style="font-weight:600;color:var(--text-primary)">${f.feature}</td>
            <td style="font-family:'JetBrains Mono',monospace;color:${isPos ? 'var(--risk-critical)' : 'var(--blue)'}">${isPos ? '+' : ''}${f.shap.toFixed(4)}</td>
            <td><span style="font-size:0.72rem;padding:2px 8px;border-radius:4px;background:${isPos ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.12)'};color:${isPos ? 'var(--risk-critical)' : 'var(--blue)'}">${isPos ? '↑ Increases Risk' : '↓ Mitigates Risk'}</span></td>
            <td>
              <div style="height:8px;border-radius:4px;background:rgba(255,255,255,0.06);width:120px">
                <div style="height:100%;border-radius:4px;width:${barW}%;background:${isPos ? '#ef4444' : '#3b82f6'}"></div>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  /* ── Terrain page ── */
  async function loadTerrain() {
    const data = await API.getTerrain();
    if (!data) return;

    const container = document.getElementById('terrain-metrics');
    if (container) {
      const metrics = [
        { label: 'Elevation',        value: `${data.elevation_m} m`,   unit: 'm',    pct: (data.elevation_m / 2000) * 100 },
        { label: 'Slope',            value: `${data.slope_deg}°`,       unit: 'deg',  pct: (data.slope_deg / 90) * 100 },
        { label: 'Slope StdDev',     value: data.slope_stddev.toFixed(3), unit: '',  pct: (data.slope_stddev / 30) * 100 },
        { label: 'TRI',              value: data.tri.toFixed(3),         unit: '',   pct: (data.tri / 60) * 100 },
        { label: 'TPI',              value: data.tpi.toFixed(3),         unit: '',   pct: Math.abs(data.tpi / 10) * 100 },
        { label: 'Terrain Roughness',value: data.terrain_roughness.toFixed(2), unit: '', pct: (data.terrain_roughness / 100) * 100 },
        { label: 'Rock Exposure',    value: (data.rock_exposure * 100).toFixed(1) + '%', unit: '', pct: data.rock_exposure * 100, color: '#ef4444' },
        { label: 'BSI',              value: data.bsi.toFixed(3),         unit: '',   pct: data.bsi * 100 },
        { label: 'NDVI',             value: data.ndvi.toFixed(3),        unit: '',   pct: Math.max(0, data.ndvi) * 100, color: '#22c55e' },
        { label: 'NDWI',             value: data.ndwi.toFixed(3),        unit: '',   pct: Math.abs(data.ndwi) * 100, color: '#3b82f6' },
        { label: 'Land Cover',       value: data.land_cover_class,       unit: '',   pct: 60 },
        { label: 'Soil Moisture',    value: data.soil_moisture.toFixed(3), unit: '', pct: data.soil_moisture * 100, color: '#06b6d4' },
      ];
      container.innerHTML = metrics.map(m => `
        <div class="terrain-metric">
          <div class="tm-label">${m.label}</div>
          <div class="tm-value">${m.value}</div>
          <div class="tm-bar" style="width:${Math.min(100, m.pct || 0)}%;background:${m.color || 'var(--accent)'}"></div>
        </div>
      `).join('');
    }

    Charts.renderTerrainRadar(data);
    Charts.renderSar(data);
  }

  /* ── Global refresh ── */
  async function refreshAll() {
    updateTimestamp();
    if (currentPage === 'dashboard') await loadDashboard();
    else {
      // Always refresh topbar weather and alerts count
      const wx = await API.getWeather();
      if (wx) renderWeatherKPI(wx);
      await AlertsModule.load();
    }
  }

  /* ── Auto live prediction on dashboard ── */
  let livePredTimer = null;
  function startLivePred() {
    livePredTimer = setInterval(async () => {
      if (currentPage === 'dashboard' || currentPage === 'risk') {
        const d = await API.getLivePrediction();
        if (d) RiskModule.render(d);
      }
      // Always refresh worker count
      const wd = await API.getWorkers(20.5937, 78.9629);
      if (wd) WorkerModule.render(wd);
    }, REFRESH_INTERVAL);
  }

  /* ── Init ── */
  async function init() {
    initNav();
    // Initial data load
    await loadDashboard();

    // Initialize prediction timeline with demo data
    Charts.addPrediction(0.35);
    Charts.addPrediction(0.42);
    Charts.addPrediction(0.58);
    Charts.addPrediction(0.71);
    Charts.addPrediction(0.65);

    // Start live refresh
    startLivePred();

    // Worker data for dashboard KPI
    const wd = await API.getWorkers(20.5937, 78.9629);
    if (wd) WorkerModule.render(wd);

    showToast('MineShield v2.0 — All systems operational', 'success');
    console.log('%c🛡️ MineShield v2.0', 'color:#f97316;font-size:18px;font-weight:900');
    console.log('%cAI Rockfall Prediction System loaded', 'color:#94a3b8');
  }

  // DOM ready
  document.addEventListener('DOMContentLoaded', init);

  return { navigate, showToast, refreshAll };
})();
