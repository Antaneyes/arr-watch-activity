# Watch Activity — Radarr/Sonarr Userscript

A Tampermonkey userscript that injects a floating panel into Radarr and Sonarr showing **who last watched** a movie or series (via Tautulli) and **who requested it** (via Overseerr). Useful for deciding what to delete when disk space runs low.

![Panel screenshot](https://i.imgur.com/placeholder.png)

## Features

- Shows the last N viewers of a movie/series with timestamps and watch duration
- Shows who requested the content via Overseerr and the request status
- Floating panel in the bottom-right corner — works without modifying Radarr/Sonarr
- Handles Radarr's TMDB-based URLs and Sonarr's slug-based URLs
- Collapses/expands with a click

## Requirements

- [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge)
- [Radarr](https://radarr.video/) v3+
- [Sonarr](https://sonarr.tv/) v3+
- [Tautulli](https://tautulli.com/) — for Plex watch history
- [Overseerr](https://overseerr.dev/) or [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) — for request tracking

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Open Tampermonkey → **Create new script**
3. Replace all content with the contents of [`watch-activity.user.js`](./watch-activity.user.js)
4. **Configure your API keys** in the `CONFIG` block at the top of the script (see below)
5. Save (`Ctrl+S`)

## Configuration

Edit the `CONFIG` block near the top of the script:

```js
const CONFIG = {
  radarr: {
    url: 'http://localhost:7878',
    apiKey: 'YOUR_RADARR_API_KEY',
  },
  sonarr: {
    url: 'http://localhost:8989',
    apiKey: 'YOUR_SONARR_API_KEY',
  },
  tautulli: {
    url: 'http://localhost:8181',
    apiKey: 'YOUR_TAUTULLI_API_KEY',
    movieSectionId: 1, // Tautulli → Settings → Libraries → ID of your Movies library
    tvSectionId: 2,    // Tautulli → Settings → Libraries → ID of your TV Shows library
  },
  overseerr: {
    url: 'http://localhost:5055',
    apiKey: 'YOUR_OVERSEERR_API_KEY',
  },
  maxHistory: 5, // How many recent viewers to show
};
```

### Where to find API keys

| Service    | Location |
|------------|----------|
| Radarr     | Settings → General → API Key |
| Sonarr     | Settings → General → API Key |
| Tautulli   | Settings → Web Interface → API Key |
| Overseerr  | Settings → General → API Key |

### Tautulli Section IDs

Go to **Tautulli → Settings → Plex Media Server → Libraries**. The number shown next to each library is the section ID.

## How it works

1. Detects SPA navigation in Radarr (`/movie/{tmdbId}`) and Sonarr (`/series/{slug}`)
2. Calls the Radarr/Sonarr API to resolve the title and external IDs
3. Queries Tautulli for recent watch history grouped by user
4. Queries Overseerr for who requested the title and the request status
5. Renders a floating panel in the bottom-right corner of the page

## Debugging

Open browser DevTools (`F12`) → Console tab. The script logs prefixed with `[WatchActivity]` show each step and any errors.

## License

MIT
