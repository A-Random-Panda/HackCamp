"""
Cloudflare Workers AI image editing for the AI Renovator app.

ONE JOB: take a room photo + a change request (+ optional restrictions), hand both to
Cloudflare's FLUX.2 image model, and give back the edited photo.

Everything happens in memory. Nothing is written to disk and nothing is stored in a
database -- that keeps the integration trivial for the rest of the app.

Why this model:
    @cf/black-forest-labs/flux-2-klein-4b is a distilled FLUX.2 that both generates and
    *edits* images, on the Workers AI free allocation. Tests on real interiors showed it
    holding the room together (same cabinets, appliances, framing) while applying the
    requested change -- unlike the retired SD1.5 img2img model, which Cloudflare no longer
    serves, and unlike flux-2-dev, which widened the camera angle and invented a window.

Cloudflare specifics that cost real debugging time (see README):
  * the request MUST be multipart/form-data, even for a prompt-only call;
  * the reference image part MUST be named `input_image_0`, `input_image_1`, ... --
    `input_image` or `image` is silently ignored and you get a text-to-image render;
  * every reference image must be SMALLER THAN 512x512 px;
  * steps are fixed at 4 and cannot be set.

Cloudflare usage lives in `_get_client()` (auth/config) and `_request_once()` (the call).
"""

from __future__ import annotations

import base64
import io
import logging
import os
import time
from typing import Optional

import httpx
from PIL import Image, ImageOps

log = logging.getLogger("renovator.cloudflare")

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
MODEL = "@cf/black-forest-labs/flux-2-klein-4b"
PROVIDER = "cloudflare-workers-ai"
API_BASE = "https://api.cloudflare.com/client/v4/accounts"

# ---------------------------------------------------------------------------
# Limits. Sized so a phone photo works without blowing up latency or memory.
# ---------------------------------------------------------------------------
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB hard cap on what we accept
REFERENCE_MAX_SIDE = 500             # Workers AI rejects reference images >= 512x512
OUTPUT_LONG_SIDE = 1024              # requested output size, aspect ratio preserved
OUTPUT_MIN_SIDE = 256                # model minimum
OUTPUT_MAX_SIDE = 1920               # model maximum
JPEG_QUALITY = 92                    # re-encode quality after downscaling
REQUEST_TIMEOUT_SECONDS = 180        # FLUX.2 usually answers in seconds, not minutes
RETRY_DELAY_SECONDS = 1.5            # one retry, short pause, then give up

ALLOWED_INPUT_MIMES = {"image/jpeg", "image/png", "image/webp"}
# What Pillow reports as `image.format` -> the mime type we accept for it.
ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


class ImageEditError(Exception):
    """A failure we can describe to the caller. Always becomes clean JSON, never a crash."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------
# FLUX.2 follows instructions far better than a diffusion model needs to, so this keeps
# the spec's full preservation list -- but it opens with "Edit image 0", because that is
# how the model is told which reference to modify. Tests showed the numbered reference
# plus explicit "same camera angle / same positions" is what stops the model re-framing
# the room or inventing a window.
PROMPT_TEMPLATE = """Edit image 0, a photograph of a real room.

CHANGE REQUEST:
{change_request}

HARD RESTRICTIONS:
{restrictions}

