/**
 * MineShield Leaflet Map Module
 */
const MapModule = (() => {
  let map = null;
  let heatLayer = null;
  let workerLayer = null;
  let droneLayer = null;
  let zoneLayer  = null;
  let userMarker = null;
  let mineMarkers = [];
  let initialized = false;

  const MINE_CENTER = { lat: 20.5937, lon: 78.9629 };

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
    }).addTo(map).bindPopup('<b>Mine Boundary</b><br>Odisha Bauxite Mine<br>Sector 7-Alpha');
  }

  function drawHazardZones() {
    zoneLayer.clearLayers();
    const zones = [
      { lat: MINE_CENTER.lat + 0.003, lon: MINE_CENTER.lon + 0.003, r: 180, color: '#ef4444', label: 'Critical Hazard Zone' },
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
          Status: <span style="color:${w.status === 'SAFE' ? '#22c55e' : w.status === 'WARNING' ? '#f97316' : '#ef4444'}">${w.status}</span>
        `);
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

        if (!userMarker) {
          userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 1000 })
            .addTo(map)
            .bindPopup('<b>Your Location</b>');
        } else {
          userMarker.setLatLng([lat, lon]);
        }
      },
      () => {
        // GPS not available — show simulated location
        const lat = MINE_CENTER.lat + 0.001;
        const lon = MINE_CENTER.lon + 0.001;
        document.getElementById('gps-lat').textContent  = lat.toFixed(6);
        document.getElementById('gps-lon').textContent  = lon.toFixed(6);
        document.getElementById('gps-speed').textContent   = '3.2 km/h';
        document.getElementById('gps-heading').textContent = '45°';
        document.getElementById('gps-time').textContent    = new Date().toLocaleTimeString();
        if (!userMarker) {
          userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 1000 }).addTo(map).bindPopup('<b>Your Location</b>');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
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

  return { init, setLayer, toggleHeatmap, toggleWorkers, toggleDrones, toggleZones, refreshWorkers };
})();
