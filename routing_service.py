"""Server-side Mapbox geocoding and driving-route adapter."""

import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


def _mapbox_json(url, token):
    separator = "&" if "?" in url else "?"
    request = Request(
        f"{url}{separator}{urlencode({'access_token': token})}",
        headers={"Accept": "application/json", "User-Agent": "SpotterWeatherRouting/1.0"},
    )
    try:
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            response_payload = json.loads(error.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            response_payload = {}
        if error.code in (401, 403):
            raise ApiError(502, "mapbox_token_rejected", "Mapbox rejected the server token. Check that it is valid and allowed to use Geocoding and Directions.") from error
        if error.code == 429:
            raise ApiError(503, "mapbox_rate_limited", "Mapbox's request limit was reached. Please try again shortly.") from error
        message = response_payload.get("message") or "Mapbox could not complete the request."
        raise ApiError(502, "mapbox_request_failed", message) from error
    except (URLError, TimeoutError) as error:
        raise ApiError(504, "mapbox_timeout", "Mapbox took too long to respond. Please try again.") from error
    except (ValueError, UnicodeDecodeError) as error:
        raise ApiError(502, "mapbox_invalid_response", "Mapbox returned an unreadable response.") from error


def _geocode(place, token):
    query = urlencode({"q": place, "limit": 1, "autocomplete": "false"})
    payload = _mapbox_json(f"https://api.mapbox.com/search/geocode/v6/forward?{query}", token)
    features = payload.get("features") or []
    if not features:
        raise ApiError(422, "location_not_found", f"Could not locate “{place}”. Try a city and state, ZIP code, or street address.")
    feature = features[0]
    coordinates = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coordinates) < 2:
        raise ApiError(502, "mapbox_invalid_geocode", "Mapbox did not return coordinates for that location.")
    properties = feature.get("properties") or {}
    return {
        "lon": float(coordinates[0]),
        "lat": float(coordinates[1]),
        "label": properties.get("full_address") or properties.get("name") or place,
    }


def analyze_routes(payload):
    token = os.environ.get("MAPBOX_ACCESS_TOKEN", "").strip()
    if not token:
        raise ApiError(503, "mapbox_access_token_missing", "Add MAPBOX_ACCESS_TOKEN to the Vercel project environment variables, then redeploy.")

    origin_text = str(payload.get("origin", "")).strip()[:160]
    destination_text = str(payload.get("destination", "")).strip()[:160]
    if not origin_text or not destination_text:
        raise ApiError(400, "locations_required", "Enter both an origin and destination.")

    try:
        load_weight_lb = float(payload.get("loadWeightLb", 0))
        gross_weight_lb = float(payload.get("grossWeightLb", 0))
        height_ft = float(payload.get("heightFt", 0))
    except (TypeError, ValueError):
        raise ApiError(400, "invalid_vehicle_dimensions", "Enter valid truck and load measurements.")
    if not all(math.isfinite(value) for value in (load_weight_lb, gross_weight_lb, height_ft)):
        raise ApiError(400, "invalid_vehicle_dimensions", "Enter finite truck and load measurements.")
    if load_weight_lb < 0 or load_weight_lb > 100000:
        raise ApiError(400, "invalid_load_weight", "Load weight must be between 0 and 100,000 lb.")
    if gross_weight_lb <= 0 or gross_weight_lb > 220462:
        raise ApiError(400, "invalid_gross_weight", "Truck gross weight must be between 1 and 220,462 lb.")
    if gross_weight_lb < load_weight_lb:
        raise ApiError(400, "gross_weight_below_load", "Truck gross weight must be at least as high as the cargo load weight.")
    if height_ft <= 0 or height_ft > 32.8:
        raise ApiError(400, "invalid_height", "Truck height must be greater than 0 and no more than 32.8 ft.")

    with ThreadPoolExecutor(max_workers=2) as pool:
        origin_future = pool.submit(_geocode, origin_text, token)
        destination_future = pool.submit(_geocode, destination_text, token)
        origin = origin_future.result()
        destination = destination_future.result()

    coordinates = f"{origin['lon']},{origin['lat']};{destination['lon']},{destination['lat']}"
    route_url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{quote(coordinates, safe=';,.-')}.json"
    route_query = urlencode({
        "alternatives": "true",
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
        "max_weight": f"{gross_weight_lb / 2204.62262185:.2f}",
        "max_height": f"{height_ft * 0.3048:.3f}",
    })
    routes_payload = _mapbox_json(f"{route_url}?{route_query}", token)
    if routes_payload.get("code") != "Ok" or not routes_payload.get("routes"):
        code = routes_payload.get("code") or "NoRoute"
        if code in ("NoRoute", "NoSegment"):
            raise ApiError(422, "no_truck_route", "Mapbox couldn't find a route for these locations and truck dimensions. Check the gross weight and height.")
        raise ApiError(502, "mapbox_directions_failed", "Mapbox could not calculate routes for this trip.")

    routes = []
    for route in routes_payload["routes"][:2]:
        geometry = route.get("geometry") or {}
        points = geometry.get("coordinates") or []
        if len(points) < 2:
            continue
        legs = route.get("legs") or [{}]
        routes.append({
            "coordinates": [[float(lat), float(lon)] for lon, lat in points],
            "distanceMiles": float(route.get("distance", 0)) / 1609.344,
            "durationHours": float(route.get("duration", 0)) / 3600,
            "summary": legs[0].get("summary") or "Mapbox driving route",
        })
    if not routes:
        raise ApiError(502, "mapbox_invalid_route", "Mapbox returned route options without usable map geometry.")

    return {"origin": origin, "destination": destination, "routes": routes}
