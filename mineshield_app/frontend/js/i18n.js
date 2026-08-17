/*
 * Simple i18n loader for MineShield frontend
 * - Loads locale JSON from /locales/<lang>.json
 * - Applies translations to nav items, buttons and key page titles
 * - Persists selected language in localStorage
 */
const I18n = (() => {
  const DEFAULT = 'en';
  let lang = localStorage.getItem('mineshield_lang') || DEFAULT;
  let catalog = {};

  async function loadLocale(l) {
    try {
      const res = await fetch(`/locales/${l}.json`);
      if (!res.ok) throw new Error('Locale not found');
      catalog = await res.json();
      lang = l;
      localStorage.setItem('mineshield_lang', l);
      apply();
      document.documentElement.lang = l;
    } catch (e) {
      console.warn('[i18n] failed to load locale', l, e.message);
      if (l !== DEFAULT) await loadLocale(DEFAULT);
    }
  }

  function t(key, fallback) {
    const parts = key.split('.');
    let cur = catalog;
    for (const p of parts) {
      if (!cur) return fallback || key;
      cur = cur[p];
    }
    return cur ?? (fallback || key);
  }

  function apply() {
    // Nav items
    const navMap = {
      dashboard: 'nav.dashboard',
      map: 'nav.map',
      risk: 'nav.risk',
      drone: 'nav.drone',
      workers: 'nav.workers',
      weather: 'nav.weather',
      analytics: 'nav.analytics',
      alerts: 'nav.alerts',
      explain: 'nav.explain',
      terrain: 'nav.terrain',
      settings: 'nav.settings',
    };
    for (const [page, key] of Object.entries(navMap)) {
      const el = document.querySelector(`[data-page="${page}"] span`);
      if (el) el.textContent = t(key, el.textContent);
    }

    // Buttons / controls
    const btnRefresh = document.getElementById('btn-refresh');
    if (btnRefresh) btnRefresh.textContent = t('refresh', btnRefresh.textContent);

    const runBtn = document.getElementById('run-prediction-btn');
    if (runBtn) runBtn.firstChild && runBtn.firstChild.nodeType === Node.ELEMENT_NODE ? runBtn.childNodes[1].nodeValue = t('run_prediction', 'Run Prediction') : runBtn.textContent = t('run_prediction', 'Run Prediction');

    // Page titles
    const dashTitle = document.querySelector('#page-dashboard .page-title');
    if (dashTitle) dashTitle.textContent = t('operations_dashboard', dashTitle.textContent);

    const dashSub = document.querySelector('#page-dashboard .page-sub');
    if (dashSub) dashSub.textContent = t('real_time_monitoring', dashSub.textContent);
  }

  function init() {
    // populate selector
    const sel = document.getElementById('lang-select');
    if (sel) {
      sel.value = lang;
      sel.addEventListener('change', () => loadLocale(sel.value));
    }
    loadLocale(lang);
  }

  // Auto-init on load
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { t, loadLocale, current: () => lang };
})();
