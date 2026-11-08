"""
Hack Club AI image editing for the AI Renovator app.

ONE JOB: take a room photo + a change request (+ optional restrictions), send both
to Hack Club AI's image model, and give back the edited photo.

Everything happens in memory. Nothing is written to disk and nothing is stored in a
database -- that keeps the integration trivial for the rest of the app.

The API is OpenRouter-compatible:
    POST https://ai.hackclub.com/proxy/v1/chat/completions
    Authorization: Bearer <HACKCLUB_AI_API_KEY>

The image is sent as an image_url content part containing a data URL. The edited
image comes back as a data URL in choices[0].message.images[0].image_url.url.
"""

from __future__ import annotations

import base64
import io
import logging
import math
import os
import time
from typing import Optional

import httpx
from PIL import Image, ImageOps

log = logging.getLogger("renovator.hackclub")

# ---------------------------------------------------------------------------
# Model / API
# ---------------------------------------------------------------------------
DEFAULT_MODEL = "google/gemini-nano-banana-2.1"
PROVIDER = "hackclub-ai"
DEFAULT_API_BASE = "https://ai.hackclub.com/proxy/v1"

# ---------------------------------------------------------------------------
# Limits. Sized so a phone photo works without blowing up latency or memory.
# ---------------------------------------------------------------------------
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB hard cap on what we accept
REFERENCE_MAX_SIDE = 1024            # keep the base64 image payload reasonable
JPEG_QUALITY = 92                    # re-encode quality after downscaling
REQUEST_TIMEOUT_SECONDS = 180        # image models can take a while
RETRY_DELAY_SECONDS = 1.5            # one retry, short pause, then give up

ALLOWED_INPUT_MIMES = {"image/jpeg", "image/png", "image/webp"}
# What Pillow reports as `image.format` -> the mime type we accept for it.
ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}

# Hack Club AI / Gemini accepts a fixed set of output aspect ratios.
ASPECT_RATIOS = [
    ("1:1", 1.0),
    ("2:3", 2 / 3),
    ("3:2", 3 / 2),
    ("3:4", 3 / 4),
    ("4:3", 4 / 3),
    ("4:5", 4 / 5),
    ("5:4", 5 / 4),
    ("9:16", 9 / 16),
    ("16:9", 16 / 9),
    ("21:9", 21 / 9),
]


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
PROMPT_TEMPLATE = """Edit the supplied photograph of a real room.

CHANGE REQUEST:
{change_request}

HARD RESTRICTIONS:
{restrictions}

Keep everything else exactly as it is in the supplied photograph:
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


def get_model_name() -> str:
    """The image model in use; overridable without touching the code."""
    return (os.getenv("HACKCLUB_IMAGE_MODEL") or DEFAULT_MODEL).strip() or DEFAULT_MODEL


def _api_base() -> str:
    return (os.getenv("HACKCLUB_AI_BASE_URL") or DEFAULT_API_BASE).strip().rstrip("/")


def _chat_url() -> str:
    return f"{_api_base()}/chat/completions"


def choose_aspect_ratio(width: int, height: int) -> str:
    """Pick the supported aspect ratio closest to the original image's ratio."""
    if width <= 0 or height <= 0:
        return "1:1"
    ratio = width / float(height)
    return min(ASPECT_RATIOS, key=lambda item: abs(math.log(item[1] / ratio)))[0]