Keep everything else exactly as it is in image 0:
1. The same camera position, height, angle, framing and perspective.
2. The same walls, floor, ceiling, windows, doors and built-in features in the same places.
3. The same lighting, time of day, colour temperature and shadows.
4. Every object the change request does not mention stays in the same position, size, colour and material.
5. Do not add or remove anything the change request did not ask for.
6. A realistic interior photograph, not a render, drawing or illustration.
7. No text, captions, watermarks or interface elements.
If the change request conflicts with a hard restriction, follow the restriction."""

NO_RESTRICTIONS = "None specified - apply only the change request, nothing else."


def build_prompt(change_request: str, restrictions: str = "") -> str:
    """Combine the change request and the restrictions into one instruction for the model."""
    return PROMPT_TEMPLATE.format(
        change_request=change_request.strip(),
        restrictions=(restrictions or "").strip() or NO_RESTRICTIONS,
    )


# ---------------------------------------------------------------------------
# Image preparation
# ---------------------------------------------------------------------------
def prepare_image(raw: bytes, declared_mime: Optional[str] = None) -> tuple[bytes, int, int]:
    """
    Validate an uploaded image and normalise it for the model.

    - rejects empty / oversized / unsupported / corrupt files with a clear error
    - fixes EXIF rotation so the model does not see the room sideways
    - flattens transparency onto white
    - downscales to REFERENCE_MAX_SIDE for the reference image (the API's hard limit)

    Returns (jpeg_bytes, output_width, output_height), where the output size keeps the
    original aspect ratio at OUTPUT_LONG_SIDE, rounded to a multiple of 8.
    """
    if not raw:
        raise ImageEditError("empty_image", "The uploaded image file is empty.", 400)

    if len(raw) > MAX_UPLOAD_BYTES:
        limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        raise ImageEditError(
            "image_too_large",
            f"That image is larger than {limit_mb} MB. Please use a smaller photo.",
            413,
        )

    # A clearly non-image upload (e.g. a PDF) gets a helpful message up front.
    if declared_mime:
        base_mime = declared_mime.split(";")[0].strip().lower()
        if base_mime.startswith("image/") and base_mime not in ALLOWED_INPUT_MIMES:
            raise ImageEditError(
                "unsupported_image_type",
                f"{base_mime} is not supported. Please upload a JPEG, PNG or WebP photo.",
                415,
            )

    try:
        img = Image.open(io.BytesIO(raw))
        source_format = (img.format or "").upper()
        img.load()  # forces Pillow to actually decode the pixels
    except Exception:
        raise ImageEditError(
            "invalid_image",
            "That file could not be read as an image. Please upload a JPEG, PNG or WebP photo.",
            400,
        )

    if source_format not in ALLOWED_FORMATS:
        raise ImageEditError(
            "unsupported_image_type",
            f"{source_format or 'That format'} is not supported. "
            "Please upload a JPEG, PNG or WebP photo.",
            415,
        )

    # Respect the camera's orientation flag, otherwise portrait rooms arrive sideways.
    img = ImageOps.exif_transpose(img) or img

    # Flatten transparency onto white so it does not turn black in JPEG.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Output size: keep the aspect ratio, aim for OUTPUT_LONG_SIDE, stay inside the model's
    # 256..1920 range, and round to /8 (the diffusion latent grid).
    width, height = img.size
    scale = OUTPUT_LONG_SIDE / float(max(width, height))
    out_w = min(OUTPUT_MAX_SIDE, max(OUTPUT_MIN_SIDE, int(round(width * scale / 8)) * 8))
    out_h = min(OUTPUT_MAX_SIDE, max(OUTPUT_MIN_SIDE, int(round(height * scale / 8)) * 8))

    # The reference we send must be strictly smaller than 512x512.
    reference = img.copy()
    reference.thumbnail((REFERENCE_MAX_SIDE, REFERENCE_MAX_SIDE), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    reference.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buffer.getvalue(), out_w, out_h


# ---------------------------------------------------------------------------
# Cloudflare call
# ---------------------------------------------------------------------------
_client: Optional[httpx.Client] = None  # created once, reused (thread-safe)


def is_configured() -> bool:
    """True when both Cloudflare values are present, so /api/health can report readiness."""
    return bool(os.getenv("CLOUDFLARE_ACCOUNT_ID") and os.getenv("CLOUDFLARE_API_TOKEN"))


def _get_client() -> httpx.Client:
    """Build the HTTP client on first use, with a clear error if credentials are missing."""
    global _client
    if _client is not None:
        return _client

    if not is_configured():
        raise ImageEditError(
            "missing_api_key",
            "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not both set on the server. "
            "Add them to .env and restart.",
            500,
        )

    # No default Content-Type: httpx sets multipart/form-data with its own boundary.
    _client = httpx.Client(
        timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
        headers={"Authorization": f"Bearer {os.getenv('CLOUDFLARE_API_TOKEN', '').strip()}"},
    )
    return _client


def _model_url() -> str:
    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    return f"{API_BASE}/{account_id}/ai/run/{MODEL}"


def _error_message(data: object) -> str:
    """Pull a readable message out of Cloudflare's {"success": false, "errors": [...]} envelope."""
    if isinstance(data, dict):
        errors = data.get("errors")
        if isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict):
                return str(first.get("message") or first.get("code") or "").strip()
            return str(first).strip()
    return ""


def _extract_image(response: httpx.Response) -> tuple[bytes, str]:
    """
    Get the image bytes out of a Workers AI response.

    FLUX.2 returns JSON with a base64 image; some other image models return raw bytes,
    so handle both instead of assuming.
    """
    content_type = (response.headers.get("content-type") or "").lower()

    if content_type.startswith("image/"):
        return response.content, content_type.split(";")[0]

    try:
        data = response.json()
    except Exception:
        if response.content[:8] == b"\x89PNG\r\n\x1a\n" or response.content[:2] == b"\xff\xd8":
            detected = "image/png" if response.content[:1] == b"\x89" else "image/jpeg"
            return response.content, detected
        raise ImageEditError(
            "upstream_error",
            "The image model returned an unreadable response. Please try again.",
            502,
        )

    result = data.get("result") if isinstance(data, dict) else None

    if isinstance(result, dict):
        image = result.get("image")
        if isinstance(image, str) and image:
            return base64.b64decode(image), result.get("mime_type") or "image/jpeg"
    if isinstance(result, str) and result:
        return base64.b64decode(result), "image/jpeg"

    message = _error_message(data)
    raise ImageEditError(
        "upstream_error",
        message or "The image model returned no image. Please try again.",
        502,
    )


