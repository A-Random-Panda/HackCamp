# Renovo

Renovo is an AI renovation planner: upload a room photo, describe the change, and get
a priced materials/tools plan plus an edited photo of the same room.

The repository contains two independent backends and the primary React GUI.

**Current provider: [Hack Club AI](https://ai.hackclub.com).** The image service uses
`google/gemini-nano-banana-2.1`; the ideas service uses `google/gemini-2.5-flash`.
Both are configurable with environment variables.

## Repository layout

| Path | Feature | Runtime | Local URL |
|---|---|---|---|
| repo root (`main.py`, `hackclub_edit.py`) | Photo in, renovated room photo out | Python / FastAPI | <http://127.0.0.1:8000/test-ui> |
| `gemini-ideas/` | Tools, rough prices, local stores and steps | dependency-free Node | <http://localhost:3000> |
| `src/` | Primary Renovo GUI | React / TanStack Start | <http://localhost:5173> |

The two backends read separate env files: root `.env` for the image API and
`gemini-ideas/.env` for the ideas API. Both use the same Hack Club AI key.

## Quick start

### Image API

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv/Scripts/activate
pip install -r requirements.txt

cp .env.example .env               # add HACKCLUB_AI_API_KEY
uvicorn main:app --reload --port 8000
```

Open <http://127.0.0.1:8000/test-ui> for the temporary manual test page.

### Ideas API

```bash
cd gemini-ideas
cp .env.example .env               # add the same HACKCLUB_AI_API_KEY
node server.js
```

Open <http://localhost:3000>. Run `node check.mjs` to verify the key, model list and a
real ideas request.

### Primary GUI

```bash
bun install
bun run dev
```

The GUI calls its own TanStack server functions, which proxy to `IDEAS_API_URL` and
`IMAGE_API_URL`. Start both backends first; the defaults are
`http://127.0.0.1:3000` and `http://127.0.0.1:8000`.

## Hack Club AI configuration

Create an API key at <https://ai.hackclub.com/dashboard>. Keep it server-side and add it
to the env file for the service:

```bash
HACKCLUB_AI_API_KEY=...
```

Optional overrides:

```bash
HACKCLUB_AI_BASE_URL=https://ai.hackclub.com/proxy/v1
HACKCLUB_IMAGE_MODEL=google/gemini-nano-banana-2.1
HACKCLUB_IDEAS_MODEL=google/gemini-2.5-flash
```

The APIs use the OpenAI-compatible endpoint
`POST {HACKCLUB_AI_BASE_URL}/chat/completions` with a Bearer token. The image service
sends a base64 data URL as an `image_url` content part and asks for
`modalities: ["image", "text"]`; the result arrives as
`choices[0].message.images[0].image_url.url`.

`GET /api/health` reports the provider, the active model and whether the key is
configured; it never returns the key. A missing key returns `api_key_configured: false`
on the image API and `apiKeyConfigured: false` on the ideas API.

## Image endpoint contract

### `POST /api/edit`

`multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | file | yes | JPEG / PNG / WebP, max 20 MB |
| `change_request` | string | yes | What to change; blank returns 400 |
| `restrictions` | string | no | Hard limits, e.g. "no structural changes" |

**Success — `200`**

```json
{
  "ok": true,
  "image_base64": "...",
  "image_mime_type": "image/png",
  "message": "Here is the edited room photo.",
  "model": "google/gemini-nano-banana-2.1",
  "latency_ms": 12345
}
```

`message` is the model's short text when supplied, otherwise a fixed note. Images are
base64 so the response stays plain JSON.

**Failure — non-2xx**

```json
{ "ok": false, "error": { "code": "invalid_image", "message": "That file could not be read as an image. ..." } }
```

| Status | `code` | Cause |
|---|---|---|
| 400 | `missing_image` | No `image` part in the form |
| 400 | `empty_image` | Zero-byte upload |
| 400 | `empty_change_request` | Blank / whitespace-only request |
| 400 | `invalid_image` | Bytes could not be decoded as an image |
| 413 | `image_too_large` | Over 20 MB |
| 415 | `unsupported_image_type` | Not JPEG / PNG / WebP |
| 429 | `rate_limited` | Hack Club AI rate limit |
| 502 | `auth_failed` | API key rejected |
| 502 | `model_unavailable` | Model not available through Hack Club AI |
| 502 | `upstream_rejected` | Model rejected the input |
| 502 | `upstream_error` | Other upstream or network failure |
| 504 | `timeout` | Model exceeded the 180 s request timeout |
| 500 | `missing_api_key` | `HACKCLUB_AI_API_KEY` is not set |
| 500 | `server_error` | Catch-all; never leaks a traceback |

Call it from the app:

```js
const body = new FormData();
body.append("image", file);
body.append("change_request", changeText);
body.append("restrictions", restrictions);

const res = await fetch("http://127.0.0.1:8000/api/edit", { method: "POST", body });
const data = await res.json();
if (!data.ok) throw new Error(data.error.message);
resultImg.src = `data:${data.image_mime_type};base64,${data.image_base64}`;
```

CORS is controlled by `ALLOWED_ORIGINS` (default `*` for local use).

## Input handling

- Images are validated by decoding with Pillow, not by trusting the browser MIME string.
- EXIF rotation is applied, and transparent images are flattened onto white.
- The reference is re-encoded to JPEG and downscaled to a 1024 px long edge before the
  base64 upload.
- Hack Club AI's supported aspect ratios are fixed; Renovo selects the closest ratio to
  the original photo. The model may return dimensions from that ratio rather than the
  original dimensions.
- The API retries once on timeouts, 429s and upstream 5xxs, after a 1.5 s pause.

## TEMP TEST UI

`temp_test_ui/index.html` is a disposable harness served at `/test-ui`; it is not the
product UI. It supports a file preview, change and restriction fields, a spinner,
before/after panes, error codes, and "Use result as new input" for reprompting.

## Verification status

The provider implementation is verified locally: Python modules compile, Node modules
parse, the image response parser and request payload are exercised with mocked Hack Club
responses, the FastAPI health/validation endpoints pass, and the ideas parser is exercised
with a mocked chat completion.

Live checks with the Hack Club key from `gemini-ideas/.env` also passed: the ideas
diagnostic returned a valid plan, and a live image request returned `200` with a JPEG in
about 11 seconds. The image service reads the root `.env` (or its Render environment), so
its `/api/health` reports `api_key_configured: false` until `HACKCLUB_AI_API_KEY` is added
there. No Cloudflare credentials are required by the current code.

## Files

| File | Purpose |
|---|---|
| `hackclub_edit.py` | Hack Club AI request, prompt, validation/resizing, retry and image parsing |
| `main.py` | FastAPI app: `POST /api/edit`, `GET /api/health`, JSON errors, CORS, `/test-ui` |
| `gemini-ideas/lib/hackclub-ai.js` | Ideas prompt, JSON schema, Hack Club AI call and response normalization |
| `gemini-ideas/server.js` | Ideas HTTP server and temporary test UI |
| `src/lib/renovo.functions.ts` | GUI server functions that call both backends |
| `temp_test_ui/index.html` | Disposable manual image test harness |
| `test_photos/` | Sample interiors used for manual testing |
| `render.yaml` | Render Blueprint for the two backends and GUI |

## Test photo credits

| File | Source | Licence |
|---|---|---|
| `bedroom.jpg` | “Empty bedroom (4103505582)”, AnemoneProjectors, Wikimedia Commons | CC BY-SA 2.0 |
| `dim_bedroom.jpg` | “Bedroom @ night (3119861751)”, Matt @ PEK, Wikimedia Commons | CC BY-SA 2.0 |
| `kitchen.jpg` | “Apartment Kitchen with Sink and Oven”, Kurt Kaiser, Wikimedia Commons | Public domain (CC0) |
| `messy_kitchen.jpg` | “White kitchen with cabinet doors opened”, Wikimedia Commons | CC BY-SA 3.0 |

Test-use only; these are not shipped with the app.

## Known limitations

- **No masking.** "Change only the blue sofa" is followed semantically, not geometrically.
- **Removal instructions are weaker than additive/material changes.**
- **Not pixel-exact.** The model re-renders the frame; unchanged objects can shift slightly.
- **Fixed output aspect ratios** can change the returned dimensions from the source photo.
- **Stateless.** To iterate, send the previous result back as `image` with a new request.
- **No auth or rate limiting** on the APIs themselves; put them behind a shared secret or
  the GUI proxy before exposing them publicly.
- **`ALLOWED_ORIGINS=*`** is for local development; tighten it for a public deployment.
