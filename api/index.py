import os

from django.conf import settings
from django.http import JsonResponse
from django.urls import path
from django.core.wsgi import get_wsgi_application


if not settings.configured:
    settings.configure(
        DEBUG=os.environ.get("DJANGO_DEBUG", "false").lower() == "true",
        SECRET_KEY=os.environ.get("DJANGO_SECRET_KEY", "spotter-assessment-secret"),
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["*"],
        MIDDLEWARE=[],
        INSTALLED_APPS=[],
        DEFAULT_CHARSET="utf-8",
    )


def health(request):
    return JsonResponse({"ok": True, "service": "spotter-routing-api", "mode": "demo-compatible"})


def analyze(request):
    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)
    return JsonResponse({
        "ok": True,
        "message": "The client route adapter is ready. Connect production routing and weather providers here.",
        "risk_rules": "wind-rain-snow-load-v1",
    })


urlpatterns = [path("api/health", health), path("api/health/", health), path("api/analyze", analyze), path("api/analyze/", analyze)]
app = get_wsgi_application()
