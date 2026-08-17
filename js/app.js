/**
 * MineShield — Main App Module
 * Router, page lifecycle, data orchestration
 */
const App = (() => {
  let currentPage = 'dashboard';
  let refreshTimer = null;
  const REFRESH_INTERVAL = 30000; // 30 seconds

  function getActiveCoords() {
    const select = document.getElementById('mine-selector');
    const mineId = select ? select.value : 'MINE-OB-001';
    if (mineId === 'GPS' && App && App.userLocation) {
      return App.userLocation;
    }
    const mineCoords = {
      "MINE-OB-001": { lat: 20.5937, lon: 83.9629 },
      "MINE-JH-001": { lat: 23.6102, lon: 85.2799 },
      "MINE-RJ-001": { lat: 25.2138, lon: 75.8648 },
      "MINE-MP-001": { lat: 22.9734, lon: 78.6569 },
      "MINE-CG-001": { lat: 21.2787, lon: 81.8661 },
      "MINE-KA-001": { lat: 15.3173, lon: 75.7139 },
      "MINE-GJ-001": { lat: 22.2587, lon: 71.1924 },
      "MINE-AP-001": { lat: 15.9129, lon: 79.7400 },
      "MINE-TN-001": { lat: 11.1271, lon: 78.6569 },
      "MINE-WB-001": { lat: 23.5000, lon: 87.1200 }
    };
    return mineCoords[mineId] || (App && App.userLocation) || { lat: 20.5937, lon: 78.9629 };
  }

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
      const mineId = document.getElementById('mine-selector').value;
      document.getElementById('dash-mine-id').textContent = mineId;
      if (typeof MapModule !== 'undefined' && MapModule.focusOnMine) {
        if (mineId === 'GPS') {
          if (App.userLocation) {
            MapModule.focusOnMine('GPS');
          }
        } else {
          MapModule.focusOnMine(mineId);
        }
      }
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
  function updateSessionUser(user) {
    const nameEl = document.getElementById('user-name');
    const roleEl = document.getElementById('user-role');
    const avatarEl = document.getElementById('user-avatar');
    if (!user) return;
    if (nameEl) nameEl.textContent = user.name || 'Operations User';
    if (roleEl) roleEl.textContent = user.role || 'Site Operations Manager';
    if (avatarEl) avatarEl.textContent = (user.avatar || 'OU').toUpperCase();

    // Common User (Public Mode) restrictions
    const isCommonUser = user.role === 'Common User';
    const navWorkers = document.getElementById('nav-workers');
    const navDrone = document.getElementById('nav-drone');
    const navSettings = document.getElementById('nav-settings');
    const toggleWorkers = document.getElementById('toggle-workers');
    const toggleDrones = document.getElementById('toggle-drones');
    const runPredBtn = document.getElementById('run-prediction-btn');
    
    if (navWorkers) navWorkers.style.display = isCommonUser ? 'none' : 'flex';
    if (navDrone) navDrone.style.display = isCommonUser ? 'none' : 'flex';
    if (navSettings) navSettings.style.display = isCommonUser ? 'none' : 'flex';
    
    if (toggleWorkers) {
      toggleWorkers.disabled = isCommonUser;
      if (isCommonUser) {
        toggleWorkers.checked = false;
        if (typeof MapModule !== 'undefined' && MapModule.toggleWorkers) {
          MapModule.toggleWorkers(false);
        }
      }
    }
    if (toggleDrones) {
      toggleDrones.disabled = isCommonUser;
      if (isCommonUser) {
        toggleDrones.checked = false;
        if (typeof MapModule !== 'undefined' && MapModule.toggleDrones) {
          MapModule.toggleDrones(false);
        }
      }
    }
    if (runPredBtn) runPredBtn.style.display = isCommonUser ? 'none' : 'block';
  }

  async function loadSessionUser() {
    const session = await API.get('/auth/session');
    if (session && session.user) {
      updateSessionUser(session.user);
    }
  }

  async function loadDashboard() {
    updateTimestamp();
    const session = await API.get('/auth/session');
    if (session && session.user) {
      updateSessionUser(session.user);
    }

    // Load prediction with error handling
    try {
      const coords = getActiveCoords();
      const predData = await API.getLivePrediction(coords.lat, coords.lon);
      if (predData) {
        RiskModule.render(predData);
        if (typeof MapModule !== 'undefined' && MapModule.setNearestMine && predData.latitude && predData.longitude) {
          MapModule.setNearestMine(
            predData.latitude,
            predData.longitude,
            predData.mine_id,
            predData.verified !== false,
            predData.confidence_score || 1.0,
            true, // weatherAvailable
            true, // terrainAvailable
            predData.distance_km || 0.0
          );
        }
      } else {
        RiskModule.renderDemo();
      }
    } catch (e) {
      console.warn('Prediction load failed:', e);
      RiskModule.renderDemo();
    }

    // Load weather with error handling
    try {
      const coords = getActiveCoords();
      const wxData = await API.getWeather(coords.lat, coords.lon);
      if (wxData) {
        renderWeatherKPI(wxData);
        renderDashWeatherWidget(wxData);
      }
    } catch (e) {
      console.warn('Weather load failed:', e);
    }

    // Load alerts
    try {
      await AlertsModule.load();
    } catch (e) {
      console.warn('Alerts load failed:', e);
    }

    // Load analytics (for trend chart)
    try {
      const analyticsData = await API.getAnalytics();
      if (analyticsData) {
        Charts.renderDashTrend(analyticsData);
      }
    } catch (e) {
      console.warn('Analytics load failed:', e);
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
    const coords = getActiveCoords();
    const data = await API.getWeather(coords.lat, coords.lon);
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
    TerrainPanel.refresh();
  }

  /* ── Global refresh ── */
  async function refreshAll() {
    updateTimestamp();
    if (currentPage === 'dashboard') await loadDashboard();
    else {
      // Always refresh topbar weather and alerts count
      const coords = getActiveCoords();
      const wx = await API.getWeather(coords.lat, coords.lon);
      if (wx) renderWeatherKPI(wx);
      await AlertsModule.load();
    }
  }

  /* ── Auto live prediction on dashboard ── */
  let livePredTimer = null;
  function startLivePred() {
    livePredTimer = setInterval(async () => {
      const coords = getActiveCoords();
      if (currentPage === 'dashboard' || currentPage === 'risk') {
        const d = await API.getLivePrediction(coords.lat, coords.lon);
        if (d) {
          RiskModule.render(d);
          if (typeof MapModule !== 'undefined' && MapModule.setNearestMine && d.latitude && d.longitude) {
            MapModule.setNearestMine(d.latitude, d.longitude, d.mine_id);
          }
        }
      }
      if (currentPage === 'drone' && typeof DroneModule !== 'undefined') {
        await DroneModule.load();
      }
      // Always refresh worker count
      const wd = await API.getWorkers(coords.lat, coords.lon);
      if (wd) WorkerModule.render(wd);
    }, REFRESH_INTERVAL);
  }

  function showLogin(show) {
    const overlay = document.getElementById('login-overlay');
    const appEl = document.getElementById('app');
    if (show) {
      if (overlay) overlay.style.display = 'flex';
      if (appEl) appEl.style.display = 'none';
    } else {
      if (overlay) overlay.style.display = 'none';
      if (appEl) appEl.style.display = 'flex';
    }
  }

  async function handleSendOTP() {
    const name = document.getElementById('login-name').value.trim();
    const contact = document.getElementById('login-contact').value.trim();
    
    if (!name || !contact) {
      showToast('Name and Contact fields are required', 'warning');
      return;
    }
    
    const btn = document.getElementById('btn-send-otp');
    btn.textContent = 'Sending OTP...';
    btn.disabled = true;
    
    try {
      const res = await API.post('/auth/request-otp', { name, contact });
      btn.textContent = 'Send Verification OTP';
      btn.disabled = false;
      
      if (res && res.status === 'otp_sent') {
        showToast('OTP code sent successfully (Simulated)', 'success');
        document.getElementById('otp-verify-panel').style.display = 'block';
        document.getElementById('otp-hint-message').textContent = `Testing OTP Code: ${res.otp}`;
      } else {
        showToast('Failed to send OTP code', 'error');
      }
    } catch (e) {
      btn.textContent = 'Send Verification OTP';
      btn.disabled = false;
      showToast('Network error sending OTP', 'error');
    }
  }

  async function handleVerifyOTP() {
    const name = document.getElementById('login-name').value.trim();
    const contact = document.getElementById('login-contact').value.trim();
    const otp_code = document.getElementById('login-otp').value.trim();
    
    if (!otp_code) {
      showToast('Please enter the OTP code', 'warning');
      return;
    }
    
    try {
      const res = await API.post('/auth/verify-otp', { name, contact, otp_code });
      if (res && res.status === 'authenticated') {
        showToast('Verified successfully. Welcome to MineShield!', 'success');
        updateSessionUser(res.user);
        showLogin(false);
        await loadDashboard();
      } else {
        showToast('Invalid OTP code. Please try again.', 'error');
      }
    } catch (e) {
      showToast('Authentication failed', 'error');
    }
  }

  async function handleLogout(e) {
    if (e) e.preventDefault();
    await API.post('/auth/logout');
    showToast('Logged out successfully', 'info');
    document.getElementById('login-name').value = '';
    document.getElementById('login-contact').value = '';
    document.getElementById('login-otp').value = '';
    document.getElementById('otp-verify-panel').style.display = 'none';
    showLogin(true);
  }

  /* ── Init ── */
  async function init() {
    // Load session first
    const session = await API.get('/auth/session');
    // If the session user is the default mock user, force login overlay
    if (session && session.user && session.user.name !== 'Operations User') {
      updateSessionUser(session.user);
      showLogin(false);
    } else {
      showLogin(true);
    }

    // Now initialize the app
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
    const coords = getActiveCoords();
    const wd = await API.getWorkers(coords.lat, coords.lon);
    if (wd) WorkerModule.render(wd);

    showToast('🛡️ MineShield v2.0 — All systems operational', 'success');
    console.log('%c🛡️ MineShield v2.0', 'color:#f97316;font-size:18px;font-weight:900');
    console.log('%cAI Rockfall Prediction System loaded', 'color:#94a3b8');
  }

  // DOM ready
  document.addEventListener('DOMContentLoaded', init);

  return { navigate, showToast, refreshAll, updateSessionUser, userLocation: null, getActiveCoords, handleSendOTP, handleVerifyOTP, handleLogout };
})();