# ---------------------------------------------------------------------------
# Image preparation
# ---------------------------------------------------------------------------
def prepare_image(raw: bytes, declared_mime: Optional[str] = None) -> tuple[bytes, str]:
    """
    Validate an uploaded image and normalise it for the model.

    - rejects empty / oversized / unsupported / corrupt files with a clear error
    - fixes EXIF rotation so the model does not see the room sideways
    - flattens transparency onto white
    - downscales to REFERENCE_MAX_SIDE for the base64 payload

    Returns (jpeg_bytes, aspect_ratio).
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

    aspect_ratio = choose_aspect_ratio(*img.size)

    reference = img.copy()
    reference.thumbnail((REFERENCE_MAX_SIDE, REFERENCE_MAX_SIDE), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    reference.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buffer.getvalue(), aspect_ratio


# ---------------------------------------------------------------------------
# Hack Club AI call
# ---------------------------------------------------------------------------
_client: Optional[httpx.Client] = None  # created once, reused (thread-safe)


def is_configured() -> bool:
    """True when the Hack Club API key is present, so /api/health can report readiness."""
    return bool(os.getenv("HACKCLUB_AI_API_KEY", "").strip())


def _get_client() -> httpx.Client:
    """Build the HTTP client on first use, with a clear error if credentials are missing."""
    global _client
    if _client is not None:
        return _client

    api_key = os.getenv("HACKCLUB_AI_API_KEY", "").strip()
    if not api_key:
        raise ImageEditError(
            "missing_api_key",
            "HACKCLUB_AI_API_KEY is not set on the server. Add it to .env and restart.",
            500,
        )

    _client = httpx.Client(
        timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    return _client


def _error_message(data: object) -> str:
    """Pull a readable message out of Hack Club AI's error envelope."""
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, str) and error.strip():
            return error.strip()
        if isinstance(error, dict):
            for key in ("message", "code", "type"):
                value = error.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        for key in ("message", "detail"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _decode_data_url(value: str) -> Optional[tuple[bytes, str]]:
    """Decode a data:image/...;base64,... URL (or a bare base64 image)."""
    if not isinstance(value, str) or not value.strip():
        return None

    value = value.strip()
    if value.startswith("data:"):
        header, separator, encoded = value.partition(",")
        if not separator:
            return None
        mime = header[5:].split(";")[0].strip() or "image/png"
    else:
        encoded = value
        mime = "image/png"

    try:
        raw = base64.b64decode(encoded, validate=False)
    except Exception:
        return None

    if not raw:
        return None
    return raw, mime


def _extract_image(response: httpx.Response) -> tuple[bytes, str, str]:
    """
    Get the image bytes out of a Hack Club AI response.

    The normal shape is:
        choices[0].message.images[0].image_url.url = "data:image/png;base64,..."
    Raw image responses are handled too, just in case the proxy changes.
    """
    content_type = (response.headers.get("content-type") or "").lower()

    if content_type.startswith("image/"):
        return response.content, content_type.split(";")[0], ""

    try:
        data = response.json()
    except Exception:
        if response.content[:8] == b"\x89PNG\r\n\x1a\n" or response.content[:2] == b"\xff\xd8":
            detected = "image/png" if response.content[:1] == b"\x89" else "image/jpeg"
            return response.content, detected, ""
        raise ImageEditError(
            "upstream_error",
            "The image model returned an unreadable response. Please try again.",
            502,
        )

    message_text = ""
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                message_text = content.strip()

            images = message.get("images")
            if isinstance(images, list) and images:
                first = images[0]
                image_url = first.get("image_url") if isinstance(first, dict) else None
                if isinstance(image_url, dict):
                    url = image_url.get("url")
                elif isinstance(image_url, str):
                    url = image_url
                else:
                    url = None

                if isinstance(url, str):
                    decoded = _decode_data_url(url)
                    if decoded is not None:
                        image_bytes, mime_type = decoded
                        return image_bytes, mime_type, message_text

    detail = _error_message(data)
    raise ImageEditError(
        "upstream_error",
        detail or "The image model returned no image. Please try again.",
        502,
    )


def _translate_error(response: httpx.Response) -> ImageEditError:
    """Turn a Hack Club AI HTTP error into something the app can show a user."""
    status = response.status_code
    try:
        detail = _error_message(response.json())
    except Exception:
        detail = (response.text or "")[:200].strip()

    if status in (401, 403):
        return ImageEditError(
            "auth_failed",
            "Hack Club AI rejected the API key. Check HACKCLUB_AI_API_KEY on the server.",
            502,
        )
    if status == 404:
        return ImageEditError(
            "model_unavailable",
            f"The image model {get_model_name()} is not available through Hack Club AI.",
            502,
        )
    if status == 429:
        return ImageEditError(
            "rate_limited",
            "Hack Club AI is rate limiting this account. Please try again later.",
            429,
        )
    if status == 400:
        return ImageEditError(
            "upstream_rejected",
            "The image model rejected that request. Try a different photo or change request.",
            502,
        )
    log.error("Hack Club AI error (status=%s): %s", status, detail)
    return ImageEditError(
        "upstream_error",
        "Something went wrong talking to the image model. Please try again.",
        502,
    )


def _request_once(prompt: str, reference: bytes, aspect_ratio: str) -> tuple[bytes, str, str]:
    """Send one image-edit request to Hack Club AI and return the resulting image."""
    client = _get_client()
    encoded = base64.b64encode(reference).decode("ascii")

    payload = {
        "model": get_model_name(),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
                    },
                ],
            }
        ],
        "modalities": ["image", "text"],
        "image_config": {"aspect_ratio": aspect_ratio},
        "stream": False,
    }

    try:
        response = client.post(_chat_url(), json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
    except httpx.TimeoutException:
        raise ImageEditError(
            "timeout", "The image model took too long to respond. Please try again.", 504
        )
    except httpx.HTTPError as exc:
        log.error("Hack Club AI request failed: %s", exc)
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
    Edit a room photo with Hack Club AI and return the result.

    Returns:
        {"image_bytes": bytes, "mime_type": str, "message": str, "latency_ms": int}

    Raises ImageEditError for every failure mode so the API can answer with clean JSON.
    """
    change_request = (change_request or "").strip()
    if not change_request:
        raise ImageEditError(
            "empty_change_request", "Please describe the change you want in the room.", 400
        )

    reference, aspect_ratio = prepare_image(raw_image, declared_mime)
    prompt = build_prompt(change_request, restrictions)

    _get_client()  # fail fast with missing_api_key before we start timing
    started = time.perf_counter()

    image_out: Optional[bytes] = None
    mime_out = "image/png"
    message_out = ""
    for attempt in (1, 2):
        try:
            image_out, mime_out, message_out = _request_once(prompt, reference, aspect_ratio)
            break
        except ImageEditError as exc:
            if attempt == 1 and _is_transient(exc):
                log.warning("Hack Club edit failed (transient), retrying once: %s", exc.message)
                time.sleep(RETRY_DELAY_SECONDS)
                continue
            raise

    latency_ms = int((time.perf_counter() - started) * 1000)
    fallback_message = f"Edited with Hack Club AI ({get_model_name()})."

    return {
        "image_bytes": image_out or b"",
        "mime_type": mime_out,
        "message": (message_out[:300] if message_out else fallback_message),
        "latency_ms": latency_ms,
    }
