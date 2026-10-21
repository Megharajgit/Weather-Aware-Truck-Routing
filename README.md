# Spotter AI — Weather-aware truck routing

Assessment implementation for the Full Stack Developer role. The app compares three truck route corridors using arrival-time weather, load-specific risk rules, and a safety-first recommendation order.

## What is included

- React dashboard with responsive layout and accessible controls.
- Three route alternatives from the public OSRM routing API, with a deterministic fallback for offline/demo use.
- Nominatim geocoding for city, state, ZIP, or address input, with a Denver → Chicago fallback demo.
- Checkpoints sampled at 10, 25, or 50 mile intervals.
- ETA-aware wind, rain, and snow classification with load-weight escalation rules.
- Leaflet map with route corridors, risk-colored checkpoints, heatmap-style forecast overlay, and a 0–48 hour slider.
- Django WSGI API entrypoint for Vercel health checks and future provider-side integrations.

## Run locally

The frontend is intentionally dependency-light and can be served from the repository root:

```bash
python -m http.server 3000
```

Open `http://localhost:3000`. The browser loads React, Leaflet, and the map tiles from public CDNs.

To exercise the Django endpoint locally:

```bash
python -m pip install -r requirements.txt
python -m django --version
```

Vercel deploys `api/index.py` using the Python runtime and serves the root React entrypoint as static assets.

## Risk model

Each checkpoint receives the highest severity from wind, rain, and snow thresholds. Load rules then apply:

- `≥55 mph` wind is `No Travel` for every load.
- `45–54 mph` with a load over `30,000 lb` is `No Travel`.
- `35–44 mph` with a load over `40,000 lb` is `Severe`.

Recommendation sorting is deterministic and follows the assessment brief: fewest severe/no-travel miles, fewest high-risk miles, lowest average risk, then shortest travel time.

## Deployment

1. Push the repository to GitHub.
2. Import it into Vercel with the repository root as the project directory.
3. Deploy with the included `vercel.json` and `requirements.txt`.
4. Verify `/api/health` and the hosted dashboard.

For production weather enrichment, replace the deterministic `weatherAt` adapter in `app.js` with a server-side Open-Meteo or commercial weather provider call. Keeping provider credentials server-side is recommended.
