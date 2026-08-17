/**
 * MineShield Worker Safety Module
 */
const WorkerModule = (() => {
  let workers = [];

  function statusBadge(s) {
    const cls = s.toUpperCase().replace(/\s+/g, '-');
    return `<span class="status-badge ${cls}">${s}</span>`;
  }

  function render(data) {
    workers = data.workers;
    const tbody = document.getElementById('workers-tbody');
    const dangerCount = document.getElementById('worker-danger-count');

    const danger = workers.filter(w => w.status !== 'SAFE').length;
    if (dangerCount) dangerCount.textContent = danger;
    document.getElementById('kpi-workers-danger').textContent = `${danger} in danger zone`;

    if (tbody) {
      tbody.innerHTML = workers.map(w => `
        <tr>
          <td style="font-weight:700;color:var(--text-primary)">${w.name}</td>
          <td style="font-family:'JetBrains Mono',monospace;color:var(--text-muted)">${w.id}</td>
          <td style="color:var(--text-secondary)">${w.role}</td>
          <td style="font-family:'JetBrains Mono',monospace">${w.latitude.toFixed(5)}</td>
          <td style="font-family:'JetBrains Mono',monospace">${w.longitude.toFixed(5)}</td>
          <td style="font-family:'JetBrains Mono',monospace;color:${w.distance_m < 20 ? 'var(--risk-critical)' : w.distance_m < 50 ? 'var(--risk-high)' : 'var(--risk-low)'}">${w.distance_m} m</td>
          <td>${statusBadge(w.status)}</td>
          <td style="color:var(--text-muted)">${w.speed_kmh} km/h</td>
        </tr>
      `).join('');
    }

    renderProximityAlerts(workers);
    Charts.renderWorkerBar(workers);
  }

  function renderProximityAlerts(workers) {
    const container = document.getElementById('worker-proximity-alerts');
    if (!container) return;
    const atRisk = workers.filter(w => w.status !== 'SAFE');
    if (atRisk.length === 0) {
      container.innerHTML = '<div style="color:var(--risk-low);padding:16px;text-align:center;font-size:0.85rem">✅ All workers in safe zones</div>';
      return;
    }
    container.innerHTML = atRisk.map(w => {
      const eta = Math.round(w.distance_m / (w.speed_kmh / 3.6 || 1));
      return `
        <div class="proximity-alert" style="border-color:${w.status === 'CRITICAL' ? 'var(--risk-critical)' : 'var(--risk-high)'}">
          <div class="pa-header">
            <span class="pa-name" style="color:${w.status === 'CRITICAL' ? 'var(--risk-critical)' : 'var(--risk-high)'}">${w.name}</span>
            <span class="status-badge ${w.status}">${w.status}</span>
          </div>
          <div class="pa-dist">📍 Distance to hazard: <strong>${w.distance_m}m</strong></div>
          <div class="pa-eta">⏱ Estimated arrival at hazard: <strong>${eta}s</strong></div>
          <div class="pa-action" style="margin-top:6px">
            ${w.status === 'CRITICAL'
              ? '🚨 IMMEDIATE EVACUATION REQUIRED — Alert supervisor now'
              : '⚠️ Warning issued — Monitor movement closely'}
          </div>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button class="btn btn-danger" style="padding:4px 10px;font-size:0.75rem" onclick="App.showToast('Evacuation alert sent to ${w.name}','warning')">Send Alert</button>
            <button class="btn btn-outline" style="padding:4px 10px;font-size:0.75rem" onclick="App.showToast('Supervisor notified','info')">Notify Supervisor</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function refresh() {
    const coords = typeof App !== 'undefined' ? App.getActiveCoords() : { lat: 20.5937, lon: 78.9629 };
    const data = await API.getWorkers(coords.lat, coords.lon);
    if (data) render(data);
  }

  return { refresh, render };
})();


/**
 * MineShield Risk Module
 */
const RiskModule = (() => {
  const RECO_ICONS = {
    LOW:      ['✅','📋','🔍'],
    MODERATE: ['⚡','🔍','📢','🌧'],
    HIGH:     ['⚠️','🚧','📡','📢'],
    CRITICAL: ['🚨','🏃','💣','🚁','📞'],
  };

  function render(data) {
    const prob = data.vulnerability_probability;
    const risk = data.risk_level;

    // Update big gauge
    Charts.drawGauge('bigRiskGauge', prob, risk);
    document.getElementById('big-prob').textContent     = prob.toFixed(4);
    document.getElementById('big-risk-label').textContent = risk;
    document.getElementById('big-prob').style.color = Charts.riskColor(prob);

    // Meta
    document.getElementById('meta-mine-id').textContent = data.mine_id || '--';
    document.getElementById('meta-date').textContent    = data.observation_date || '--';
    document.getElementById('meta-dist').textContent    = `${data.distance_km ?? '--'} km`;

    // Highlight active risk level card
    ['LOW','MODERATE','HIGH','CRITICAL'].forEach(r => {
      document.getElementById(`rl-${r.toLowerCase()}`)?.classList.toggle('active', r === risk);
    });

    // Recommendations & XAI
    const recoContainer = document.getElementById('risk-recommendations');
    if (data.recommendations) {
      const icons = RECO_ICONS[risk] || [];
      const html = data.recommendations.map((r, i) => `
        <div class="reco-item">
          <span class="reco-icon">${icons[i] || '•'}</span>
          <span>${r}</span>
        </div>
      `).join('');
      if (recoContainer) recoContainer.innerHTML = html;
    }

    if (data.explainable_ai) {
      const xai = data.explainable_ai;
      const scoreEl = document.getElementById('xai-score');
      const confEl = document.getElementById('xai-confidence');
      const factorsEl = document.getElementById('xai-factors');
      const actionsEl = document.getElementById('xai-actions');
      
      if (scoreEl) scoreEl.textContent = `${xai.risk_score}% (${risk})`;
      if (confEl) confEl.textContent = `${Math.round(xai.confidence * 100)}%`;
      
      if (factorsEl && xai.contributing_factors) {
        factorsEl.innerHTML = xai.contributing_factors.map(f => {
          const color = f.direction === 'increases_risk' ? 'var(--risk-critical)' : 'var(--blue)';
          return `
            <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
              <span style="color:var(--text-secondary);">${f.feature}</span>
              <strong style="color:${color}; font-family:'JetBrains Mono',monospace;">+${f.impact.toFixed(4)}</strong>
            </div>
          `;
        }).join('');
      }
      
      if (actionsEl && xai.recommended_action_plan) {
        actionsEl.innerHTML = xai.recommended_action_plan.map(a => `
          <div style="display:flex; gap:6px; align-items:flex-start; font-size: 0.74rem;">
            <span style="color:var(--risk-high);">▪</span>
            <span>${a}</span>
          </div>
        `).join('');
      }
    }

    // Dashboard gauge
    Charts.drawGauge('riskGaugeChart', prob, risk, true);
    document.getElementById('gauge-label').textContent = risk;
    document.getElementById('gauge-prob').textContent  = prob.toFixed(4);
    document.getElementById('gauge-prob').style.color  = Charts.riskColor(prob);

    // KPI card
    const kpiVal   = document.getElementById('kpi-risk-value');
    const kpiProb  = document.getElementById('kpi-risk-prob');
    const kpiBadge = document.getElementById('kpi-risk-badge');
    if (kpiVal) kpiVal.textContent = risk;
    if (kpiProb) kpiProb.textContent = `Probability: ${prob.toFixed(4)}`;
    if (kpiBadge) {
      kpiBadge.textContent = risk;
      kpiBadge.className   = `kpi-badge ${risk.toLowerCase()}`;
    }

    // Add to timeline
    Charts.addPrediction(prob);

    // Trigger alert if high risk
    AlertsModule.fromRisk(prob, data.mine_id);
  }

  async function runLivePrediction() {
    const btn = document.getElementById('run-prediction-btn');
    if (btn) { btn.textContent = 'Running…'; btn.disabled = true; }
    const coords = typeof App !== 'undefined' ? App.getActiveCoords() : { lat: 20.5937, lon: 78.9629 };
    const data = await API.getLivePrediction(coords.lat, coords.lon);
    if (btn) { btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Live Prediction'; btn.disabled = false; }
    if (data) {
      render(data);
      App.showToast(`Prediction: ${data.risk_level} (${data.vulnerability_probability.toFixed(4)})`,
        data.risk_level === 'CRITICAL' ? 'error' : data.risk_level === 'HIGH' ? 'warning' : 'success');
    } else {
      App.showToast('Backend unreachable — using demo data', 'warning');
      renderDemo();
    }
  }

  function renderDemo() {
    render({
      mine_id: 'MINE-OB-001',
      observation_date: new Date().toISOString().slice(0, 10),
      vulnerability_probability: 0.7823,
      risk_level: 'HIGH',
      distance_km: 0.3,
      recommendations: [
        'Restrict heavy equipment movement near slope.',
        'Deploy additional slope sensors.',
        'Issue site-wide advisory.',
        'Notify geotechnical engineer.',
      ],
    });
  }

  return { runLivePrediction, render, renderDemo };
})();
