/**
 * MineShield API Client
 * Handles all communication with the FastAPI backend
 */
const API = (() => {
  let BASE_URL = 'http://localhost:8000';

  function getBase() {
    const el = document.getElementById('api-url');
    return el ? el.value.replace(/\/$/, '') : BASE_URL;
  }

  async function get(path, params = {}) {
    const url = new URL(getBase() + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
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
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`[API] POST ${path} failed:`, e.message);
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

  return {
    get,
    post,
    testConnection,
    getLivePrediction: () => get('/predict/live'),
    getExplain:        (n = 10) => get('/explain', { top_n: n }),
    getWeather:        () => get('/weather'),
    getWorkers:        (lat, lon) => get('/workers', { mine_lat: lat, mine_lon: lon }),
    getAlerts:         () => get('/alerts'),
    getDrone:          () => get('/drone-analysis'),
    getAnalytics:      () => get('/analytics'),
    getTerrain:        (lat, lon) => get('/terrain', { mine_lat: lat, mine_lon: lon }),
    getMines:          () => get('/mines'),
  };
})();
