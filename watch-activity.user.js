// ==UserScript==
// @name         Watch Activity - Radarr/Sonarr
// @namespace    https://github.com/local/watch-activity
// @version      1.1.0
// @description  Muestra quién ha visto una película/serie (Tautulli) y quién la solicitó (Overseerr) directamente en la UI de Radarr/Sonarr
// @author       local
// @match        http://localhost:7878/*
// @match        http://localhost:8989/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // CONFIGURACIÓN — Edita estos valores con tus API keys y section IDs de Tautulli
  // ─────────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    radarr: {
      url: 'http://localhost:7878',
      apiKey: 'TU_RADARR_API_KEY',
    },
    sonarr: {
      url: 'http://localhost:8989',
      apiKey: 'TU_SONARR_API_KEY',
    },
    tautulli: {
      url: 'http://localhost:8181',
      apiKey: 'TU_TAUTULLI_API_KEY',
      movieSectionId: 1, // Ve a Tautulli → Settings → Libraries para ver los IDs
      tvSectionId: 2,
    },
    overseerr: {
      url: 'http://localhost:5055',
      apiKey: 'TU_OVERSEERR_API_KEY',
    },
    maxHistory: 5, // Número máximo de espectadores recientes a mostrar
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const PANEL_ID = 'watch-activity-panel';
  let currentUrl = location.href;
  let injectionTimeout = null;

  // ── Utilidades ───────────────────────────────────────────────────────────────

  function gmFetch(url, headers = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        onload: (res) => {
          try {
            resolve(JSON.parse(res.responseText));
          } catch {
            resolve(null);
          }
        },
        onerror: () => reject(new Error(`Error al cargar: ${url}`)),
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
        timeout: 10000,
      });
    });
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'fecha desconocida';
    const date = new Date(typeof dateStr === 'number' ? dateStr * 1000 : dateStr);
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return 'hace unos segundos';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
    if (diff < 2592000) return `hace ${Math.floor(diff / 86400)} días`;
    if (diff < 31536000) return `hace ${Math.floor(diff / 2592000)} meses`;
    return `hace ${Math.floor(diff / 31536000)} años`;
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ── API Radarr ───────────────────────────────────────────────────────────────

  async function fetchRadarrMovie(idOrSlug) {
    try {
      const movies = await gmFetch(
        `${CONFIG.radarr.url}/api/v3/movie?apikey=${CONFIG.radarr.apiKey}`
      );
      if (!Array.isArray(movies)) return null;

      if (/^\d+$/.test(idOrSlug)) {
        // La URL de Radarr usa el TMDB ID — buscar por tmdbId
        const tmdbId = parseInt(idOrSlug, 10);
        return movies.find((m) => m.tmdbId === tmdbId) || null;
      }
      // Si es texto, buscar por titleSlug
      return movies.find((m) => m.titleSlug === idOrSlug) || null;
    } catch (e) {
      console.error('[WatchActivity] fetchRadarrMovie error:', e);
      return null;
    }
  }

  // ── API Sonarr ───────────────────────────────────────────────────────────────

  async function fetchSonarrSeries(idOrSlug) {
    try {
      const seriesList = await gmFetch(
        `${CONFIG.sonarr.url}/api/v3/series?apikey=${CONFIG.sonarr.apiKey}`
      );
      if (!Array.isArray(seriesList)) return null;

      if (/^\d+$/.test(idOrSlug)) {
        // Por si Sonarr usa tvdbId en la URL
        const tvdbId = parseInt(idOrSlug, 10);
        return seriesList.find((s) => s.tvdbId === tvdbId) || null;
      }
      // Lo más común en Sonarr: titleSlug de texto
      return seriesList.find((s) => s.titleSlug === idOrSlug) || null;
    } catch (e) {
      console.error('[WatchActivity] fetchSonarrSeries error:', e);
      return null;
    }
  }

  // ── API Tautulli ─────────────────────────────────────────────────────────────

  async function tautulliCmd(cmd, params = {}) {
    const query = new URLSearchParams({
      apikey: CONFIG.tautulli.apiKey,
      cmd,
      ...params,
    });
    const data = await gmFetch(
      `${CONFIG.tautulli.url}/api/v2?${query.toString()}`
    );
    return data?.response?.data ?? null;
  }

  async function findTautulliRatingKey(title, mediaType) {
    const sectionId =
      mediaType === 'movie'
        ? CONFIG.tautulli.movieSectionId
        : CONFIG.tautulli.tvSectionId;
    const data = await tautulliCmd('get_library_media_info', {
      section_id: sectionId,
      search: title,
      length: 5,
    });
    const items = data?.data ?? [];
    if (!items.length) return null;
    // Buscar coincidencia exacta primero, luego parcial
    const exact = items.find(
      (i) => i.title?.toLowerCase() === title.toLowerCase()
    );
    return (exact || items[0])?.rating_key ?? null;
  }

  async function fetchTautulliHistory(title, mediaType) {
    try {
      const ratingKey = await findTautulliRatingKey(title, mediaType);
      if (!ratingKey) return [];

      const data = await tautulliCmd('get_history', {
        rating_key: ratingKey,
        media_type: mediaType === 'movie' ? 'movie' : 'episode',
        length: CONFIG.maxHistory * 3, // pedir más para poder agrupar por usuario
        order_column: 'date',
        order_dir: 'desc',
      });

      const rows = data?.data ?? [];

      // Agrupar por usuario, quedarse con la última vez que cada uno lo vio
      const byUser = {};
      for (const row of rows) {
        const user = row.friendly_name || row.user || 'Desconocido';
        if (!byUser[user]) {
          byUser[user] = {
            user,
            date: row.date,
            stopped: row.stopped,
            duration: row.duration,
          };
        }
      }

      return Object.values(byUser).slice(0, CONFIG.maxHistory);
    } catch {
      return [];
    }
  }

  // ── API Overseerr ────────────────────────────────────────────────────────────

  async function fetchOverseerrMedia(endpoint) {
    try {
      const data = await gmFetch(
        `${CONFIG.overseerr.url}/api/v1/${endpoint}`,
        { 'X-Api-Key': CONFIG.overseerr.apiKey }
      );
      return data;
    } catch {
      return null;
    }
  }

  async function fetchOverseerrRequests(tmdbId, isTV) {
    try {
      const endpoint = isTV ? `tv/${tmdbId}` : `movie/${tmdbId}`;
      const data = await fetchOverseerrMedia(endpoint);
      const requests = data?.mediaInfo?.requests ?? [];
      return requests.map((r) => ({
        requestedBy: r.requestedBy?.displayName || r.requestedBy?.username || 'Desconocido',
        status: r.status,
        createdAt: r.createdAt,
      }));
    } catch {
      return [];
    }
  }

  // ── Render del panel flotante ─────────────────────────────────────────────────

  function statusLabel(status) {
    const map = { 1: 'Pendiente', 2: 'Aprobada', 3: 'Rechazada', 4: 'Disponible', 5: 'Procesando' };
    return map[status] ?? `Estado ${status}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildStyles() {
    return `
      #${PANEL_ID} {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 99999;
        width: 320px;
        background: #1a1d23;
        border: 1px solid #3d4148;
        border-radius: 8px;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e1e2e4;
        font-size: 13px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        overflow: hidden;
      }
      #${PANEL_ID} .wa-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #22262e;
        border-bottom: 1px solid #3d4148;
        cursor: pointer;
        user-select: none;
      }
      #${PANEL_ID} .wa-header-title {
        font-weight: 700;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: #a8b0bc;
      }
      #${PANEL_ID} .wa-toggle {
        color: #6b7280;
        font-size: 16px;
        line-height: 1;
        background: none;
        border: none;
        cursor: pointer;
        color: #9ea2a9;
        padding: 0;
      }
      #${PANEL_ID} .wa-body {
        padding: 12px 14px;
      }
      #${PANEL_ID} .wa-body.collapsed {
        display: none;
      }
      #${PANEL_ID} .wa-movie-title {
        font-weight: 600;
        font-size: 13px;
        color: #fff;
        margin-bottom: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .wa-section {
        margin-bottom: 12px;
      }
      #${PANEL_ID} .wa-section:last-child {
        margin-bottom: 0;
      }
      #${PANEL_ID} .wa-section-title {
        font-weight: 600;
        color: #6b7280;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 5px;
      }
      #${PANEL_ID} .wa-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 3px 0;
        border-bottom: 1px solid #22252b;
      }
      #${PANEL_ID} .wa-row:last-child {
        border-bottom: none;
      }
      #${PANEL_ID} .wa-user {
        font-weight: 500;
        color: #c8cdd4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 140px;
      }
      #${PANEL_ID} .wa-meta {
        color: #6b7280;
        font-size: 11px;
        text-align: right;
        white-space: nowrap;
      }
      #${PANEL_ID} .wa-empty {
        color: #4b5563;
        font-style: italic;
        font-size: 12px;
      }
      #${PANEL_ID} .wa-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
        background: #2d3139;
        color: #9ea2a9;
      }
      #${PANEL_ID} .wa-badge.pending  { background: #3b3000; color: #f59e0b; }
      #${PANEL_ID} .wa-badge.approved { background: #002f1f; color: #10b981; }
      #${PANEL_ID} .wa-badge.declined { background: #2f0000; color: #ef4444; }
      #${PANEL_ID} .wa-badge.available{ background: #00231f; color: #34d399; }
      #${PANEL_ID} .wa-loading { color: #4b5563; font-style: italic; font-size: 12px; }
      #${PANEL_ID} .wa-error   { color: #ef4444; font-size: 12px; }
      #${PANEL_ID} .wa-divider { border: none; border-top: 1px solid #2d3139; margin: 10px 0; }
    `;
  }

  function buildPanelHtml({ history, requests, title, error, collapsed }) {
    const colClass = collapsed ? ' collapsed' : '';

    let historyHtml = '';
    if (history === null) {
      historyHtml = '<div class="wa-loading">Cargando historial...</div>';
    } else if (history.length === 0) {
      historyHtml = '<div class="wa-empty">Sin historial en Tautulli</div>';
    } else {
      historyHtml = history.map((h) => `
        <div class="wa-row">
          <span class="wa-user">${escapeHtml(h.user)}</span>
          <span class="wa-meta">
            ${timeAgo(h.stopped || h.date)}
            ${h.duration ? ` · ${formatDuration(h.duration)}` : ''}
          </span>
        </div>`).join('');
    }

    let requestsHtml = '';
    if (requests === null) {
      requestsHtml = '<div class="wa-loading">Cargando solicitudes...</div>';
    } else if (requests.length === 0) {
      requestsHtml = '<div class="wa-empty">No solicitada en Overseerr</div>';
    } else {
      const badgeClass = (s) => ({ 1: 'pending', 2: 'approved', 3: 'declined', 4: 'available', 5: 'approved' }[s] || '');
      requestsHtml = requests.map((r) => `
        <div class="wa-row">
          <span class="wa-user">${escapeHtml(r.requestedBy)}</span>
          <span class="wa-meta">
            <span class="wa-badge ${badgeClass(r.status)}">${statusLabel(r.status)}</span>
            ${r.createdAt ? ` · ${timeAgo(r.createdAt)}` : ''}
          </span>
        </div>`).join('');
    }

    return `
      <div class="wa-header" id="${PANEL_ID}-header">
        <span class="wa-header-title">Watch Activity</span>
        <button class="wa-toggle" id="${PANEL_ID}-toggle">${collapsed ? '▲' : '▼'}</button>
      </div>
      <div class="wa-body${colClass}" id="${PANEL_ID}-body">
        ${title ? `<div class="wa-movie-title">${escapeHtml(title)}</div>` : ''}
        ${error ? `<div class="wa-error">${escapeHtml(error)}</div>` : ''}
        <div class="wa-section">
          <div class="wa-section-title">👁 Espectadores (Tautulli)</div>
          ${historyHtml}
        </div>
        <hr class="wa-divider">
        <div class="wa-section">
          <div class="wa-section-title">📋 Solicitado (Overseerr)</div>
          ${requestsHtml}
        </div>
      </div>
    `;
  }

  // ── Gestión del panel flotante ────────────────────────────────────────────────

  let panelCollapsed = false;

  function ensureStyleTag() {
    let styleTag = document.getElementById(`${PANEL_ID}-styles`);
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = `${PANEL_ID}-styles`;
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = buildStyles();
  }

  function getOrCreatePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
      panel.addEventListener('click', (e) => {
        if (e.target.id === `${PANEL_ID}-toggle` || e.target.id === `${PANEL_ID}-header` || e.target.closest(`#${PANEL_ID}-header`)) {
          panelCollapsed = !panelCollapsed;
          renderToPanel({ _keepData: true });
        }
      });
    }
    return panel;
  }

  // Estado actual del panel para re-renderizar al colapsar/expandir
  let panelData = { history: null, requests: null, title: null, error: null };

  function renderToPanel(data) {
    if (!data._keepData) panelData = { ...panelData, ...data };
    ensureStyleTag();
    const panel = getOrCreatePanel();
    panel.innerHTML = buildPanelHtml({ ...panelData, collapsed: panelCollapsed });
  }

  function removeExistingPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    panelData = { history: null, requests: null, title: null, error: null };
  }

  function injectLoading(title) {
    renderToPanel({ history: null, requests: null, title, error: null });
  }

  function updatePanel(data) {
    renderToPanel(data);
  }

  // ── Lógica principal ─────────────────────────────────────────────────────────

  async function handleMoviePage(idOrSlug) {
    console.log(`[WatchActivity] Página de película detectada: ${idOrSlug}`);
    injectLoading('Cargando...');

    const movie = await fetchRadarrMovie(idOrSlug);
    if (!movie) {
      console.warn('[WatchActivity] No se encontró la película en Radarr');
      updatePanel({ history: [], requests: [], title: idOrSlug, error: 'No se encontró la película en Radarr' });
      return;
    }

    console.log(`[WatchActivity] Película: ${movie.title} (tmdbId: ${movie.tmdbId})`);
    const title = movie.title;
    updatePanel({ history: null, requests: null, title });

    const [history, requests] = await Promise.all([
      fetchTautulliHistory(title, 'movie'),
      fetchOverseerrRequests(movie.tmdbId, false),
    ]);

    console.log('[WatchActivity] Historial:', history);
    console.log('[WatchActivity] Solicitudes:', requests);
    updatePanel({ history, requests, title });
  }

  async function handleSeriesPage(idOrSlug) {
    console.log(`[WatchActivity] Página de serie detectada: ${idOrSlug}`);
    injectLoading('Cargando...');

    const series = await fetchSonarrSeries(idOrSlug);
    if (!series) {
      console.warn('[WatchActivity] No se encontró la serie en Sonarr');
      updatePanel({ history: [], requests: [], title: idOrSlug, error: 'No se encontró la serie en Sonarr' });
      return;
    }

    console.log(`[WatchActivity] Serie: ${series.title} (tvdbId: ${series.tvdbId})`);
    const title = series.title;
    updatePanel({ history: null, requests: null, title });

    const tvdbId = series.tvdbId;

    const [history, requests] = await Promise.all([
      fetchTautulliHistory(title, 'show'),
      fetchOverseerrRequests(tvdbId, true),
    ]);

    console.log('[WatchActivity] Historial:', history);
    console.log('[WatchActivity] Solicitudes:', requests);
    updatePanel({ history, requests, title });
  }

  function onRouteChange(url) {
    const path = new URL(url).pathname;

    // Radarr: /movie/{slug}
    const movieMatch = path.match(/^\/movie\/([^/]+)$/);
    if (movieMatch) {
      scheduleInjection(() => handleMoviePage(movieMatch[1]));
      return;
    }

    // Sonarr: /series/{slug}
    const seriesMatch = path.match(/^\/series\/([^/]+)$/);
    if (seriesMatch) {
      scheduleInjection(() => handleSeriesPage(seriesMatch[1]));
      return;
    }

    // No es una página de detalle — limpiar panel si existe
    removeExistingPanel();
  }

  function scheduleInjection(fn) {
    if (injectionTimeout) clearTimeout(injectionTimeout);
    // Esperar a que el SPA renderice el componente de detalle
    injectionTimeout = setTimeout(fn, 800);
  }

  // ── Detección de navegación SPA ──────────────────────────────────────────────

  function setupNavigationObserver() {
    // Interceptar pushState para detectar navegación en SPA
    const origPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      origPushState(...args);
      onUrlChange();
    };

    const origReplaceState = history.replaceState.bind(history);
    history.replaceState = function (...args) {
      origReplaceState(...args);
      onUrlChange();
    };

    window.addEventListener('popstate', onUrlChange);

    // MutationObserver como fallback para frameworks que no usan history API
    const observer = new MutationObserver(() => {
      if (location.href !== currentUrl) {
        onUrlChange();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onUrlChange() {
    const url = location.href;
    if (url === currentUrl) return;
    currentUrl = url;
    onRouteChange(url);
  }

  // ── Inicialización ───────────────────────────────────────────────────────────

  function init() {
    setupNavigationObserver();
    // Procesar la URL actual al cargar la página
    onRouteChange(location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
