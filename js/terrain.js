/**
 * terrain.js — MineShield Terrain Panel Module
 * ─────────────────────────────────────────────
 * Handles all UI rendering for the GEE-powered Terrain Analysis Panel.
 * Exposes window.TerrainPanel for use from index.html onclick handlers.
 */
const TerrainPanel = (() => {
  let _lastData = null;
  let _loading  = false;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _el(id) { return document.getElementById(id); }

  function _confLabel(conf) {
    if (conf >= 0.90) return { text: 'High ▲',  cls: 'conf-high' };
    if (conf >= 0.70) return { text: 'Medium ◆', cls: 'conf-med'  };
    return              { text: 'Simulated ◻',   cls: 'conf-low'  };
  }

  function getRiskColor(cls) {
    if (cls === 'Low') return 'rgba(34, 197, 94, 0.12)';
    if (cls === 'Moderate') return 'rgba(234, 179, 8, 0.12)';
    if (cls === 'High') return 'rgba(249, 115, 22, 0.12)';
    return 'rgba(239, 68, 68, 0.12)'; // Very High
  }

  function getRiskTextColor(cls) {
    if (cls === 'Low') return '#22c55e';
    if (cls === 'Moderate') return '#eab308';
    if (cls === 'High') return '#f97316';
    return '#ef4444'; // Very High
  }

  function _setCard(ids, value, pct, conf, source, acqDate, classification = '') {
    const { value: vId, progress: pId, conf: cId, source: sId, date: dId } = ids;

    const vEl = _el(vId);
    if (vEl) {
      if (classification) {
        const bg = getRiskColor(classification);
        const textCol = getRiskTextColor(classification);
        vEl.innerHTML = `${value} <span style="font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 800; margin-left: 6px; background: ${bg}; color: ${textCol}; border: 1px solid ${textCol}33; text-transform: uppercase;">${classification}</span>`;
      } else {
        vEl.textContent = value;
      }
    }

    const pEl = _el(pId);
    if (pEl) {
      pEl.style.width = Math.min(100, Math.max(0, pct || 0)) + '%';
      if (classification) {
        pEl.style.backgroundColor = getRiskTextColor(classification);
      }
    }

    const cEl = _el(cId);
    if (cEl) {
      const { text, cls } = _confLabel(conf);
      cEl.textContent = `${text} (${Math.round(conf * 100)}%)`;
      cEl.className   = `tfc-confidence-pill ${cls}`;
    }

    const sEl = _el(sId);
    if (sEl) sEl.textContent = source || '—';

    const dEl = _el(dId);
    if (dEl) dEl.textContent = acqDate ? `📅 ${acqDate}` : '—';
  }

  function _setHeader(data) {
    const isGEE     = data.data_source === 'GEE';
    const dotEl     = _el('terrain-datasrc-dot');
    const labelEl   = _el('terrain-datasrc-label');
    const updatedEl = _el('terrain-updated-label');
    const cacheEl   = _el('terrain-cache-status');

    if (dotEl)     dotEl.className = `terrain-datasrc-dot ${isGEE ? 'dot-gee' : 'dot-sim'}`;
    if (labelEl)   labelEl.textContent = isGEE ? '🛰 Live GEE Data' : '⚙ Simulated Data';
    if (updatedEl) {
      const ts = data.timestamp ? new Date(data.timestamp).toLocaleString('en-IN') : '—';
      updatedEl.textContent = `Updated: ${ts}`;
    }
    if (cacheEl) {
      const ttl = data.cache_ttl_minutes;
      cacheEl.textContent = ttl ? `Cache TTL: ${ttl} min` : 'Cache: No';
    }

    // Update group source labels
    const m = data.metadata || {};
    const demSrc = (m.elevation_m || {}).source || 'Copernicus GLO-30 DEM';
    const s2Src  = (m.ndvi || {}).source        || 'Sentinel-2 SR';
    const s1Src  = (m.vv_db || {}).source       || 'Sentinel-1 GRD';
    const lcSrc  = (m.land_cover_class || {}).source || 'ESA WorldCover';
    const smSrc  = (m.soil_moisture || {}).source    || 'NASA SMAP';

    if (_el('tgl-src-dem')) _el('tgl-src-dem').textContent = demSrc;
    if (_el('tgl-src-s2'))  _el('tgl-src-s2').textContent  = s2Src;
    if (_el('tgl-src-s1'))  _el('tgl-src-s1').textContent  = s1Src;
    if (_el('tgl-src-lc'))  _el('tgl-src-lc').textContent  = `${lcSrc} · ${smSrc}`;
  }

  function _meta(data, key) {
    const m = (data.metadata || {})[key] || {};
    return {
      conf:  m.confidence  || 0.55,
      src:   m.source      || 'Simulated',
      date:  m.acquisition_date || 'N/A',
    };
  }

  // ── Populate all 12 metric cards ─────────────────────────────────────────

  function _populateCards(data) {
    const m = (key) => _meta(data, key);

    // 1. Elevation Risk Classification
    const elevVal = data.elevation_m || 0;
    let elevCls = 'Low';
    if (elevVal >= 800) elevCls = 'Very High';
    else if (elevVal >= 600) elevCls = 'High';
    else if (elevVal >= 400) elevCls = 'Moderate';

    _setCard(
      { value: 'tv-elevation', progress: 'tp-elevation', conf: 'tcp-elevation', source: 'ts-elevation', date: 'tad-elevation' },
      `${elevVal.toFixed(1)}`,
      (elevVal / 2500) * 100,
      m('elevation_m').conf, m('elevation_m').src, m('elevation_m').date,
      elevCls
    );

    // 2. Slope Risk Classification
    const slopeVal = data.slope_deg || 0;
    let slopeCls = 'Low';
    if (slopeVal >= 30) slopeCls = 'Very High';
    else if (slopeVal >= 15) slopeCls = 'High';
    else if (slopeVal >= 5) slopeCls = 'Moderate';

    _setCard(
      { value: 'tv-slope', progress: 'tp-slope', conf: 'tcp-slope', source: 'ts-slope', date: 'tad-slope' },
      slopeVal.toFixed(2),
      (slopeVal / 90) * 100,
      m('slope_deg').conf, m('slope_deg').src, m('slope_deg').date,
      slopeCls
    );

    // 3. TRI (Low/Mod/High/Very High)
    const triVal = data.tri || 0;
    let triCls = 'Low';
    if (triVal > 35) triCls = 'Very High';
    else if (triVal > 20) triCls = 'High';
    else if (triVal > 10) triCls = 'Moderate';

    _setCard(
      { value: 'tv-tri', progress: 'tp-tri', conf: 'tcp-tri', source: 'ts-tri', date: 'tad-tri' },
      triVal.toFixed(3),
      (Math.min(triVal, 60) / 60) * 100,
      m('tri').conf, m('tri').src, m('tri').date,
      triCls
    );

    // 4. TPI
    const tpiVal = data.tpi || 0;
    let tpiCls = 'Low';
    if (Math.abs(tpiVal) > 10) tpiCls = 'High';
    else if (Math.abs(tpiVal) > 4) tpiCls = 'Moderate';

    _setCard(
      { value: 'tv-tpi', progress: 'tp-tpi', conf: 'tcp-tpi', source: 'ts-tpi', date: 'tad-tpi' },
      tpiVal.toFixed(3),
      Math.min(100, (Math.abs(tpiVal) / 15) * 100),
      m('tpi').conf, m('tpi').src, m('tpi').date,
      tpiCls
    );

    // 5. Terrain Roughness
    const roughVal = data.terrain_roughness || 0;
    let roughCls = 'Low';
    if (roughVal > 60) roughCls = 'Very High';
    else if (roughVal > 30) roughCls = 'High';
    else if (roughVal > 15) roughCls = 'Moderate';

    _setCard(
      { value: 'tv-roughness', progress: 'tp-roughness', conf: 'tcp-roughness', source: 'ts-roughness', date: 'tad-roughness' },
      roughVal.toFixed(2),
      (Math.min(roughVal, 100) / 100) * 100,
      m('terrain_roughness').conf, m('terrain_roughness').src, m('terrain_roughness').date,
      roughCls
    );

    // 6. NDVI
    const ndvi = data.ndvi || 0;
    let ndviCls = 'Low';
    if (ndvi < 0.1) ndviCls = 'High';
    else if (ndvi < 0.25) ndviCls = 'Moderate';

    _setCard(
      { value: 'tv-ndvi', progress: 'tp-ndvi', conf: 'tcp-ndvi', source: 'ts-ndvi', date: 'tad-ndvi' },
      ndvi.toFixed(4),
      Math.max(0, ((ndvi + 1) / 2) * 100),
      m('ndvi').conf, m('ndvi').src, m('ndvi').date,
      ndviCls
    );

    // 7. NDWI
    const ndwi = data.ndwi || 0;
    let ndwiCls = 'Low';
    if (ndwi > 0.1) ndwiCls = 'High';
    else if (ndwi > -0.1) ndwiCls = 'Moderate';

    _setCard(
      { value: 'tv-ndwi', progress: 'tp-ndwi', conf: 'tcp-ndwi', source: 'ts-ndwi', date: 'tad-ndwi' },
      ndwi.toFixed(4),
      Math.max(0, ((ndwi + 1) / 2) * 100),
      m('ndwi').conf, m('ndwi').src, m('ndwi').date,
      ndwiCls
    );

    // 8. BSI
    const bsi = data.bsi || 0;
    let bsiCls = 'Low';
    if (bsi > 0.35) bsiCls = 'Very High';
    else if (bsi > 0.2) bsiCls = 'High';
    else if (bsi > 0.1) bsiCls = 'Moderate';

    _setCard(
      { value: 'tv-bsi', progress: 'tp-bsi', conf: 'tcp-bsi', source: 'ts-bsi', date: 'tad-bsi' },
      bsi.toFixed(4),
      Math.max(0, Math.min(100, ((bsi + 1) / 2) * 100)),
      m('bsi').conf, m('bsi').src, m('bsi').date,
      bsiCls
    );

    // 9. Rock Exposure (%)
    const rockPct = (data.rock_exposure || 0) * 100;
    let rockCls = 'Low';
    if (rockPct >= 75) rockCls = 'Very High';
    else if (rockPct >= 50) rockCls = 'High';
    else if (rockPct >= 25) rockCls = 'Moderate';

    _setCard(
      { value: 'tv-rock', progress: 'tp-rock', conf: 'tcp-rock', source: 'ts-rock', date: 'tad-rock' },
      rockPct.toFixed(1),
      rockPct,
      m('rock_exposure').conf, m('rock_exposure').src, m('rock_exposure').date,
      rockCls
    );
    const rockCard = _el('tfc-rock');
    if (rockCard) {
      rockCard.classList.toggle('tfc-high-alert', rockPct > 60);
    }

    // 10. VV Backscatter
    const vv = data.vv_db || -15;
    _setCard(
      { value: 'tv-vv', progress: 'tp-vv', conf: 'tcp-vv', source: 'ts-vv', date: 'tad-vv' },
      vv.toFixed(2),
      Math.max(0, ((vv + 30) / 30) * 100),
      m('vv_db').conf, m('vv_db').src, m('vv_db').date,
      vv > -8 ? 'High' : (vv > -12 ? 'Moderate' : 'Low')
    );

    // 11. VH Backscatter
    const vh = data.vh_db || -22;
    _setCard(
      { value: 'tv-vh', progress: 'tp-vh', conf: 'tcp-vh', source: 'ts-vh', date: 'tad-vh' },
      vh.toFixed(2),
      Math.max(0, ((vh + 35) / 35) * 100),
      m('vh_db').conf, m('vh_db').src, m('vh_db').date,
      vh > -15 ? 'High' : (vh > -20 ? 'Moderate' : 'Low')
    );

    // 12. Land Cover
    const lcEl  = _el('tv-lc');
    const lcCEl = _el('tcp-lc');
    const lcSEl = _el('ts-lc');
    const lcDEl = _el('tad-lc');
    const lcVal = data.land_cover_class || 'Bare Rock / Excavated Area';
    let lcCls = 'Low';
    if (lcVal.includes('Bare') || lcVal.includes('Excavated')) lcCls = 'Very High';
    else if (lcVal.includes('Waste') || lcVal.includes('Overburden')) lcCls = 'High';
    else if (lcVal.includes('Sparse') || lcVal.includes('Grassland')) lcCls = 'Moderate';

    if (lcEl) {
      const bg = getRiskColor(lcCls);
      const textCol = getRiskTextColor(lcCls);
      lcEl.innerHTML = `${lcVal} <span style="font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 800; margin-left: 6px; background: ${bg}; color: ${textCol}; border: 1px solid ${textCol}33; text-transform: uppercase;">${lcCls}</span>`;
    }
    if (lcCEl) {
      const { text, cls } = _confLabel(m('land_cover_class').conf);
      lcCEl.textContent = `${text} (${Math.round(m('land_cover_class').conf * 100)}%)`;
      lcCEl.className = `tfc-confidence-pill ${cls}`;
    }
    if (lcSEl) lcSEl.textContent  = m('land_cover_class').src  || '—';
    if (lcDEl) lcDEl.textContent  = m('land_cover_class').date ? `📅 ${m('land_cover_class').date}` : '—';

    // 13. Soil Moisture
    const sm = data.soil_moisture || 0;
    let smCls = 'Low';
    if (sm >= 0.35) smCls = 'Very High';
    else if (sm >= 0.25) smCls = 'High';
    else if (sm >= 0.15) smCls = 'Moderate';

    _setCard(
      { value: 'tv-sm', progress: 'tp-sm', conf: 'tcp-sm', source: 'ts-sm', date: 'tad-sm' },
      sm.toFixed(4),
      (sm / 0.5) * 100,
      m('soil_moisture').conf, m('soil_moisture').src, m('soil_moisture').date,
      smCls
    );
  }

  // ── XGBoost panel ─────────────────────────────────────────────────────────

  let _xgbOpen = false;

  function _updateXgbPanel(data) {
    const features = data.model_ready_features || {};
    const count    = Object.keys(features).length;
    const countEl  = _el('xgb-feature-count');
    const jsonEl   = _el('xgb-json-block');

    if (countEl) countEl.textContent = `${count} features`;
    if (jsonEl)  jsonEl.textContent  = JSON.stringify(features, null, 2);

    // Expose globally for SHAP / prediction pipeline
    window.TerrainFeatures = features;
  }

  function toggleXgb() {
    _xgbOpen = !_xgbOpen;
    const panel = _el('terrain-xgb-panel');
    const arrow = _el('xgb-arrow');
    if (panel) panel.style.display = _xgbOpen ? 'block' : 'none';
    if (arrow) arrow.textContent   = _xgbOpen ? '▲' : '▼';
  }

  function copyFeatures() {
    if (!window.TerrainFeatures) return;
    try {
      navigator.clipboard.writeText(JSON.stringify(window.TerrainFeatures, null, 2));
      if (typeof App !== 'undefined') App.showToast('Feature vector copied to clipboard!', 'success');
    } catch (e) {
      console.warn('Clipboard copy failed', e);
    }
  }

  // ── Skeleton loaders ──────────────────────────────────────────────────────

  function _showSkeleton() {
    const valueIds = [
      'tv-elevation','tv-slope','tv-tri','tv-tpi','tv-roughness',
      'tv-ndvi','tv-ndwi','tv-bsi','tv-rock',
      'tv-vv','tv-vh',
      'tv-lc','tv-sm'
    ];
    valueIds.forEach(id => {
      const el = _el(id);
      if (el) el.innerHTML = '<span class="tfc-skeleton"></span>';
    });
    // Reset progress bars
    ['tp-elevation','tp-slope','tp-tri','tp-tpi','tp-roughness',
     'tp-ndvi','tp-ndwi','tp-bsi','tp-rock','tp-vv','tp-vh','tp-sm'].forEach(id => {
      const el = _el(id);
      if (el) el.style.width = '0%';
    });
    // Status
    const labelEl  = _el('terrain-datasrc-label');
    const cacheEl  = _el('terrain-cache-status');
    if (labelEl) labelEl.textContent = 'Fetching GEE data…';
    if (cacheEl) cacheEl.textContent = 'Cache: —';
  }

  // ── Fallback display ──────────────────────────────────────────────────────

  function _showError() {
    const labelEl = _el('terrain-datasrc-label');
    if (labelEl) labelEl.textContent = '⚠ Data unavailable';
    if (typeof App !== 'undefined') App.showToast('Terrain data unavailable — check backend.', 'error');
  }

  // ── Main refresh ─────────────────────────────────────────────────────────

  async function refresh() {
    if (_loading) return;
    _loading = true;

    _showSkeleton();

    // Animate refresh button
    const btn = _el('btn-terrain-refresh');
    if (btn) btn.classList.add('spinning');

    try {
      const coords = (typeof App !== 'undefined') ? App.getActiveCoords() : { lat: 20.5937, lon: 78.9629 };
      const data   = await API.getTerrain(coords.lat, coords.lon);

      if (!data) {
        _showError();
        return;
      }

      _lastData = data;

      // Header badges
      _setHeader(data);

      // Populate all metric cards
      _populateCards(data);

      // Charts
      if (typeof Charts !== 'undefined') {
        Charts.renderTerrainRadar(data);
        Charts.renderSar(data);
      }

      // XGBoost feature panel
      _updateXgbPanel(data);

    } catch (err) {
      console.error('[TerrainPanel] Refresh failed:', err);
      _showError();
    } finally {
      _loading = false;
      if (btn) btn.classList.remove('spinning');
    }
  }

  return { refresh, toggleXgb, copyFeatures };
})();

// Expose globally
window.TerrainPanel = TerrainPanel;
