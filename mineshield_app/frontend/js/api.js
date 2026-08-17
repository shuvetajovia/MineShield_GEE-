/**
 * MineShield API Client
 * Handles all communication with the FastAPI backend
 */
const API = (() => {
  let BASE_URL = window.location.port === '3000' || window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : window.location.origin;

  function getBase() {
    const el = document.getElementById('api-url');
    if (el && el.value) return el.value.replace(/\/$/, '');
    return BASE_URL;
  }

  async function get(path, params = {}) {
    const url = new URL(getBase() + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (!res.ok) {
        console.error(`HTTP ${res.status} on ${path}`, await res.text().catch(() => 'no body'));
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      return data;
    } catch (e) {
      console.warn(`[API] GET ${path} failed:`, e.message);
      return null;
    }
  }

  async function post(path, body) {
    try {
      const res = await fetch(getBase() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include'
      });
      if (!res.ok) {
        console.error(`HTTP ${res.status} on ${path}`, await res.text().catch(() => 'no body'));
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      console.warn(`[API] POST ${path} failed:`, e.message);
      return null;
    }
  }

  async function upload(path, file) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(getBase() + path, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`[API] UPLOAD ${path} failed:`, e.message);
      return null;
    }
  }

  async function testConnection() {
    const data = await get('/');
    if (data) {
      App.showToast(`Connected: ${data.service}`, 'success');
    } else {
      App.showToast('Backend unreachable. Start uvicorn.', 'error');
    }
    return !!data;
  }

  async function loginUser(name, email, role) {
    const data = await post('/auth/login', { name, email, role });
    if (data && data.user) {
      App.showToast(`Signed in as ${data.user.name}`, 'success');
      if (App && typeof App.updateSessionUser === 'function') {
        App.updateSessionUser(data.user);
      }
    }
    return data;
  }

  return {
    get,
    post,
    upload,
    testConnection,
    loginUser,
    getLivePrediction: (lat, lon) => {
      const params = {};
      if (lat !== undefined && lon !== undefined) {
        params.mine_lat = lat;
        params.mine_lon = lon;
      }
      return get('/predict/live', params);
    },
    getExplain:        (n = 10) => get('/explain', { top_n: n }),
    getWeather:        (lat, lon) => {
      const params = {};
      if (lat !== undefined && lon !== undefined) {
        params.lat = lat;
        params.lon = lon;
      }
      return get('/weather', params);
    },
    getSensors:        () => get('/sensors'),
    getWorkers:        (lat, lon) => get('/workers', { mine_lat: lat, mine_lon: lon }),
    getAlerts:         () => get('/alerts'),
    getDrone:          (lat, lon) => {
      const params = {};
      if (lat !== undefined && lon !== undefined) {
        params.lat = lat;
        params.lon = lon;
      }
      return get('/drone-analysis', params);
    },
    uploadDrone:       (file) => upload('/drone/upload', file),
    getAnalytics:      () => get('/analytics'),
    getTerrain:        (lat, lon) => get('/terrain', { mine_lat: lat, mine_lon: lon }),
    getMines:          () => get('/mines'),
    // Alerts helpers
    sendAlert: async (payload) => post('/alerts/send', payload),
    ackAlert: async (id) => post('/alerts/ack', {id}),
    dismissAlert: async (id) => post('/alerts/dismiss', {id}),
  };
})();
