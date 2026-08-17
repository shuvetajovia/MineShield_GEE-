/**
 * MineShield Alert Management Module
 */
const AlertsModule = (() => {
  let allAlerts = [];
  let currentFilter = 'ALL';

  const ICONS = {
    CRITICAL: '🚨',
    HIGH:     '⚠️',
    WARNING:  '⚡',
    INFO:     'ℹ️',
  };

  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)   return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    return `${Math.round(diff / 3600)}h ago`;
  }

  async function load() {
    const data = await API.getAlerts();
    if (!data) return;
    allAlerts = data.alerts;
    updateBadges(data.count, data.critical_count);
    render();
    renderDashAlerts();
  }

  function updateBadges(count, critical) {
    const badge  = document.getElementById('topbar-alert-badge');
    const navBadge = document.getElementById('alert-count-badge');
    if (badge)    badge.textContent = count;
    if (navBadge) navBadge.textContent = critical || 0;

    // Show modal for critical unacknowledged
    const crit = allAlerts.find(a => a.level === 'CRITICAL' && !a.acknowledged);
    if (crit) showCriticalModal(crit);
  }

  function render() {
    const container = document.getElementById('alerts-container');
    if (!container) return;
    const filtered = currentFilter === 'ALL'
      ? allAlerts
      : allAlerts.filter(a => a.level === currentFilter);

    if (filtered.length === 0) {
      container.innerHTML = '<div class="loading-spinner">No alerts matching filter.</div>';
      return;
    }
    container.innerHTML = filtered.map(a => `
      <div class="alert-card ${a.level} ${a.acknowledged ? 'acknowledged' : ''}" id="alert-${a.id}">
        <div class="alert-card-header">
          <span class="alert-severity-badge ${a.level}">${ICONS[a.level]} ${a.level}</span>
          <div class="alert-card-title">
            <div class="alert-type">${a.type}</div>
            <div class="alert-msg">${a.message}</div>
          </div>
          <div class="alert-time">${timeAgo(a.time)}</div>
        </div>
        <div class="alert-card-body">
          <div class="alert-location">📍 ${a.location}</div>
          <div class="alert-action-text">→ ${a.action}</div>
        </div>
        <div class="alert-card-footer">
          ${!a.acknowledged
            ? `<button class="btn btn-outline" onclick="AlertsModule.ack('${a.id}')">${I18n.t('acknowledge','Acknowledge')}</button>`
            : `<span style="color:var(--text-muted);font-size:0.75rem">✓ ${I18n.t('acknowledged','Acknowledged')}</span>`
          }
          <button class="btn btn-outline" onclick="AlertsModule.dismiss('${a.id}')">${I18n.t('dismiss','Dismiss')}</button>
        </div>
      </div>
    `).join('');
  }

  function renderDashAlerts() {
    const container = document.getElementById('dash-alerts-list');
    if (!container) return;
    const top = allAlerts.slice(0, 4);
    container.innerHTML = top.map(a => `
      <div class="dash-alert-item ${a.level}">
        <span class="dal-severity ${a.level}">${a.level}</span>
        <span class="dal-msg">${a.message.substring(0, 80)}…</span>
        <span class="dal-time">${timeAgo(a.time)}</span>
      </div>
    `).join('');
  }

  function filter(level, btn) {
    currentFilter = level;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  }

  function ack(id) {
    API.ackAlert(id).then(res => {
      const a = allAlerts.find(x => x.id === id);
      if (a) a.acknowledged = true;
      render();
      App.showToast(I18n.t('acknowledged', 'Acknowledged'), 'success');
    }).catch(() => {
      App.showToast(I18n.t('error.generic', 'Operation failed'), 'error');
    });
  }

  function dismiss(id) {
    API.dismissAlert(id).then(res => {
      allAlerts = allAlerts.filter(a => a.id !== id);
      render();
      renderDashAlerts();
      App.showToast(I18n.t('dismissed', 'Dismissed'), 'info');
    }).catch(() => {
      App.showToast(I18n.t('error.generic', 'Operation failed'), 'error');
    });
  }

  function acknowledge() {
    document.getElementById('alert-modal').style.display = 'none';
    App.showToast('Critical alert acknowledged', 'warning');
  }

  function showCriticalModal(alert) {
    const modal = document.getElementById('alert-modal');
    if (!modal) return;
    document.getElementById('alert-modal-title').textContent = `CRITICAL: ${alert.type}`;
    document.getElementById('alert-modal-msg').textContent   = `${alert.message}\n\nRequired Action: ${alert.action}`;
    modal.style.display = 'flex';
  }

  // Auto-generate alerts from high risk predictions
  function fromRisk(prob, mineId) {
    if (prob >= 0.75) {
      App.showToast(`⚠️ CRITICAL: Vulnerability probability ${prob.toFixed(4)} at ${mineId}`, 'error');
    } else if (prob >= 0.5) {
      App.showToast(`High risk detected at ${mineId}: ${prob.toFixed(4)}`, 'warning');
    }
  }

  return { load, filter, ack, dismiss, acknowledge, fromRisk, render };
})();


/**
 * Drone Intelligence Module
 */
