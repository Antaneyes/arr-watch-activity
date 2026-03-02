// ==UserScript==
// @name         Watch Activity - Radarr/Sonarr
// @namespace    https://github.com/local/watch-activity
// @version      1.2.0
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
      // movieSectionId y tvSectionId ya NO son necesarios.
      // El script detecta automáticamente todas las librerías de Tautulli.
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

  // Cache en memoria para evitar repetir búsquedas
  const ratingKeyCache = {};
  let tautulliSectionsCache = null; // { movie: [sectionId, ...], show: [sectionId, ...] }

  async function getTautulliSections() {
    if (tautulliSectionsCache) return tautulliSectionsCache;
    const data = await tautulliCmd('get_libraries_table', { length: 50 });
    const sections = { movie: [], show: [] };
    for (const lib of data?.data ?? []) {
      if (lib.section_type === 'movie') sections.movie.push(String(lib.section_id));
      else if (lib.section_type === 'show') sections.show.push(String(lib.section_id));
    }
    console.log('[WatchActivity] Tautulli secciones detectadas:', sections);
    tautulliSectionsCache = sections;
    return sections;
  }

  async function findTautulliRatingKey(mediaInfo, mediaType) {
    const cacheKey = `${mediaType}:${mediaInfo.externalId}`;
    if (ratingKeyCache[cacheKey]) return ratingKeyCache[cacheKey];

    const externalPrefix = mediaType === 'movie' ? 'tmdb' : 'tvdb';
    const externalGuid = `${externalPrefix}://${mediaInfo.externalId}`;
    const idStr = String(mediaInfo.externalId);
    const historyMediaType = mediaType === 'movie' ? 'movie' : 'episode';

    const titles = [...new Set([
      mediaInfo.title,
      mediaInfo.originalTitle,
      ...(mediaInfo.alternateTitles || []),
    ].filter(Boolean))];

    function guidMatches(rawGuids) {
      return rawGuids.some((g) =>
        g === externalGuid ||
        g.includes(`themoviedb://${idStr}`) ||
        g.includes(`thetvdb://${idStr}`) ||
        new RegExp(`[:/]${idStr}(?:[?#]|$)`).test(g)
      );
    }

    function extractGuids(meta) {
      return [
        meta?.guid,
        ...(meta?.guids ?? []),
        ...(meta?.grandparent_guids ?? []),
      ].filter(Boolean).map((g) => (typeof g === 'string' ? g : g?.id ?? ''));
    }

    // Estrategia 1: buscar en el historial por cada variante de título
    // (get_history search es lo que usa la UI de Tautulli y no tiene límite de paginación)
    for (const title of titles) {
      const data = await tautulliCmd('get_history', {
        media_type: historyMediaType,
        search: title,
        length: 10,
        order_column: 'date',
        order_dir: 'desc',
      });
      const rows = data?.data ?? [];
      if (!rows.length) continue;

      // Agrupar candidatos únicos: para películas usar rating_key, para series grandparent_rating_key
      const candidates = {};
      for (const row of rows) {
        const key = mediaType === 'movie' ? row.rating_key : row.grandparent_rating_key;
        const title = mediaType === 'movie' ? row.full_title : row.grandparent_title;
        if (key && !candidates[key]) candidates[key] = { rating_key: key, title };
      }

      // Verificar guids en paralelo
      const items = Object.values(candidates);
      const results = await Promise.all(
        items.map((item) =>
          tautulliCmd('get_metadata', { rating_key: item.rating_key }).then((meta) => {
            const guids = extractGuids(meta);
            return guidMatches(guids) ? item : null;
          })
        )
      );

      const found = results.find((r) => r !== null);
      if (found) {
        console.log(`[WatchActivity] Tautulli: "${found.title}" (${found.rating_key}) encontrado via historial buscando "${title}"`);
        ratingKeyCache[cacheKey] = { ratingKey: found.rating_key, tautulliTitle: found.title };
        return ratingKeyCache[cacheKey];
      }
    }

    // Estrategia 2: get_library_media_info con búsqueda por título en cada variante
    const sections = await getTautulliSections();
    const sectionIds = mediaType === 'movie' ? sections.movie : sections.show;

    for (const title of titles) {
      for (const sectionId of sectionIds) {
        const searchData = await tautulliCmd('get_library_media_info', {
          section_id: sectionId,
          search: title,
          length: 25,
        });
        const items = searchData?.data ?? [];
        if (!items.length) continue;

        const results = await Promise.all(
          items.map((item) =>
            tautulliCmd('get_metadata', { rating_key: item.rating_key }).then((meta) => {
              const guids = extractGuids(meta);
              return guidMatches(guids) ? item : null;
            })
          )
        );

        const found = results.find((r) => r !== null);
        if (found) {
          console.log(`[WatchActivity] Tautulli: "${found.title}" (${found.rating_key}) encontrado via búsqueda por título "${title}"`);
          ratingKeyCache[cacheKey] = { ratingKey: found.rating_key, tautulliTitle: found.title };
          return ratingKeyCache[cacheKey];
        }
      }
    }

    // Estrategia 3: escaneo completo de librería con paginación correcta
    for (const sectionId of sectionIds) {
      const probe = await tautulliCmd('get_library_media_info', { section_id: sectionId, length: 1 });
      const total = probe?.recordsTotal ?? 0;
      if (!total) continue;

      console.log(`[WatchActivity] Tautulli: escaneando sección ${sectionId} completa (${total} items)...`);

      // Escanear en lotes para no saturar la API
      const batchSize = 100;
      for (let start = 0; start < total; start += batchSize) {
        const batch = await tautulliCmd('get_library_media_info', {
          section_id: sectionId,
          length: batchSize,
          start,
        });
        const items = batch?.data ?? [];
        const results = await Promise.all(
          items.map((item) =>
            tautulliCmd('get_metadata', { rating_key: item.rating_key }).then((meta) => {
              const guids = extractGuids(meta);
              return guidMatches(guids) ? item : null;
            })
          )
        );

        const found = results.find((r) => r !== null);
        if (found) {
          console.log(`[WatchActivity] Tautulli: "${found.title}" (${found.rating_key}) encontrado en sección ${sectionId} (start=${start})`);
          ratingKeyCache[cacheKey] = { ratingKey: found.rating_key, tautulliTitle: found.title };
          return ratingKeyCache[cacheKey];
        }
      }
    }

    return null;
  }

  async function fetchTautulliHistory(mediaInfo, mediaType) {
    // mediaInfo: { title, originalTitle, alternateTitles, externalId }
    // Devuelve { history, tautulliTitle }
    try {
      const result = await findTautulliRatingKey(mediaInfo, mediaType);

      if (!result) {
        console.warn(`[WatchActivity] Tautulli: no se encontró rating_key para "${mediaInfo.title}"`);
        return { history: [], tautulliTitle: null };
      }

      const { ratingKey, tautulliTitle } = result;

      // Para series usar grandparent_rating_key (el rating_key de la serie es el grandparent de los episodios)
      const historyParams = mediaType === 'movie'
        ? { rating_key: ratingKey, media_type: 'movie' }
        : { grandparent_rating_key: ratingKey, media_type: 'episode' };

      const data = await tautulliCmd('get_history', {
        ...historyParams,
        length: CONFIG.maxHistory * 3,
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

      return { history: Object.values(byUser).slice(0, CONFIG.maxHistory), tautulliTitle };
    } catch {
      return { history: [], tautulliTitle: null };
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

  // ── Episodios por usuario (Tautulli) ─────────────────────────────────────────

  // Estado de expansión de los dropdowns por usuario { "username": true/false }
  let expandedUsers = {};
  // Cache de episodios por usuario { "ratingKey:username": { "1": [1,2,3], "2": [1] } }
  const episodesCache = {};

  async function fetchUserEpisodes(ratingKey, username) {
    const cacheKey = `${ratingKey}:${username}`;
    if (episodesCache[cacheKey]) return episodesCache[cacheKey];

    const data = await tautulliCmd('get_history', {
      grandparent_rating_key: ratingKey,
      user: username,
      media_type: 'episode',
      length: 500,
      order_column: 'date',
      order_dir: 'asc',
    });

    const bySeason = {};
    for (const row of data?.data ?? []) {
      const s = row.parent_media_index ?? '?';
      const e = row.media_index ?? '?';
      if (!bySeason[s]) bySeason[s] = new Set();
      bySeason[s].add(e);
    }
    // Convertir Sets a arrays ordenados
    const result = {};
    for (const [s, eps] of Object.entries(bySeason)) {
      result[s] = [...eps].sort((a, b) => Number(a) - Number(b));
    }
    episodesCache[cacheKey] = result;
    return result;
  }

  // ── Render del panel flotante ─────────────────────────────────────────────────


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
      #${PANEL_ID} .wa-loading { color: #4b5563; font-style: italic; font-size: 12px; }
      #${PANEL_ID} .wa-error   { color: #ef4444; font-size: 12px; }
      #${PANEL_ID} .wa-divider { border: none; border-top: 1px solid #2d3139; margin: 10px 0; }
      #${PANEL_ID} .wa-tick    { color: #10b981; font-weight: 700; margin-left: 4px; }
      #${PANEL_ID} .wa-expand-btn {
        background: none; border: none; cursor: pointer;
        color: #6b7280; font-size: 10px; padding: 0 4px;
        line-height: 1; vertical-align: middle;
      }
      #${PANEL_ID} .wa-expand-btn:hover { color: #a8b0bc; }
      #${PANEL_ID} .wa-episodes {
        padding: 5px 0 3px 8px;
        border-bottom: 1px solid #22252b;
      }
      #${PANEL_ID} .wa-episodes:last-child { border-bottom: none; }
      #${PANEL_ID} .wa-season {
        font-size: 11px; color: #6b7280; margin-bottom: 2px;
      }
      #${PANEL_ID} .wa-season-label { color: #9ea2a9; font-weight: 600; }
      #${PANEL_ID} .wa-eps-loading { color: #4b5563; font-style: italic; font-size: 11px; padding: 3px 0; }
    `;
  }

  function buildEpisodesHtml(username, ratingKey) {
    if (!expandedUsers[username]) return '';
    const cacheKey = `${ratingKey}:${username}`;
    const data = episodesCache[cacheKey];
    if (!data) return `<div class="wa-eps-loading">Cargando episodios...</div>`;
    if (!Object.keys(data).length) return `<div class="wa-eps-loading">Sin episodios registrados</div>`;
    return Object.entries(data)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([season, eps]) =>
        `<div class="wa-season"><span class="wa-season-label">T${season}:</span> ${eps.map(e => `E${e}`).join(', ')}</div>`
      ).join('');
  }

  function buildPanelHtml({ history, requests, title, error, collapsed, isTV, ratingKey }) {
    const colClass = collapsed ? ' collapsed' : '';

    // Set de usuarios que han visto el contenido (para el tick en Overseerr)
    const watchedUsers = new Set((history || []).map((h) => h.user.toLowerCase().trim()));

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
      requestsHtml = requests.map((r) => {
        const hasWatched = watchedUsers.has(r.requestedBy.toLowerCase().trim());
        const tick = hasWatched ? '<span class="wa-tick">✓</span>' : '';
        const expanded = !!expandedUsers[r.requestedBy];
        const expandBtn = (isTV && ratingKey)
          ? `<button class="wa-expand-btn" data-user="${escapeHtml(r.requestedBy)}" title="Ver episodios">${expanded ? '▼' : '▶'}</button>`
          : '';
        const episodesHtml = (isTV && ratingKey && expanded)
          ? `<div class="wa-episodes">${buildEpisodesHtml(r.requestedBy, ratingKey)}</div>`
          : '';
        return `
          <div class="wa-row">
            <span class="wa-user">${expandBtn}${escapeHtml(r.requestedBy)}${tick}</span>
            ${r.createdAt ? `<span class="wa-meta">${timeAgo(r.createdAt)}</span>` : ''}
          </div>
          ${episodesHtml}`;
      }).join('');
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
      panel.addEventListener('click', async (e) => {
        // Toggle colapsar/expandir panel
        if (e.target.id === `${PANEL_ID}-toggle` || e.target.closest(`#${PANEL_ID}-header`)) {
          panelCollapsed = !panelCollapsed;
          renderToPanel({ _keepData: true });
          return;
        }
        // Toggle dropdown de episodios por usuario
        const expandBtn = e.target.closest('.wa-expand-btn');
        if (expandBtn) {
          const username = expandBtn.dataset.user;
          const ratingKey = panelData.ratingKey;
          if (!username || !ratingKey) return;
          expandedUsers[username] = !expandedUsers[username];
          renderToPanel({ _keepData: true });
          // Si se acaba de expandir y no hay datos en caché, cargarlos
          if (expandedUsers[username]) {
            const cacheKey = `${ratingKey}:${username}`;
            if (!episodesCache[cacheKey]) {
              await fetchUserEpisodes(ratingKey, username);
              renderToPanel({ _keepData: true });
            }
          }
        }
      });
    }
    return panel;
  }

  // Estado actual del panel para re-renderizar al colapsar/expandir
  let panelData = { history: null, requests: null, title: null, error: null, isTV: false, ratingKey: null };

  function renderToPanel(data) {
    if (!data._keepData) panelData = { ...panelData, ...data };
    ensureStyleTag();
    const panel = getOrCreatePanel();
    panel.innerHTML = buildPanelHtml({ ...panelData, collapsed: panelCollapsed });
  }

  function removeExistingPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    panelData = { history: null, requests: null, title: null, error: null, isTV: false, ratingKey: null };
    expandedUsers = {};
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

    const [tautulliResult, requests] = await Promise.all([
      fetchTautulliHistory({
        title: movie.title,
        originalTitle: movie.originalTitle,
        alternateTitles: (movie.alternateTitles || []).map((a) => a.title),
        externalId: movie.tmdbId,
      }, 'movie'),
      fetchOverseerrRequests(movie.tmdbId, false),
    ]);

    const displayTitle = tautulliResult.tautulliTitle || title;
    console.log('[WatchActivity] Historial:', tautulliResult.history);
    console.log('[WatchActivity] Solicitudes:', requests);
    updatePanel({ history: tautulliResult.history, requests, title: displayTitle, isTV: false, ratingKey: null });
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

    const [tautulliResult, requests] = await Promise.all([
      fetchTautulliHistory({
        title: series.title,
        originalTitle: series.originalTitle,
        alternateTitles: (series.alternateTitles || []).map((a) => a.title),
        externalId: series.tvdbId,
      }, 'show'),
      fetchOverseerrRequests(tvdbId, true),
    ]);

    const displayTitle = tautulliResult.tautulliTitle || title;
    // ratingKey de la serie para el dropdown de episodios por usuario
    const cacheKey = `show:${series.tvdbId}`;
    const cachedEntry = ratingKeyCache[cacheKey];
    const seriesRatingKey = cachedEntry?.ratingKey ?? null;
    console.log('[WatchActivity] Historial:', tautulliResult.history);
    console.log('[WatchActivity] Solicitudes:', requests);
    updatePanel({ history: tautulliResult.history, requests, title: displayTitle, isTV: true, ratingKey: seriesRatingKey });
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
