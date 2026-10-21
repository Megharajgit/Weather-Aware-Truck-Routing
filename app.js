const { useEffect, useMemo, useRef, useState } = React;
const html = htm.bind(React.createElement);

const RISK_RANK = { Low: 0, Moderate: 1, High: 2, Severe: 3, "No Travel": 4 };
const RISK_COLORS = { Low: "#82d46f", Moderate: "#f4c464", High: "#ff9363", Severe: "#ff6471", "No Travel": "#c783ff" };
const ROUTE_COLORS = ["#a6f36f", "#75e1de", "#c783ff"];
const DEMO_FORM = { origin: "Denver, CO", destination: "Chicago, IL", weight: "38000", grossWeight: "80000", heightFt: "13.5" };

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function milesBetween(a, b) {
  const earthRadius = 3958.8;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function formatDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function formatEta(date) { return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date); }
function formatHours(hours) { return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`; }
function formatNumber(value) { return new Intl.NumberFormat().format(Math.round(value)); }
function slugify(value) { return value.toLowerCase().replace(/\s+/g, "-"); }
function levelFromRank(rank) { return Object.keys(RISK_RANK).find((key) => RISK_RANK[key] === rank) || "Low"; }

async function fetchRouteAlternatives(origin, destination, form) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, destination, loadWeightLb: Number(form.weight), grossWeightLb: Number(form.grossWeight), heightFt: Number(form.heightFt) }),
    signal: AbortSignal.timeout(22000),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("The routing service returned an unreadable response."); }
  if (!response.ok) throw new Error(payload.error || "Mapbox could not analyze this route.");
  return payload;
}

function pointAlongPath(coordinates, fraction) {
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const length = milesBetween({ lat: coordinates[index - 1][0], lon: coordinates[index - 1][1] }, { lat: coordinates[index][0], lon: coordinates[index][1] });
    lengths.push(length);
    total += length;
  }
  if (!lengths.length || !total) return coordinates[0];
  let remaining = clamp(fraction, 0, 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const localFraction = lengths[index] ? clamp(remaining / lengths[index], 0, 1) : 0;
      const first = coordinates[index];
      const second = coordinates[index + 1];
      return [first[0] + (second[0] - first[0]) * localFraction, first[1] + (second[1] - first[1]) * localFraction];
    }
    remaining -= lengths[index];
  }
  return coordinates[coordinates.length - 1];
}

function classifyWeather(wind, rain, snow, loadWeight) {
  let rank = 0;
  if (wind >= 55 || rain > 1 || snow > 3) rank = 4;
  else if (wind >= 45 || rain > 0.5 || snow > 2) rank = 3;
  else if (wind >= 35 || rain > 0.25 || snow > 1) rank = 2;
  else if (wind >= 25 || rain >= 0.1 || snow >= 0.5) rank = 1;
  if (wind >= 55 || (wind >= 45 && wind < 55 && loadWeight > 30000)) rank = 4;
  else if (wind >= 35 && wind < 45 && loadWeight > 40000) rank = Math.max(rank, 3);
  return levelFromRank(rank);
}

function weatherAt(routeIndex, checkpointIndex, forecastHour, loadWeight) {
  const wave = Math.sin(checkpointIndex * 1.71 + routeIndex * 2.3 + forecastHour * 0.16);
  const secondary = Math.cos(checkpointIndex * 0.77 - routeIndex + forecastHour * 0.08);
  const routeBase = [28, 37, 23][routeIndex];
  const wind = clamp(routeBase + wave * [10, 13, 8][routeIndex] + secondary * 3, 8, 63);
  const rain = clamp([0.08, 0.17, 0.05][routeIndex] + Math.max(0, secondary) * [0.18, 0.38, 0.14][routeIndex] + (wave > 0.55 ? 0.15 : 0), 0, 1.35);
  const snow = clamp((routeIndex === 1 ? Math.max(0, wave - 0.5) * 1.7 : Math.max(0, wave - 0.72) * 0.7), 0, 3.6);
  const risk = classifyWeather(wind, rain, snow, loadWeight);
  return { wind, rain, snow, risk };
}

function buildCheckpoints(route, routeIndex, departure, loadWeight, interval) {
  const count = Math.max(2, Math.ceil(route.distanceMiles / interval) + 1);
  const checkpoints = [];
  for (let index = 0; index < count; index += 1) {
    const distance = Math.min(route.distanceMiles, index * interval);
    const fraction = route.distanceMiles ? distance / route.distanceMiles : 0;
    const point = pointAlongPath(route.coordinates, fraction);
    const eta = new Date(departure.getTime() + route.durationHours * 3600000 * fraction);
    const weather = weatherAt(routeIndex, index, Math.max(0, (eta.getTime() - departure.getTime()) / 3600000), loadWeight);
    checkpoints.push({ id: `${routeIndex}-${index}`, index, distance, segmentMiles: index === 0 ? 0 : distance - checkpoints[index - 1].distance, lat: point[0], lon: point[1], eta, ...weather });
  }
  return checkpoints;
}

function summarizeRoute(checkpoints, durationHours) {
  const counts = checkpoints.reduce((summary, checkpoint) => { summary[checkpoint.risk] += 1; summary.riskMiles[checkpoint.risk] += checkpoint.segmentMiles; return summary; }, { Low: 0, Moderate: 0, High: 0, Severe: 0, "No Travel": 0, riskMiles: { Low: 0, Moderate: 0, High: 0, Severe: 0, "No Travel": 0 } });
  const averageRisk = checkpoints.reduce((sum, checkpoint) => sum + RISK_RANK[checkpoint.risk], 0) / checkpoints.length;
  return { counts, averageRisk, durationHours, severeMiles: counts.riskMiles.Severe + counts.riskMiles["No Travel"], highMiles: counts.riskMiles.High };
}

async function enrichWithWeather(routes, loadWeight) {
  const checkpoints = routes.flatMap((route) => route.checkpoints);
  if (!checkpoints.length) return routes;
  const batches = [];
  for (let index = 0; index < checkpoints.length; index += 30) batches.push(checkpoints.slice(index, index + 30));
  const forecasts = (await Promise.all(batches.map(async (batch) => {
    const query = new URLSearchParams({
      latitude: batch.map((point) => point.lat.toFixed(4)).join(","),
      longitude: batch.map((point) => point.lon.toFixed(4)).join(","),
      hourly: "wind_speed_10m,rain,snowfall",
      forecast_days: "7",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "UTC",
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("Open-Meteo forecast unavailable");
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [payload];
  }))).flat();
  let cursor = 0;
  return routes.map((route) => {
    const checkpointsWithWeather = route.checkpoints.map((checkpoint) => {
      const forecast = forecasts[cursor];
      cursor += 1;
      if (!forecast?.hourly?.time?.length) return checkpoint;
      return {
        ...checkpoint,
        liveWeather: true,
        forecastTimes: forecast.hourly.time,
        forecastWind: forecast.hourly.wind_speed_10m,
        forecastRain: forecast.hourly.rain,
        forecastSnow: forecast.hourly.snowfall,
      };
    });
    return { ...route, checkpoints: checkpointsWithWeather, summary: summarizeRoute(checkpointsWithWeather, route.durationHours) };
  });
}

function weatherForTime(checkpoint, targetTime, loadWeight) {
  const times = checkpoint.forecastTimes;
  if (!times?.length) return null;
  let closest = 0;
  for (let index = 1; index < times.length; index += 1) {
    if (Math.abs(Date.parse(times[index]) - targetTime) < Math.abs(Date.parse(times[closest]) - targetTime)) closest = index;
  }
  const difference = Math.abs(Date.parse(times[closest]) - targetTime);
  if (!Number.isFinite(difference) || difference > 90 * 60 * 1000) return null;
  const wind = Number(checkpoint.forecastWind?.[closest]);
  const rain = Number(checkpoint.forecastRain?.[closest]);
  const snow = Number(checkpoint.forecastSnow?.[closest]);
  if (![wind, rain, snow].every(Number.isFinite)) return null;
  return { liveWeather: true, wind, rain, snow, risk: classifyWeather(wind, rain, snow, loadWeight) };
}

function buildRoutes(rawRoutes, origin, destination, form, interval) {
  const departure = new Date(form.departure);
  const routes = rawRoutes.slice(0, 2).map((rawRoute, index) => {
    const checkpoints = buildCheckpoints(rawRoute, index, departure, Number(form.weight), interval);
    const name = `Route ${String.fromCharCode(65 + index)}`;
    const corridor = index === 0 ? "Mapbox primary route" : "Mapbox alternative route";
    return { ...rawRoute, id: `route-${index}`, name, corridor, color: ROUTE_COLORS[index], checkpoints, summary: summarizeRoute(checkpoints, rawRoute.durationHours), origin, destination };
  });
  return routes.sort((first, second) => {
    const a = first.summary;
    const b = second.summary;
    return a.severeMiles - b.severeMiles || a.highMiles - b.highMiles || a.averageRisk - b.averageRisk || a.durationHours - b.durationHours;
  }).map((route, index) => ({ ...route, isRecommended: index === 0 }));
}

function RiskBadge({ level }) { return html`<span className=${`risk-badge ${slugify(level)}`}><span>${level === "No Travel" ? "×" : "●"}</span>${level}</span>`; }

function RouteCard({ route, active, onClick }) {
  const highest = levelFromRank(Math.max(...route.checkpoints.map((checkpoint) => RISK_RANK[checkpoint.risk])));
  return html`
    <article className=${`route-card ${active ? "active" : ""} ${route.isRecommended ? "recommended" : ""}`} onClick=${onClick} onKeyDown=${(event) => event.key === "Enter" && onClick()} role="button" tabIndex="0">
      <div className="route-card-head"><span className="route-line"></span><div><div className="route-card-title">${route.name}</div><div className="route-card-caption">${route.corridor}</div></div></div>
      <div className="route-stats"><div className="route-stat"><span>Distance</span><strong>${formatNumber(route.distanceMiles)} mi</strong></div><div className="route-stat"><span>Drive time</span><strong>${formatHours(route.durationHours)}</strong></div></div>
      <div className="risk-row"><${RiskBadge} level=${highest} /><span className="risk-count">${formatNumber(route.summary.severeMiles)} severe / ${formatNumber(route.summary.highMiles)} high mi</span></div>
    </article>`;
}

function RouteForm({ form, setForm, onSubmit, resetDemo, loading }) {
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return html`
    <form className="route-form" onSubmit=${(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="field location-field"><label for="origin">Origin</label><span className="location-icon">●</span><input id="origin" value=${form.origin} onInput=${update("origin")} placeholder="City, state or ZIP" required /></div>
      <div className="field location-field"><label for="destination">Destination</label><span className="location-icon">◆</span><input id="destination" value=${form.destination} onInput=${update("destination")} placeholder="City, state or ZIP" required /></div>
      <div className="field"><label for="departure">Departure date and time</label><input id="departure" type="datetime-local" value=${form.departure} onInput=${update("departure")} required /></div>
      <div className="field"><label for="weight">Cargo load weight</label><div className="input-suffix"><input id="weight" type="number" min="0" max="100000" step="100" value=${form.weight} onInput=${update("weight")} required /><span className="suffix">lb</span></div><small className="field-help">Used to score wind exposure.</small></div>
      <div className="field"><label for="grossWeight">Truck gross weight</label><div className="input-suffix"><input id="grossWeight" type="number" min="1" max="220462" step="500" value=${form.grossWeight} onInput=${update("grossWeight")} required /><span className="suffix">lb</span></div><small className="field-help">Used for Mapbox road weight limits.</small></div>
      <div className="field"><label for="heightFt">Truck height</label><div className="input-suffix"><input id="heightFt" type="number" min="1" max="32.8" step="0.1" value=${form.heightFt} onInput=${update("heightFt")} required /><span className="suffix">ft</span></div><small className="field-help">Used for available road height limits.</small></div>
      <button className="button-primary" type="submit" disabled=${loading}>${loading ? "Analyzing corridor…" : "Analyze safest routes  →"}</button>
      <button className="demo-link" type="button" onClick=${resetDemo}>Reset to Denver → Chicago demo</button>
    </form>`;
}

function MapView({ routes, activeRouteId, forecastHour, onSelect, mapToken }) {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const baseLayerRef = useRef(null);
  useEffect(() => {
    if (!mapElement.current || mapRef.current || !window.L) return;
    const map = window.L.map(mapElement.current, { zoomControl: false, attributionControl: true }).setView([39.5, -96], 4);
    window.L.control.zoom({ position: "bottomright" }).addTo(map);
    mapRef.current = map;
    layersRef.current = window.L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 100);
    return () => map.remove();
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    if (baseLayerRef.current) baseLayerRef.current.remove();
    const attribution = '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    baseLayerRef.current = mapToken
      ? window.L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(mapToken)}`, { tileSize: 512, zoomOffset: -1, maxZoom: 22, attribution })
      : window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 18, attribution: '&copy; OpenStreetMap &copy; CARTO' });
    baseLayerRef.current.addTo(map);
  }, [mapToken]);
  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;
    layers.clearLayers();
    if (!routes.length) return;
    const bounds = [];
    routes.forEach((route) => {
      const active = route.id === activeRouteId;
      const line = window.L.polyline(route.coordinates, { color: route.color, weight: active ? 5 : 3, opacity: active ? 0.95 : 0.45, lineCap: "round" }).addTo(layers);
      line.on("click", () => onSelect(route.id));
      line.bindTooltip(`${route.name} · ${route.corridor}`, { sticky: true, className: "route-popup" });
      route.coordinates.forEach((point) => bounds.push(point));
      route.checkpoints.forEach((checkpoint) => {
        const riskColor = RISK_COLORS[checkpoint.risk];
        const heatRadius = active ? 19000 : 12000;
        window.L.circle([checkpoint.lat, checkpoint.lon], { radius: heatRadius, stroke: false, fillColor: riskColor, fillOpacity: active ? 0.095 : 0.035 }).addTo(layers);
        const marker = window.L.circleMarker([checkpoint.lat, checkpoint.lon], { radius: active ? 6 : 4, color: riskColor, weight: 1, fillColor: riskColor, fillOpacity: active ? 0.95 : 0.5 }).addTo(layers);
        marker.bindPopup(`<div class="route-popup"><strong>${route.name} · ${checkpoint.distance.toFixed(0)} mi</strong><span>ETA ${formatEta(checkpoint.eta)}<br>${checkpoint.wind.toFixed(0)} mph wind · ${checkpoint.rain.toFixed(2)} in/hr rain<br>${checkpoint.risk} risk</span></div>`);
      });
    });
    const first = routes[0];
    window.L.marker(first.coordinates[0], { title: "Origin" }).bindTooltip("Origin", { permanent: false }).addTo(layers);
    window.L.marker(first.coordinates[first.coordinates.length - 1], { title: "Destination" }).bindTooltip("Destination", { permanent: false }).addTo(layers);
    if (bounds.length) map.fitBounds(bounds, { padding: [25, 25], maxZoom: 7 });
  }, [routes, activeRouteId, forecastHour, onSelect]);
  return html`<div className="map-panel"><div id="map" ref=${mapElement}></div><div className="map-overlay"><div className="map-chip"><span className="legend-dot"></span> Mapbox route options</div><div className="map-chip"><span className="legend-dot heat"></span> Open-Meteo weather risk</div></div></div>`;
}

