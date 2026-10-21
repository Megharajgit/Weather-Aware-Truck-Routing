from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_error(405, "POST required")

    def do_POST(self):
        body = json.dumps({
            "ok": True,
            "message": "The client route adapter is ready. Connect production routing and weather providers here.",
            "risk_rules": "wind-rain-snow-load-v1",
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
