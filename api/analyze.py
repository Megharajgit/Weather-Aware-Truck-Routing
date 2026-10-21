import json
from http.server import BaseHTTPRequestHandler

from routing_service import ApiError, analyze_routes


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send_json(405, {"error": "POST required", "code": "method_not_allowed"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 12000:
                raise ApiError(400, "invalid_request_size", "The route request is empty or too large.")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ApiError(400, "invalid_request", "The route request must be a JSON object.")
            self._send_json(200, {"ok": True, **analyze_routes(payload)})
        except ApiError as error:
            self._send_json(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._send_json(400, {"ok": False, "code": "invalid_json", "error": "Send a valid JSON request."})
        except Exception:
            self._send_json(500, {"ok": False, "code": "internal_error", "error": "The routing service encountered an unexpected error."})