function CheckpointTable({ route, interval }) {
  const checkpoints = route ? route.checkpoints.slice(0, 8) : [];
  return html`<div className="panel"><div className="panel-title"><h3>Checkpoint forecast</h3><span>${route ? `${route.name} · every ${interval} mi` : "Select a route"}</span></div><div className="panel-table-scroll"><table className="checkpoint-table"><thead><tr><th>Mile</th><th>ETA</th><th>Wind</th><th>Precip.</th><th>Risk</th></tr></thead><tbody>${checkpoints.length ? checkpoints.map((checkpoint) => html`<tr key=${checkpoint.id}><td className="miles">${checkpoint.distance.toFixed(0)} mi</td><td>${formatEta(checkpoint.eta)}</td><td><span className="weather-value"><span className="weather-icon">↗</span>${checkpoint.wind.toFixed(0)} mph</span></td><td>${checkpoint.rain.toFixed(2)} in/hr</td><td><${RiskBadge} level=${checkpoint.risk} /></td></tr>`) : html`<tr><td className="empty-row" colSpan="5">Run an analysis to see corridor checkpoints.</td></tr>`}</tbody></table></div></div>`;
}

function SummaryPanel({ route, form }) {
  if (!route) return html`<div className="panel skeleton"><div><div className="spinner"></div>Preparing route intelligence…</div></div>`;
  const noTravel = route.summary.counts["No Travel"];
  const recommendation = noTravel ? "Review no-travel checkpoints before departure." : `${route.name} offers the best safety/time balance for this load.`;
  return html`<div className="panel"><div className="panel-title"><h3>Recommendation</h3><span>${formatNumber(Number(form.weight))} lb load</span></div><div className="summary-body"><div className="recommendation"><div className="recommendation-icon">✓</div><div><strong>${recommendation}</strong><p>Prioritized by severe miles, high-risk miles, average risk, then travel time.</p></div></div><div className="summary-stat"><span>Average risk score</span><strong>${route.summary.averageRisk.toFixed(2)} / 4</strong></div><div className="summary-stat"><span>Severe / no-travel</span><strong>${formatNumber(route.summary.severeMiles)} mi</strong></div><div className="summary-stat"><span>Arrival estimate</span><strong>${formatEta(route.checkpoints[route.checkpoints.length - 1].eta)}</strong></div></div><div className="risk-legend"><div className="risk-legend-row"><span><i className="risk-key" style=${{ background: RISK_COLORS.Low }}></i>Low</span><span>&lt;25 mph · &lt;0.10 in/hr</span></div><div className="risk-legend-row"><span><i className="risk-key" style=${{ background: RISK_COLORS.Moderate }}></i>Moderate</span><span>25–34 mph</span></div><div className="risk-legend-row"><span><i className="risk-key" style=${{ background: RISK_COLORS.High }}></i>High</span><span>35–44 mph</span></div><div className="risk-legend-row"><span><i className="risk-key" style=${{ background: RISK_COLORS.Severe }}></i>Severe</span><span>45–54 mph</span></div><div className="risk-legend-row"><span><i className="risk-key" style=${{ background: RISK_COLORS["No Travel"] }}></i>No travel</span><span>≥55 mph or load rule</span></div></div></div>`;
}

