/**
 * MineShield Leaflet Map Module
 */
const MapModule = (() => {
  let map = null;
  let heatLayer = null;
  let workerLayer = null;
  let droneLayer = null;
  let zoneLayer  = null;
  let boundaryLayer = null;
  let userMarker = null;
  let mineMarkers = [];
  let initialized = false;
  let firstLock = true;

  let MINE_CENTER = { lat: 20.5937, lon: 78.9629 };
  let _verified = true;
  let _confidence = 1.0;
  let _weatherAvailable = true;
  let _terrainAvailable = true;
  let recentSearches = JSON.parse(localStorage.getItem('recent_searches') || '[]');

  function showSearchSuggestions(show) {
    const listEl = document.getElementById('search-suggestions');
    if (!listEl) return;
    if (show) {
      listEl.style.display = 'block';
      renderSuggestions('');
    } else {
      setTimeout(() => {
        listEl.style.display = 'none';
      }, 250);
    }
  }

  function handleSearchInput(query) {
    const clearBtn = document.getElementById('btn-clear-search');
    if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
    renderSuggestions(query);
  }

  function clearSearch() {
    const input = document.getElementById('map-search-input');
    if (input) input.value = '';
    const clearBtn = document.getElementById('btn-clear-search');
    if (clearBtn) clearBtn.style.display = 'none';
    renderSuggestions('');
  }

  let searchTimeout = null;
  function renderSuggestions(query) {
    const listEl = document.getElementById('search-suggestions');
    if (!listEl) return;

    if (!query) {
      if (recentSearches.length === 0) {
        listEl.innerHTML = `
          <div style="padding: 10px 14px; font-size: 0.78rem; color: var(--text-muted); text-align: center;">
            Type to search address, coordinates, or mine names
          </div>
        `;
        return;
      }
      listEl.innerHTML = `
        <div style="padding: 8px 12px 4px 12px; font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 800; border-bottom: 1px solid rgba(255,255,255,0.04);">Recent Searches</div>
        ${recentSearches.map((s, i) => `
          <div class="suggestion-item" onclick="MapModule.selectSuggestion(${s.lat}, ${s.lon}, '${s.name.replace(/'/g, "\\'")}', true)">
            <span class="suggestion-history-icon">🕒</span>
            <div>
              <span class="suggestion-title">${s.name}</span>
              <span class="suggestion-subtitle">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</span>
            </div>
          </div>
        `).join('')}
      `;
      return;
    }

    const registeredMines = [
      { name: "Odisha Bauxite Mine", lat: 20.5937, lon: 83.9629, id: "MINE-OB-001" },
      { name: "Jharkhand Iron & Steel Mine", lat: 23.6102, lon: 85.2799, id: "MINE-JH-001" },
      { name: "Rajasthan Marble Mine", lat: 25.2138, lon: 75.8648, id: "MINE-RJ-001" },
      { name: "Madhya Pradesh Coal Mine", lat: 22.9734, lon: 78.6569, id: "MINE-MP-001" },
      { name: "Chhattisgarh Iron Mine", lat: 21.2787, lon: 81.8661, id: "MINE-CG-001" },
      { name: "Karnataka Gold Mine", lat: 15.3173, lon: 75.7139, id: "MINE-KA-001" },
      { name: "Gujarat Limestone Mine", lat: 22.2587, lon: 71.1924, id: "MINE-GJ-001" },
      { name: "Andhra Pradesh Granite Mine", lat: 15.9129, lon: 79.7400, id: "MINE-AP-001" },
      { name: "Tamil Nadu Chromite Mine", lat: 11.1271, lon: 78.6569, id: "MINE-TN-001" },
      { name: "West Bengal Copper Mine", lat: 23.5000, lon: 87.1200, id: "MINE-WB-001" }
    ];
    const matches = registeredMines.filter(m => m.name.toLowerCase().includes(query.toLowerCase()));

    let html = matches.map(m => `
      <div class="suggestion-item" onclick="MapModule.selectSuggestion(${m.lat}, ${m.lon}, '${m.name.replace(/'/g, "\\'")}', false)">
        <span class="suggestion-icon">📍</span>
        <div>
          <span class="suggestion-title">${m.name}</span>
          <span class="suggestion-subtitle">Registered Monitored Mine Site</span>
        </div>
      </div>
    `).join('');

    listEl.innerHTML = html || `<div style="padding: 10px 14px; font-size: 0.78rem; color: var(--text-muted); text-align: center;">Searching...</div>`;

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { "Accept-Language": "en" } });
        const data = await res.json();
        
        if (data && data.length > 0) {
          const osmHtml = data.map(item => {
            const lat = parseFloat(item.lat);
            const lon = parseFloat(item.lon);
            const name = item.display_name.split(',')[0];
            const sub = item.display_name.split(',').slice(1).join(',').trim();
            return `
              <div class="suggestion-item" onclick="MapModule.selectSuggestion(${lat}, ${lon}, '${name.replace(/'/g, "\\'")}', false)">
                <span class="suggestion-icon">🗺️</span>
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  <span class="suggestion-title">${name}</span>
                  <span class="suggestion-subtitle">${sub}</span>
                </div>
              </div>
            `;
          }).join('');
          
          listEl.innerHTML = (html + osmHtml) || `
            <div style="padding: 10px 14px; font-size: 0.78rem; color: var(--text-muted); text-align: center;">
              No results found
            </div>
          `;
        }
      } catch (err) {
        console.warn("Nominatim autocomplete failed:", err);
      }
    }, 450);
  }

  function selectSuggestion(lat, lon, name, isHistory) {
    if (!isHistory) {
      recentSearches = recentSearches.filter(s => s.name !== name);
      recentSearches.unshift({ name, lat, lon });
      if (recentSearches.length > 5) recentSearches.pop();
      localStorage.setItem('recent_searches', JSON.stringify(recentSearches));
    }

    const input = document.getElementById('map-search-input');
    if (input) input.value = name;
    showSearchSuggestions(false);

    MINE_CENTER.lat = lat;
    MINE_CENTER.lon = lon;
    if (map) {
      map.setView([lat, lon], 14);
    }
    
    if (typeof App !== 'undefined') {
      App.userLocation = { lat, lon };
    }
    
    const selector = document.getElementById('mine-selector');
    if (selector) {
      selector.value = 'GPS';
    }

    if (typeof App !== 'undefined' && App.refreshAll) {
      App.refreshAll();
    }
  }

  function updateLocationPanel(lat, lon, mineName, distKm, verified) {
    const locHeader = document.getElementById('loc-status-header');
    const locMine = document.getElementById('loc-mine-name');
    const locDist = document.getElementById('loc-mine-dist');
    const locMode = document.getElementById('loc-mon-mode');
    
    const modeBadge = document.getElementById('map-mode-badge');
    const modeDot = document.getElementById('map-mode-dot');
    const modeText = document.getElementById('map-mode-text');

    if (verified) {
      if (locHeader) {
        locHeader.textContent = '🛡️ VERIFIED MINE';
        locHeader.style.color = '#22c55e';
      }
      if (locMine) locMine.textContent = mineName;
      if (locDist) locDist.textContent = `${distKm.toFixed(2)} km`;
      if (locMode) {
        locMode.textContent = 'VERIFIED';
        locMode.style.background = 'rgba(34,197,94,0.12)';
        locMode.style.color = '#22c55e';
      }
      if (modeBadge) {
        modeBadge.style.background = 'rgba(34,197,94,0.15)';
        modeBadge.style.color = '#22c55e';
        modeBadge.style.borderColor = 'rgba(34,197,94,0.3)';
      }
      if (modeDot) modeDot.style.background = '#22c55e';
      if (modeText) modeText.textContent = 'MINE ACCESS MODE';
    } else {
      if (locHeader) {
        locHeader.textContent = '⚠️ UNREGISTERED AREA';
        locHeader.style.color = '#eab308';
      }
      if (locMine) locMine.textContent = 'No Monitored Mine';
      if (locDist) locDist.textContent = 'N/A';
      if (locMode) {
        locMode.textContent = 'PUBLIC';
        locMode.style.background = 'rgba(234,179,8,0.12)';
        locMode.style.color = '#eab308';
      }
      if (modeBadge) {
        modeBadge.style.background = 'rgba(234,179,8,0.15)';
        modeBadge.style.color = '#eab308';
        modeBadge.style.borderColor = 'rgba(234,179,8,0.3)';
      }
      if (modeDot) modeDot.style.background = '#eab308';
      if (modeText) modeText.textContent = 'PUBLIC MONITORING MODE';
      
      if (typeof App !== 'undefined') {
        App.showToast('No Registered Mine Found. Current location is outside monitored mining areas.', 'warning');
      }
    }
  }

  // Tile layers
  const LAYERS = {
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri World Imagery', maxZoom: 19 }
    ),
    terrain: L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { attribution: '© OpenTopoMap', maxZoom: 17 }
    ),
    dark: L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { attribution: '© CartoDB', maxZoom: 20 }
    ),
  };
  let currentLayer = 'satellite';

  function workerIcon(w) {
    const color = w.status === 'CRITICAL' ? '#ef4444' : w.status === 'WARNING' ? '#f97316' : '#22c55e';
    return L.divIcon({
      html: `<div class="worker-marker" style="background:${color}">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="white" stroke="none">
                 <path d="M12 12c2.21 0 4-1.79 4-4S14.21 4 12 4 8 5.79 8 8s1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
               </svg>
             </div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  function droneIcon() {
    return L.divIcon({
      html: `<div class="drone-marker">🚁</div>`,
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }

  function mineIcon(riskLevel) {
    const colors = { LOW: '#22c55e', MODERATE: '#eab308', HIGH: '#f97316', CRITICAL: '#ef4444' };
    const c = colors[riskLevel] || '#94a3b8';
    return L.divIcon({
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${c};border:2px solid white;box-shadow:0 0 8px ${c}"></div>`,
      className: '',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function userIcon() {
    return L.divIcon({
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:3px solid white;box-shadow:0 0 12px #3b82f6;animation:drone-pulse 2s infinite"></div>`,
      className: '',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  function init() {
    if (initialized) return;
    const el = document.getElementById('live-map');
    if (!el) return;

    map = L.map('live-map', {
      center: [MINE_CENTER.lat, MINE_CENTER.lon],
      zoom: 13,
      zoomControl: true,
    });

    LAYERS.satellite.addTo(map);
    workerLayer = L.layerGroup().addTo(map);
    droneLayer  = L.layerGroup().addTo(map);
    zoneLayer   = L.layerGroup().addTo(map);

    boundaryLayer = L.layerGroup().addTo(map);

    drawHazardZones();
    drawMineBoundary();
    startGPS();
    loadMines();
    refreshWorkers();
    placeDrone();
    buildHeatmap();

    initialized = true;
  }

  function drawMineBoundary() {
    if (!boundaryLayer) return;
    boundaryLayer.clearLayers();
    if (!_verified) return;

    const selector = document.getElementById('mine-selector');

    let mineName = 'Odisha Bauxite Mine';
    let sectorName = 'Sector 7-Alpha';
    if (selector) {
      const opt = selector.options[selector.selectedIndex];
      if (opt && opt.value !== 'GPS') {
        const parts = opt.text.replace('📍 ', '').split(' — ');
        if (parts.length > 0) mineName = parts[0];
        if (parts.length > 1) sectorName = parts[1];
      } else {
        mineName = 'Active Area';
        sectorName = 'GPS Boundary';
      }
    }

    const center = [MINE_CENTER.lat, MINE_CENTER.lon];
    const r = 0.012;
    const pts = [
      [center[0] - r,     center[1] - r * 1.2],
      [center[0] - r,     center[1] + r * 1.5],
      [center[0] + r * 0.8, center[1] + r * 1.8],
      [center[0] + r * 1.4, center[1] + r * 0.5],
      [center[0] + r * 1.2, center[1] - r],
      [center[0] + r * 0.3, center[1] - r * 1.5],
    ];
    L.polygon(pts, {
      color: '#f97316',
      weight: 2,
      dashArray: '6,4',
      fillColor: '#f97316',
      fillOpacity: 0.04,
    }).addTo(boundaryLayer).bindPopup(`<b>Mine Boundary</b><br>${mineName}<br>${sectorName}`);
  }

  function drawHazardZones() {
    zoneLayer.clearLayers();
    if (!_verified) return;

    // Safe Zones
    const safeZones = [
      { lat: MINE_CENTER.lat - 0.0012, lon: MINE_CENTER.lon - 0.0015, r: 40, color: '#22c55e', label: 'Odisha Central Admin Safe Zone' },
      { lat: MINE_CENTER.lat + 0.0015, lon: MINE_CENTER.lon - 0.0015, r: 35, color: '#10b981', label: 'Sector 7 Muster Safe Zone' },
    ];
    safeZones.forEach(sz => {
      L.circle([sz.lat, sz.lon], {
        radius: sz.r,
        color: sz.color,
        weight: 2.5,
        fillColor: sz.color,
        fillOpacity: 0.22,
      }).addTo(zoneLayer).bindPopup(`<b>🛡️ Safe Zone</b><br>${sz.label}`);
    });

    const zones = [
      { lat: MINE_CENTER.lat + 0.0003, lon: MINE_CENTER.lon + 0.0003, r: 85, color: '#ef4444', label: 'Critical Hazard Zone (Slope)' },
      { lat: MINE_CENTER.lat - 0.004, lon: MINE_CENTER.lon + 0.005, r: 250, color: '#f97316', label: 'High Risk Zone' },
      { lat: MINE_CENTER.lat + 0.006, lon: MINE_CENTER.lon - 0.004, r: 200, color: '#eab308', label: 'Moderate Risk Zone' },
    ];
    zones.forEach(z => {
      L.circle([z.lat, z.lon], {
        radius: z.r,
        color: z.color,
        weight: 1.5,
        fillColor: z.color,
        fillOpacity: 0.12,
      }).addTo(zoneLayer).bindPopup(`<b>${z.label}</b>`);
    });
  }

  function buildHeatmap() {
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }
    if (!_verified || _confidence < 0.60 || !_weatherAvailable || !_terrainAvailable) {
      return;
    }
    const points = [];
    const cx = MINE_CENTER.lat, cy = MINE_CENTER.lon;
    // Generate realistic heatmap data around mine
    for (let i = 0; i < 80; i++) {
      const lat = cx + (Math.random() - 0.5) * 0.03;
      const lon = cy + (Math.random() - 0.5) * 0.03;
      const intensity = Math.pow(Math.random(), 0.5);
      points.push([lat, lon, intensity]);
    }
    // Hot spots near hazard zones
    for (let i = 0; i < 30; i++) {
      points.push([cx + 0.003 + Math.random() * 0.003, cy + 0.003 + Math.random() * 0.003, 0.8 + Math.random() * 0.2]);
    }
    if (window.L && L.heatLayer) {
      heatLayer = L.heatLayer(points, {
        radius: 35,
        blur: 20,
        maxZoom: 16,
        gradient: { 0.0: '#22c55e', 0.25: '#eab308', 0.5: '#f97316', 0.75: '#dc2626', 1.0: '#7f1d1d' },
      }).addTo(map);
    }
  }

  function placeDrone() {
    droneLayer.clearLayers();
    const dlat = MINE_CENTER.lat + 0.002;
    const dlon = MINE_CENTER.lon + 0.004;
    L.marker([dlat, dlon], { icon: droneIcon() })
      .addTo(droneLayer)
      .bindPopup('<b>QUAD-ATLAS-02</b><br>Altitude: 45m<br>Battery: 67%<br>Coverage: 12,000 m²');
    // Animate drone
    let angle = 0;
    setInterval(() => {
      angle += 0.05;
      const lat = MINE_CENTER.lat + 0.002 + Math.sin(angle) * 0.003;
      const lon = MINE_CENTER.lon + 0.004 + Math.cos(angle) * 0.003;
      droneLayer.clearLayers();
      L.marker([lat, lon], { icon: droneIcon() })
        .addTo(droneLayer)
        .bindPopup('<b>QUAD-ATLAS-02</b><br>Altitude: 45m<br>Battery: 67%');
    }, 2000);
  }

  async function loadMines() {
    const data = await API.getMines();
    if (!data || !data.mines) return;
    mineMarkers.forEach(m => m.remove());
    mineMarkers = [];
    data.mines.forEach(mine => {
      const levels = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
      const rl = levels[Math.floor(Math.random() * levels.length)];
      const m = L.marker([mine.latitude, mine.longitude], { icon: mineIcon(rl) })
        .addTo(map)
        .bindPopup(`<b>${mine.name || mine.mine_id}</b><br>Risk: ${rl}`);
      mineMarkers.push(m);
    });
  }

  async function refreshWorkers() {
    if (!initialized) return;
    workerLayer.clearLayers();
    const data = await API.getWorkers(MINE_CENTER.lat, MINE_CENTER.lon);
    if (!data || !data.workers) return;
    data.workers.forEach(w => {
      L.marker([w.latitude, w.longitude], { icon: workerIcon(w) })
        .addTo(workerLayer)
        .bindPopup(`
          <b>${w.name}</b><br>
          ${w.role}<br>
          Distance to hazard: <b>${w.distance_m}m</b><br>
          Distance to safe zone: <b>${w.distance_safe_m || 0}m</b><br>
          Status: <span style="color:${w.status === 'SAFE' || w.status === 'Reached Safe Zone' ? '#22c55e' : w.status === 'WARNING' || w.status === 'Monitoring' ? '#f97316' : '#ef4444'}">${w.status}</span>
        `);

      // Evacuation path tracing
      if (w.status === 'Evacuating' || w.status === 'At Risk') {
        const safe_lat = MINE_CENTER.lat - 0.0012;
        const safe_lon = MINE_CENTER.lon - 0.0015;
        L.polyline([[w.latitude, w.longitude], [safe_lat, safe_lon]], {
          color: '#ef4444',
          weight: 2,
          dashArray: '6, 6',
          opacity: 0.8
        }).addTo(workerLayer);
      }
    });
  }

  function startGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      pos => {
        const { latitude: lat, longitude: lon, speed, heading } = pos.coords;
        const time = new Date().toLocaleTimeString();

        document.getElementById('gps-lat').textContent = lat.toFixed(6);
        document.getElementById('gps-lon').textContent = lon.toFixed(6);
        document.getElementById('gps-speed').textContent = speed ? `${(speed * 3.6).toFixed(1)} km/h` : '0.0 km/h';
        document.getElementById('gps-heading').textContent = heading ? `${heading.toFixed(0)}°` : '--°';
        document.getElementById('gps-time').textContent = time;

        if (typeof App !== 'undefined') {
          App.userLocation = { lat, lon };
        }

        const selector = document.getElementById('mine-selector');
        if (selector && selector.value === 'GPS') {
          const latChanged = Math.abs(MINE_CENTER.lat - lat) > 0.0001;
          const lonChanged = Math.abs(MINE_CENTER.lon - lon) > 0.0001;
          if (latChanged || lonChanged) {
            MINE_CENTER.lat = lat;
            MINE_CENTER.lon = lon;
            drawMineBoundary();
            drawHazardZones();
            buildHeatmap();
            refreshWorkers();
          }
        }

        if (!userMarker) {
          userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 1000 })
            .addTo(map)
            .bindPopup('<b>Your Location</b>');
        } else {
          userMarker.setLatLng([lat, lon]);
        }

        if (firstLock) {
          const selector = document.getElementById('mine-selector');
          if (selector && selector.value === 'GPS') {
            map.setView([lat, lon], 14);
          }
          firstLock = false;
        }
      },
      () => {
        // Fallback simulated GPS coordinates
        const lat = 12.804993;
        const lon = 80.033828;
        document.getElementById('gps-lat').textContent  = lat.toFixed(6);
        document.getElementById('gps-lon').textContent  = lon.toFixed(6);
        document.getElementById('gps-speed').textContent   = '3.2 km/h';
        document.getElementById('gps-heading').textContent = '45°';
        document.getElementById('gps-time').textContent    = new Date().toLocaleTimeString();

        if (typeof App !== 'undefined') {
          App.userLocation = { lat, lon };
        }

        const selector = document.getElementById('mine-selector');
        if (selector && selector.value === 'GPS') {
          const latChanged = Math.abs(MINE_CENTER.lat - lat) > 0.0001;
          const lonChanged = Math.abs(MINE_CENTER.lon - lon) > 0.0001;
          if (latChanged || lonChanged) {
            MINE_CENTER.lat = lat;
            MINE_CENTER.lon = lon;
            drawMineBoundary();
            drawHazardZones();
            buildHeatmap();
            refreshWorkers();
          }
        }

        if (!userMarker) {
          userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 1000 }).addTo(map).bindPopup('<b>Your Location</b>');
        } else {
          userMarker.setLatLng([lat, lon]);
        }

        if (firstLock) {
          map.setView([lat, lon], 14);
          firstLock = false;
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }

  let NEAREST_MINE_COORDS = { lat: 20.5937, lon: 83.9629, name: 'Odisha Bauxite Mine', id: 'MINE-OB-001' };

  function setNearestMine(lat, lon, id, verified = true, confidence = 1.0, weatherAvailable = true, terrainAvailable = true, distKm = 0.0) {
    _verified = verified;
    _confidence = confidence;
    _weatherAvailable = weatherAvailable;
    _terrainAvailable = terrainAvailable;

    NEAREST_MINE_COORDS.lat = lat;
    NEAREST_MINE_COORDS.lon = lon;
    NEAREST_MINE_COORDS.id = id;

    const selector = document.getElementById('mine-selector');
    let mineName = 'Active Area';
    if (selector) {
      for (let i = 0; i < selector.options.length; i++) {
        if (selector.options[i].value === id) {
          NEAREST_MINE_COORDS.name = selector.options[i].text.replace('📍 ', '').split(' — ')[0];
          break;
        }
      }
      mineName = NEAREST_MINE_COORDS.name;
    }

    updateLocationPanel(lat, lon, mineName, distKm, verified);

    if (selector && selector.value === 'GPS') {
      MINE_CENTER.lat = lat;
      MINE_CENTER.lon = lon;
      drawMineBoundary();
      drawHazardZones();
      refreshWorkers();
      buildHeatmap();
      placeDrone();
    }
  }

  function focusOnMine(mineId) {
    if (!map) return;
    let coords = null;
    if (mineId === 'GPS') {
      coords = typeof App !== 'undefined' ? App.userLocation : null;
      if (coords) {
        map.setView([coords.lat, coords.lon], 13);
      }
      MINE_CENTER.lat = NEAREST_MINE_COORDS.lat;
      MINE_CENTER.lon = NEAREST_MINE_COORDS.lon;
      drawMineBoundary();
      drawHazardZones();
      refreshWorkers();
      buildHeatmap();
      placeDrone();
      return;
    } else {
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
      coords = mineCoords[mineId];
    }
    
    if (coords) {
      MINE_CENTER.lat = coords.lat;
      MINE_CENTER.lon = coords.lon;
      map.setView([coords.lat, coords.lon], 13);
      drawMineBoundary();
      drawHazardZones();
      refreshWorkers();
      buildHeatmap();
      placeDrone();
    }
  }

  // Layer switching
  function setLayer(name) {
    if (!map) return;
    Object.values(LAYERS).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    LAYERS[name].addTo(map);
    currentLayer = name;
    document.querySelectorAll('.map-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`map-${name}-btn`)?.classList.add('active');
  }

  function toggleHeatmap(on) { if (!map || !heatLayer) return; on ? heatLayer.addTo(map) : map.removeLayer(heatLayer); }
  function toggleWorkers(on) { if (!map) return; on ? workerLayer.addTo(map) : map.removeLayer(workerLayer); }
  function toggleDrones(on)  { if (!map) return; on ? droneLayer.addTo(map)  : map.removeLayer(droneLayer); }
  function toggleZones(on)   { if (!map) return; on ? zoneLayer.addTo(map)   : map.removeLayer(zoneLayer); }

  // Live worker refresh every 10s
  setInterval(refreshWorkers, 10000);

  return { init, setLayer, toggleHeatmap, toggleWorkers, toggleDrones, toggleZones, refreshWorkers, focusOnMine, setNearestMine, handleSearchInput, clearSearch, showSearchSuggestions, selectSuggestion };
})();