def _translate_error(response: httpx.Response) -> ImageEditError:
    """Turn a Cloudflare HTTP error into something the app can show a user."""
    status = response.status_code
    detail = ""
    try:
        detail = _error_message(response.json())
    except Exception:
        detail = (response.text or "")[:200].strip()

    if status in (401, 403):
        # 403 is also what Cloudflare returns for a model this account cannot access
        # (error 5018), which is how the retired SD1.5 img2img model surfaced.
        if "not allowed to access" in detail:
            return ImageEditError(
                "model_unavailable",
                f"This Cloudflare account cannot access {MODEL}. "
                "Check the model is available in the Workers AI catalog for your account.",
                502,
            )
        return ImageEditError(
            "auth_failed",
            "Cloudflare rejected the API token, or it lacks the Workers AI permission. "
            "Create a token with Account > Workers AI > Read and update CLOUDFLARE_API_TOKEN.",
            502,
        )
    if status == 404:
        return ImageEditError(
            "model_unavailable",
            f"The image model {MODEL} is not available on this Cloudflare account.",
            502,
        )
    if status == 429:
        return ImageEditError(
            "rate_limited",
            "Cloudflare is rate limiting this account, or today's free Workers AI "
            "allocation is used up. Please try again later.",
            429,
        )
    if status == 400:
        # Error 3030 = invalid model input.
        return ImageEditError(
            "upstream_rejected",
            "The image model rejected that request. Try a different photo or change request.",
            502,
        )
    log.error("Cloudflare error (status=%s): %s", status, detail)
    return ImageEditError(
        "upstream_error",
        "Something went wrong talking to the image model. Please try again.",
        502,
    )


def _request_once(prompt: str, reference: bytes, width: int, height: int) -> tuple[bytes, str]:
    """Send one image-edit request to Workers AI and return the resulting image."""
    client = _get_client()

    # Multipart is mandatory for FLUX.2, and the reference part name must be numbered.
    files = {"input_image_0": ("room.jpg", reference, "image/jpeg")}
    data = {"prompt": prompt, "width": str(width), "height": str(height)}

    try:
        response = client.post(
            _model_url(), data=data, files=files, timeout=REQUEST_TIMEOUT_SECONDS
        )
    except httpx.TimeoutException:
        raise ImageEditError(
            "timeout", "The image model took too long to respond. Please try again.", 504
        )
    except httpx.HTTPError as exc:
        log.error("Cloudflare request failed: %s", exc)
        raise ImageEditError(
            "upstream_error", "Could not reach the image model. Please try again.", 502
        )

    if response.status_code >= 400:
        raise _translate_error(response)

    return _extract_image(response)


def _is_transient(exc: Exception) -> bool:
    """Timeouts and upstream 5xx/429 are worth one retry. Model rejections are not."""
    if isinstance(exc, ImageEditError):
        return exc.code in {"timeout", "upstream_error", "rate_limited"}
    return False


def edit_room_image(
    raw_image: bytes,
    change_request: str,
    restrictions: str = "",
    declared_mime: Optional[str] = None,
) -> dict:
    """
    Edit a room photo with Cloudflare Workers AI and return the result.

    Returns:
        {"image_bytes": bytes, "mime_type": str, "message": str, "latency_ms": int}

    Raises ImageEditError for every failure mode so the API can answer with clean JSON.
    """
    change_request = (change_request or "").strip()
    if not change_request:
        raise ImageEditError(
            "empty_change_request", "Please describe the change you want in the room.", 400
        )

    reference, out_w, out_h = prepare_image(raw_image, declared_mime)
    prompt = build_prompt(change_request, restrictions)

    _get_client()  # fail fast with missing_api_key before we start timing
    started = time.perf_counter()

    image_out: Optional[bytes] = None
    mime_out = "image/jpeg"
    for attempt in (1, 2):
        try:
            image_out, mime_out = _request_once(prompt, reference, out_w, out_h)
            break
        except ImageEditError as exc:
            if attempt == 1 and _is_transient(exc):
                log.warning("Cloudflare edit failed (transient), retrying once: %s", exc.message)
                time.sleep(RETRY_DELAY_SECONDS)
                continue
            raise

    latency_ms = int((time.perf_counter() - started) * 1000)

    return {
        "image_bytes": image_out or b"",
        "mime_type": mime_out,
        "message": "Edited with Cloudflare Workers AI (FLUX.2 klein 4B).",
        "latency_ms": latency_ms,
    }
