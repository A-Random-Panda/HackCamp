"""
AI Renovator -- image edit microservice.

Exposes ONE endpoint for the main app:

    POST /api/edit   multipart/form-data: image, change_request, restrictions
    -> JSON { ok, image_base64, image_mime_type, message, model, latency_ms }

Also serves the temporary manual test page at /test-ui (see temp_test_ui/index.html).
That page exists only to exercise the endpoint by hand; it is not the product UI.

Run it:
    .venv/Scripts/python.exe main.py          (or: uvicorn main:app --reload)
"""

from __future__ import annotations

import base64
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env before anything reads the Hack Club API key.
load_dotenv()

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from hackclub_edit import (
    MAX_UPLOAD_BYTES,
    PROVIDER,
    ImageEditError,
    edit_room_image,
    get_model_name,
    is_configured,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("renovator.api")

BASE_DIR = Path(__file__).resolve().parent
TEST_UI_FILE = BASE_DIR / "temp_test_ui" / "index.html"

app = FastAPI(
    title="AI Renovator - Image Edit API",
    version="1.0.0",
    description="Room photo in, renovated room photo out. One endpoint, stateless.",
)

# The teammate's frontend runs on a different port, so browser calls need CORS.
# Default "*" is fine for the hackathon; ALLOWED_ORIGINS narrows it for a real deploy.
_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Error handling: every failure becomes JSON with a stable `code`.
# ---------------------------------------------------------------------------
@app.exception_handler(ImageEditError)
async def handle_image_edit_error(request: Request, exc: ImageEditError):
    log.info("edit failed: %s (%s) %s", exc.code, exc.status, exc.message)
    return JSONResponse(
        status_code=exc.status,
        content={"ok": False, "error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception):
    # Last line of defence: never leak a traceback to the caller, never crash the server.
    log.exception("unexpected error handling %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "ok": False,
            "error": {"code": "server_error", "message": "Unexpected server error. Please try again."},
        },
    )


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    """Tiny check so the teammate (and the test UI) can see the service is alive."""
    return {
        "ok": True,
        "provider": PROVIDER,
        "model": get_model_name(),
        "api_key_configured": is_configured(),
    }


@app.post("/api/edit")
async def edit(
    image: UploadFile | None = File(default=None),
    change_request: str = Form(default=""),
    restrictions: str = Form(default=""),
):
    """
    Edit a room photo.

    Form fields:
      image           required, JPEG/PNG/WebP, max 20 MB (any photo, including a previous result)
      change_request  required, what to change, e.g. "restyle the kitchen in warm oak"
      restrictions    optional, hard limits, e.g. "no structural changes, keep the window"

    Success (200):
      { "ok": true, "image_base64": "...", "image_mime_type": "image/png",
        "message": "model's short description, may be empty",
        "model": "google/gemini-nano-banana-2.1", "latency_ms": 12345 }

    Failure: { "ok": false, "error": { "code": "...", "message": "..." } }
    """
    if image is None:
        raise ImageEditError("missing_image", "No image was uploaded.", 400)

    # Read with a cap so an enormous upload cannot exhaust memory.
    raw = await image.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ImageEditError(
            "image_too_large",
            f"That image is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB. "
            "Please use a smaller photo.",
            413,
        )

    # The Hack Club AI call is blocking network I/O, so keep it off the event loop.
    result = await run_in_threadpool(
        edit_room_image, raw, change_request, restrictions, image.content_type
    )

    return {
        "ok": True,
        "image_base64": base64.b64encode(result["image_bytes"]).decode("ascii"),
        "image_mime_type": result["mime_type"],
        "message": result["message"],
        "model": get_model_name(),
        "latency_ms": result["latency_ms"],
    }


# ---------------------------------------------------------------------------
# Temporary manual test UI (not part of the product)
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return RedirectResponse(url="/test-ui")


@app.get("/test-ui")
async def test_ui():
    if not TEST_UI_FILE.exists():
        raise ImageEditError("test_ui_missing", "temp_test_ui/index.html is missing.", 500)
    return FileResponse(TEST_UI_FILE)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