const DroneModule = (() => {
  let animFrame = null;
  let droneData = null;
  let droneMap = null;

  function initMap(lat, lon) {
    if (!window.L) return;
    if (droneMap) {
      droneMap.setView([lat, lon], 16);
      return;
    }
    const mapEl = document.getElementById('droneMap');
    if (!mapEl) return;
    
    droneMap = L.map('droneMap', {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false
    }).setView([lat, lon], 16);
    
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(droneMap);
  }

  function drawScene(detections) {
    const canvas = document.getElementById('droneCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Clear transparent canvas
    ctx.clearRect(0, 0, W, H);

    // Draw a subtle digital HUD grid overlay over the terrain
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < W; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Draw bounding boxes for detections
    if (!detections) return;
    detections.forEach(d => {
      const { x, y, w, h } = d.box;
      const color = d.color || '#ef4444';

      // Box outline with glow
      ctx.shadowColor = color;
      ctx.shadowBlur  = 12;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur  = 0;

      // Corner accents
      const cLen = 14;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 3;
      [[x, y],[x+w, y],[x, y+h],[x+w, y+h]].forEach(([cx, cy], i) => {
        const sx = i % 2 === 0 ? 1 : -1;
        const sy = i < 2 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * cLen); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * cLen, cy);
        ctx.stroke();
      });

      // Label background
      const labelW = ctx.measureText(d.label).width + 80;
      ctx.fillStyle = color + 'dd';
      ctx.fillRect(x, y - 20, labelW, 20);

      // Label text
      ctx.fillStyle   = 'white';
      ctx.font        = 'bold 11px Inter, sans-serif';
      ctx.fillText(`${d.label}  ${(d.confidence * 100).toFixed(0)}%`, x + 6, y - 5);
    });

    // Scan line animation
    const now  = Date.now() / 1000;
    const scanY = (now * 80) % H;
    const scanGrad = ctx.createLinearGradient(0, scanY - 20, 0, scanY + 4);
    scanGrad.addColorStop(0, 'rgba(6,182,212,0)');
    scanGrad.addColorStop(1, 'rgba(6,182,212,0.3)');
    ctx.fillStyle = scanGrad;
    ctx.fillRect(0, scanY - 20, W, 24);

    // HUD overlays
    ctx.fillStyle = 'rgba(6,182,212,0.6)';
    ctx.font      = '10px JetBrains Mono, monospace';
    ctx.fillText(`REC ●  ${new Date().toLocaleTimeString()}`, W - 140, 16);
    ctx.fillText(`ALT: 45m  ZOOM: 1.0x`, 8, 16);
    
    const latStr = droneData && droneData.gps_lat ? droneData.gps_lat.toFixed(5) : '20.59370';
    const lonStr = droneData && droneData.gps_lon ? droneData.gps_lon.toFixed(5) : '78.96290';
    ctx.fillText(`GPS: ${latStr}°N ${lonStr}°E`, 8, H - 8);
  }

  function animate() {
    if (droneData) drawScene(droneData.detections);
    animFrame = requestAnimationFrame(animate);
  }

  function renderDetectionList(detections) {
    const container = document.getElementById('detection-list');
    const countEl   = document.getElementById('detection-count');
    if (!container) return;
    if (countEl) countEl.textContent = `${detections.length} anomalies`;
    container.innerHTML = detections.map(d => `
      <div class="detection-item" style="border-left-color:${d.color}">
        <div>
          <div class="di-label" style="color:${d.color}">${d.label}</div>
          <div class="di-conf">Confidence: ${(d.confidence * 100).toFixed(0)}%</div>
        </div>
        <span class="di-sev ${d.severity}">${d.severity}</span>
      </div>
    `).join('');
  }

  function renderTelemetry(data) {
    document.getElementById('tele-flight').textContent = data.flight_id || '--';
    document.getElementById('tele-id').textContent     = data.drone_id  || '--';
    document.getElementById('tele-lat').textContent    = data.gps_lat?.toFixed(5) || '--';
    document.getElementById('tele-lon').textContent    = data.gps_lon?.toFixed(5) || '--';
    document.getElementById('tele-cov').textContent    = data.coverage_area_sqm ? `${data.coverage_area_sqm.toLocaleString()} m²` : '--';
    document.getElementById('tele-crit').textContent   = data.critical_count ?? '--';
    document.getElementById('drone-alt').textContent   = `${data.altitude_m}m`;
    document.getElementById('drone-batt').textContent  = `${data.battery_pct}%`;
    document.getElementById('drone-area').textContent  = `${data.coverage_area_sqm?.toLocaleString()} m²`;
    document.getElementById('drone-time').textContent  = `${data.flight_time_min} min`;

    if (data.gps_lat && data.gps_lon) {
      initMap(data.gps_lat, data.gps_lon);
    }
  }

  async function load() {
    const coords = typeof App !== 'undefined' ? App.getActiveCoords() : { lat: 20.5937, lon: 78.9629 };
    const data = await API.getDrone(coords.lat, coords.lon);
    if (!data) return;
    droneData = data;
    renderDetectionList(data.detections);
    renderTelemetry(data);
    if (!animFrame) animate();
  }

  function simulateFlight() {
    App.showToast('Simulating drone flight…', 'info');
    setTimeout(() => load(), 1000);
  }

  function handleUpload(evt) {
    const file = evt.target.files[0];
    if (!file) return;
    App.showToast(`Uploading ${file.name}…`, 'info');
    API.uploadDrone(file).then(res => {
      if (!res) { App.showToast('Upload failed', 'error'); return; }
      App.showToast('AI analysis complete', 'success');
      // Use returned detections
      droneData = res;
      renderDetectionList(res.detections || []);
      renderTelemetry(res);
      if (!animFrame) animate();
    });
  }

  return { load, simulateFlight, handleUpload };
})();