function App() {
  const [form, setForm] = useState({ ...DEMO_FORM, departure: formatDateInput(new Date()) });
  const [routes, setRoutes] = useState([]);
  const [activeRouteId, setActiveRouteId] = useState(null);
  const [forecastHour, setForecastHour] = useState(0);
  const [interval, setInterval] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Ready for analysis");
  const [mapToken, setMapToken] = useState("");
  const analysisRequestRef = useRef(0);
  const displayRoutes = useMemo(() => routes.map((route, routeIndex) => {
    const checkpoints = route.checkpoints.map((checkpoint) => {
      const targetTime = checkpoint.eta.getTime() + forecastHour * 3600000;
      const weather = weatherForTime(checkpoint, targetTime, Number(form.weight)) || weatherAt(routeIndex, checkpoint.index, Math.max(0, (checkpoint.eta.getTime() - new Date(form.departure).getTime()) / 3600000) + forecastHour, Number(form.weight));
      return { ...checkpoint, ...weather };
    });
    return { ...route, checkpoints, summary: summarizeRoute(checkpoints, route.durationHours) };
  }).sort((first, second) => first.summary.severeMiles - second.summary.severeMiles || first.summary.highMiles - second.summary.highMiles || first.summary.averageRisk - second.summary.averageRisk || first.summary.durationHours - second.summary.durationHours).map((route, index) => ({ ...route, isRecommended: index === 0 })), [routes, forecastHour, form.departure, form.weight]);
  const activeRoute = useMemo(() => displayRoutes.find((route) => route.id === activeRouteId) || displayRoutes[0], [displayRoutes, activeRouteId]);

  useEffect(() => {
    fetch("/api/config").then((response) => response.ok ? response.json() : Promise.reject(new Error("config unavailable"))).then((config) => setMapToken(config.mapboxPublicToken || "")).catch(() => {});
  }, []);

  const runAnalysis = async (submittedForm = form) => {
    const requestId = analysisRequestRef.current + 1;
    analysisRequestRef.current = requestId;
    setLoading(true); setError(""); setRoutes([]); setActiveRouteId(null); setStatus("Geocoding locations with Mapbox…");
    try {
      setStatus("Finding Mapbox routes with truck dimensions…");
      const routeData = await fetchRouteAlternatives(submittedForm.origin, submittedForm.destination, submittedForm);
      const analyzedRoutes = buildRoutes(routeData.routes, routeData.origin, routeData.destination, submittedForm, interval);
      if (!analyzedRoutes.length) throw new Error("Mapbox returned no usable route options.");
      setRoutes(analyzedRoutes); setActiveRouteId(analyzedRoutes[0].id); setForecastHour(0); setStatus(`Mapbox found ${analyzedRoutes.length} route${analyzedRoutes.length === 1 ? "" : "s"} · loading hourly weather…`);
      enrichWithWeather(analyzedRoutes, Number(submittedForm.weight)).then((enrichedRoutes) => { if (analysisRequestRef.current === requestId) { setRoutes(enrichedRoutes); setStatus("Mapbox routes · Open-Meteo forecast ready"); } }).catch(() => { if (analysisRequestRef.current === requestId) setStatus("Mapbox routes · forecast fallback active"); });
    } catch (analysisError) {
      setError(analysisError.message || "Unable to analyze this corridor."); setStatus("Analysis needs attention");
    } finally { setLoading(false); }
  };

  const resetDemo = () => {
    const demo = { ...DEMO_FORM, departure: formatDateInput(new Date()) };
    setForm(demo);
    runAnalysis(demo);
  };

  useEffect(() => { runAnalysis({ ...DEMO_FORM, departure: formatDateInput(new Date()) }); }, []);
  useEffect(() => {
    if (!routes.length) return;
    const rebuilt = buildRoutes(routes, routes[0].origin, routes[0].destination, form, interval);
    const requestId = analysisRequestRef.current + 1;
    analysisRequestRef.current = requestId;
    setRoutes(rebuilt); setActiveRouteId(rebuilt[0].id); setStatus("Refreshing route checkpoints and weather…");
    enrichWithWeather(rebuilt, Number(form.weight)).then((enrichedRoutes) => { if (analysisRequestRef.current === requestId) { setRoutes(enrichedRoutes); setStatus("Mapbox routes · Open-Meteo forecast ready"); } }).catch(() => { if (analysisRequestRef.current === requestId) setStatus("Mapbox routes · forecast fallback active"); });
  }, [interval]);

  return html`<div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark">S</div><div className="brand-name">spotter<span>AI</span></div></div><div className="topbar-right"><span className="live-dot"></span><span>Routing intelligence</span><span className="topbar-badge">Mapbox + Open-Meteo</span></div></header><div className="workspace"><aside className="sidebar"><p className="eyebrow">Driver safety console</p><h1>Find the safer way forward.</h1><p className="subcopy">Compare Mapbox route options against hourly weather at each checkpoint. Truck gross weight and height filter available road restrictions.</p><${RouteForm} form=${form} setForm=${setForm} onSubmit=${runAnalysis} resetDemo=${resetDemo} loading=${loading} /><div className="sidebar-foot"><strong>How scoring works</strong>Routes are ranked by severe miles, high-risk miles, average weather risk, then travel time. Cargo load can escalate wind risk.</div></aside><main className="main"><div className="main-header"><div><h2>Weather-aware route planner</h2><p>${form.origin} <span aria-hidden="true">→</span> ${form.destination} · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(form.departure))}</p></div><div className="status-pill"><span className=${`status-pulse ${loading ? "loading" : ""}`}></span>${status}</div></div>${error ? html`<div className="error-banner">${error}</div>` : null}<${MapView} routes=${displayRoutes} activeRouteId=${activeRouteId} forecastHour=${forecastHour} onSelect=${setActiveRouteId} mapToken=${mapToken} /><div className="forecast-strip"><div className="forecast-label"><strong>Forecast window</strong><span>Open-Meteo at checkpoint arrival time</span></div><div className="slider-wrap"><span>Now</span><input type="range" min="0" max="48" step="1" value=${forecastHour} onInput=${(event) => setForecastHour(Number(event.target.value))} /><span>48h</span></div><div className="slider-value">+${forecastHour} hours</div><div className="map-note">● Checkpoints sampled every ${interval} mi</div></div><div className="section-heading"><div><h3>Route options</h3><span>${displayRoutes.length ? `${displayRoutes.length} Mapbox driving option${displayRoutes.length === 1 ? "" : "s"} ranked by weather risk` : "Waiting for Mapbox route options"}</span></div><div className="interval-switch">${[10, 25, 50].map((value) => html`<button className=${interval === value ? "active" : ""} onClick=${() => setInterval(value)}>${value} mi</button>`)}</div></div><div className="route-grid">${displayRoutes.length ? displayRoutes.map((route) => html`<${RouteCard} key=${route.id} route=${route} active=${route.id === activeRouteId} onClick=${() => setActiveRouteId(route.id)} />`) : html`<div className="panel skeleton"><div><div className="spinner"></div>${loading ? "Finding Mapbox routes…" : "Enter locations to find route options."}</div></div>`}</div><div className="section-heading"><div><h3>Route detail</h3><span>Open-Meteo arrival-time snapshots</span></div></div><div className="details-grid"><${CheckpointTable} route=${activeRoute} interval=${interval} /><${SummaryPanel} route=${activeRoute} form=${form} /></div></main></div></div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
