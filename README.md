# Spotter AI — Weather-aware truck routing

Assessment implementation for the Full Stack Developer role. The app geocodes locations and retrieves Mapbox driving alternatives, filters routes by truck dimensions, and scores Open-Meteo weather along each route.

## What is included

- React dashboard with responsive layout and accessible controls.
- Mapbox Geocoding API v6 for city, state, ZIP, and address input.
- Mapbox Directions API driving routes with alternatives, filtered by truck gross weight and height where road restriction data is available. Mapbox returns up to two options.
- Checkpoints sampled at 10, 25, or 50 mile intervals.
- Open-Meteo hourly wind, rain, and snow at checkpoints, with a 0–48 hour forecast slider.
- ETA-aware weather risk classification with cargo-load wind escalation rules.
- Leaflet map with Mapbox basemap tiles, route corridors, risk-colored checkpoints, and weather heatmap overlay.
- Python API endpoints at `/api/config`, `/api/health`, and `/api/analyze`.

## Run locally

For the complete app locally, create `.env.local` with your Mapbox tokens, then run the Vercel development server:

```bash
npx vercel dev
```

Open `http://localhost:3000`. The browser loads React and Leaflet from public CDNs.

`.env.local` should contain:

```bash
MAPBOX_ACCESS_TOKEN=your_server_side_secret_token
MAPBOX_PUBLIC_TOKEN=your_restricted_public_token
```

Create a Mapbox account and two tokens: a server-side secret token with access to Geocoding and Directions, and a public token with the `styles:tiles` scope for the Leaflet basemap. Restrict the public token to the local and deployed app domains. Keep `.env.local` private. `MAPBOX_ACCESS_TOKEN` is used only by the server; the public token is returned by `/api/config` for the browser. Open-Meteo needs no token for its free forecast endpoint.

## Risk model

Each checkpoint receives the highest severity from wind, rain, and snow thresholds. Load rules then apply:

- `≥55 mph` wind is `No Travel` for every load.
- `45–54 mph` with a load over `30,000 lb` is `No Travel`.
- `35–44 mph` with a load over `40,000 lb` is `Severe`.

Recommendation sorting is deterministic and follows the assessment brief: fewest severe/no-travel miles, fewest high-risk miles, lowest average risk, then shortest travel time.

## Deployment

1. Add `MAPBOX_ACCESS_TOKEN` and `MAPBOX_PUBLIC_TOKEN` in Vercel **Project Settings → Environment Variables** for Production and Preview.
2. Redeploy after adding the variables.
3. Confirm `/api/health` reports `mapboxConfigured: true` and try a route analysis.

The Mapbox Directions API's truck height and weight filters rely on available road restriction data; coverage varies by region. The routing profile is Mapbox's driving profile, not a dedicated commercial truck navigation service.
