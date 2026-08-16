/**
 * MineShield Chart Module
 * All Chart.js chart definitions and renderers
 */
const Charts = (() => {
  // Dark theme defaults
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size   = 11;

  const RISK_COLORS = {
    LOW:      '#22c55e',
    MODERATE: '#eab308',
    HIGH:     '#f97316',
    CRITICAL: '#ef4444',
  };

  function riskColor(prob) {
    if (prob < 0.25) return RISK_COLORS.LOW;
    if (prob < 0.50) return RISK_COLORS.MODERATE;
    if (prob < 0.75) return RISK_COLORS.HIGH;
    return RISK_COLORS.CRITICAL;
  }

  function gradient(ctx, top, bottom) {
    const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  /* ── Semi-circle gauge ── */
  function drawGauge(canvasId, prob, label, small = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H - (small ? 20 : 30);
    const r  = (small ? Math.min(W, H) * 0.72 : Math.min(W, H) * 0.7);
    const startA = Math.PI, endA = 2 * Math.PI;
    const sweepA = startA + prob * Math.PI;
    const color  = riskColor(prob);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, endA);
    ctx.lineWidth  = small ? 12 : 18;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineCap    = 'round';
    ctx.stroke();

    // Colored segments
    const segs = [
      { end: startA + 0.25 * Math.PI, color: '#22c55e' },
      { end: startA + 0.50 * Math.PI, color: '#eab308' },
      { end: startA + 0.75 * Math.PI, color: '#f97316' },
      { end: endA,                     color: '#ef4444' },
    ];
    let sa = startA;
    segs.forEach(seg => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, sa, Math.min(sweepA, seg.end));
      ctx.lineWidth   = small ? 12 : 18;
      ctx.strokeStyle = seg.color;
      ctx.lineCap     = 'round';
      ctx.stroke();
      if (sweepA <= seg.end) return;
      sa = seg.end;
    });

    // Needle
    const needleAngle = startA + prob * Math.PI;
    const nx = cx + (r) * Math.cos(needleAngle);
    const ny = cy + (r) * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.lineWidth   = small ? 2 : 3;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, small ? 5 : 7, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Glow around needle tip
    ctx.beginPath();
    ctx.arc(nx, ny, small ? 4 : 6, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  /* ── Dash trend chart (risk + rainfall dual axis) ── */
  let dashTrendInst = null;
  function renderDashTrend(data) {
    const canvas = document.getElementById('dashTrendChart');
    if (!canvas) return;
    if (dashTrendInst) dashTrendInst.destroy();
    const ctx = canvas.getContext('2d');
    const labels = data.daily_risk.map(d => d.date.slice(5));
    const risks   = data.daily_risk.map(d => d.probability);
    const rains   = data.daily_rainfall.map(d => d.rainfall_mm);
    dashTrendInst = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Risk Probability',
            data: risks,
            borderColor: '#f97316',
            backgroundColor: gradient(ctx, 'rgba(249,115,22,0.2)', 'rgba(249,115,22,0)'),
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
            yAxisID: 'y1',
          },
          {
            label: 'Rainfall (mm)',
            data: rains,
            borderColor: '#3b82f6',
            backgroundColor: gradient(ctx, 'rgba(59,130,246,0.15)', 'rgba(59,130,246,0)'),
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
          y1: { position: 'left',  min: 0, max: 1, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => v.toFixed(1) } },
          y2: { position: 'right', grid: { display: false }, ticks: { callback: v => v + 'mm' } },
        },
      },
    });
  }

  /* ── Analytics: Risk trend ── */
  let analyticsRiskInst = null;
  function renderAnalyticsRisk(data) {
    const canvas = document.getElementById('analyticsRiskChart');
    if (!canvas) return;
    if (analyticsRiskInst) analyticsRiskInst.destroy();
    const ctx = canvas.getContext('2d');
    const labels = data.daily_risk.map(d => d.date.slice(5));
    const probs  = data.daily_risk.map(d => d.probability);
    const colors = probs.map(p => riskColor(p));
    analyticsRiskInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Risk Probability',
          data: probs,
          backgroundColor: colors.map(c => c + '99'),
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
          y: { min: 0, max: 1, grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  /* ── Analytics: Rainfall ── */
  let analyticsRainInst = null;
  function renderAnalyticsRain(data) {
    const canvas = document.getElementById('analyticsRainChart');
    if (!canvas) return;
    if (analyticsRainInst) analyticsRainInst.destroy();
    const ctx = canvas.getContext('2d');
    const labels = data.daily_rainfall.map(d => d.date.slice(5));
    const rains  = data.daily_rainfall.map(d => d.rainfall_mm);
    analyticsRainInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Rainfall (mm)',
          data: rains,
          backgroundColor: gradient(ctx, 'rgba(59,130,246,0.6)', 'rgba(59,130,246,0.2)'),
          borderColor: '#3b82f6',
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  /* ── Analytics: Alert distribution (doughnut) ── */
  let analyticsAlertInst = null;
  function renderAlertDist(stats) {
    const canvas = document.getElementById('analyticsAlertChart');
    if (!canvas) return;
    if (analyticsAlertInst) analyticsAlertInst.destroy();
    const ctx = canvas.getContext('2d');
    analyticsAlertInst = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Info', 'Warning', 'High', 'Critical'],
        datasets: [{
          data: [stats.INFO, stats.WARNING, stats.HIGH, stats.CRITICAL],
          backgroundColor: ['rgba(59,130,246,0.7)','rgba(234,179,8,0.7)','rgba(249,115,22,0.7)','rgba(239,68,68,0.7)'],
          borderColor: ['#3b82f6','#eab308','#f97316','#ef4444'],
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true } },
        },
      },
    });
  }

  /* ── Analytics: Worker exposure ── */
  let analyticsExpInst = null;
  function renderWorkerExposure(data, canvasId = 'analyticsExposureChart') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (analyticsExpInst) analyticsExpInst.destroy();
    const ctx = canvas.getContext('2d');
    const names = data.map(w => w.worker.split(' ')[0]);
    const hours = data.map(w => w.hours_in_zone);
    analyticsExpInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{
          label: 'Hours in Hazard Zone',
          data: hours,
          backgroundColor: hours.map(h => h > 5 ? 'rgba(239,68,68,0.7)' : h > 2 ? 'rgba(249,115,22,0.7)' : 'rgba(34,197,94,0.7)'),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  /* ── Prediction timeline ── */
  let predTimeInst = null;
  const predHistory = [];
  function addPrediction(prob) {
    const now = new Date();
    predHistory.push({ t: now.toLocaleTimeString(), p: prob });
    if (predHistory.length > 20) predHistory.shift();
    renderPredTimeline();
  }
  function renderPredTimeline() {
    const canvas = document.getElementById('predictionTimelineChart');
    if (!canvas) return;
    if (predTimeInst) predTimeInst.destroy();
    const ctx = canvas.getContext('2d');
    predTimeInst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: predHistory.map(p => p.t),
        datasets: [{
          label: 'Vulnerability',
          data: predHistory.map(p => p.p),
          borderColor: '#f97316',
          backgroundColor: gradient(ctx, 'rgba(249,115,22,0.2)', 'rgba(249,115,22,0)'),
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: predHistory.map(p => riskColor(p.p)),
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { min: 0, max: 1, grid: { color: 'rgba(255,255,255,0.04)' } },
        },
        animation: { duration: 400 },
      },
    });
  }

  /* ── Hourly rainfall ── */
  let hourlyRainInst = null;
  function renderHourlyRain(hourly) {
    const canvas = document.getElementById('hourlyRainChart');
    if (!canvas) return;
    if (hourlyRainInst) hourlyRainInst.destroy();
    const ctx = canvas.getContext('2d');
    const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    hourlyRainInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Rainfall (mm)',
          data: hourly,
          backgroundColor: hourly.map(v => v > 30 ? 'rgba(239,68,68,0.75)' : v > 15 ? 'rgba(249,115,22,0.7)' : 'rgba(59,130,246,0.6)'),
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  /* ── SHAP bar chart ── */
  let shapBarInst = null;
  function renderShapBar(features) {
    const canvas = document.getElementById('shapBarChart');
    if (!canvas) return;
    if (shapBarInst) shapBarInst.destroy();
    const ctx = canvas.getContext('2d');
    const sorted = [...features].sort((a, b) => b.abs_shap - a.abs_shap).slice(0, 12);
    shapBarInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sorted.map(f => f.feature),
        datasets: [{
          label: 'Mean |SHAP|',
          data: sorted.map(f => f.abs_shap),
          backgroundColor: sorted.map(f => f.shap > 0 ? 'rgba(239,68,68,0.75)' : 'rgba(59,130,246,0.75)'),
          borderColor:     sorted.map(f => f.shap > 0 ? '#ef4444' : '#3b82f6'),
          borderWidth: 1.5,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  /* ── SHAP waterfall ── */
  let shapWFInst = null;
  function renderShapWaterfall(features) {
    const canvas = document.getElementById('shapWaterfallChart');
    if (!canvas) return;
    if (shapWFInst) shapWFInst.destroy();
    const ctx = canvas.getContext('2d');
    const items = features.slice(0, 10);
    shapWFInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: items.map(f => f.feature),
        datasets: [{
          label: 'SHAP Value',
          data: items.map(f => f.shap),
          backgroundColor: items.map(f => f.shap > 0 ? 'rgba(239,68,68,0.8)' : 'rgba(59,130,246,0.8)'),
          borderColor:     items.map(f => f.shap > 0 ? '#ef4444' : '#3b82f6'),
          borderWidth: 1.5,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  /* ── Terrain radar ── */
  let terrainRadarInst = null;
  function renderTerrainRadar(t) {
    const canvas = document.getElementById('terrainRadarChart');
    if (!canvas) return;
    if (terrainRadarInst) terrainRadarInst.destroy();
    const ctx = canvas.getContext('2d');
    terrainRadarInst = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: ['NDVI', 'NDWI', 'NDMI', 'EVI', 'BSI', 'Rock Exp.'],
        datasets: [{
          label: 'Spectral Indices',
          data: [
            Math.max(0, t.ndvi),
            Math.max(0, t.ndwi + 0.3),
            Math.max(0, t.ndmi + 0.2),
            Math.max(0, t.evi),
            t.bsi,
            t.rock_exposure,
          ],
          backgroundColor: 'rgba(249,115,22,0.15)',
          borderColor: '#f97316',
          pointBackgroundColor: '#f97316',
          borderWidth: 2,
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            min: 0, max: 1,
            grid: { color: 'rgba(255,255,255,0.07)' },
            pointLabels: { font: { size: 10 } },
            angleLines: { color: 'rgba(255,255,255,0.05)' },
            ticks: { display: false },
          },
        },
      },
    });
  }

  /* ── SAR backscatter chart ── */
  let sarInst = null;
  function renderSar(t) {
    const canvas = document.getElementById('sarChart');
    if (!canvas) return;
    if (sarInst) sarInst.destroy();
    const ctx = canvas.getContext('2d');
    sarInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['VV', 'VH', 'VV-VH Diff'],
        datasets: [{
          label: 'SAR Backscatter (dB)',
          data: [t.vv_db, t.vh_db, t.vv_db - t.vh_db],
          backgroundColor: ['rgba(6,182,212,0.7)', 'rgba(168,85,247,0.7)', 'rgba(249,115,22,0.7)'],
          borderColor:     ['#06b6d4', '#a855f7', '#f97316'],
          borderWidth: 1.5,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  /* ── Worker exposure (workers page) ── */
  let workerExpInst = null;
  function renderWorkerBar(data) {
    const canvas = document.getElementById('workerExposureChart');
    if (!canvas) return;
    if (workerExpInst) workerExpInst.destroy();
    const ctx = canvas.getContext('2d');
    const names = data.map(w => w.name.split(' ')[0]);
    const dists = data.map(w => w.distance_m);
    workerExpInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{
          label: 'Distance to Hazard (m)',
          data: dists,
          backgroundColor: dists.map(d => d < 20 ? 'rgba(239,68,68,0.7)' : d < 50 ? 'rgba(249,115,22,0.7)' : 'rgba(34,197,94,0.7)'),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  return {
    drawGauge,
    riskColor,
    renderDashTrend,
    renderAnalyticsRisk,
    renderAnalyticsRain,
    renderAlertDist,
    renderWorkerExposure,
    renderWorkerBar,
    addPrediction,
    renderPredTimeline,
    renderHourlyRain,
    renderShapBar,
    renderShapWaterfall,
    renderTerrainRadar,
    renderSar,
  };
})();
