# AI Renovator — image edit endpoint

A single, self-contained backend feature for **AI Renovator**: the user uploads a photo of a
room, describes what they want changed, and gets back an edited photo of *the same room*.

Built to drop into a teammate's app with one HTTP call. No database, no accounts, no file
storage — images are processed entirely in memory.

**Model: Cloudflare Workers AI `@cf/black-forest-labs/flux-2-klein-4b` (FLUX.2 [klein] 4B).**

---

## Status: working, on the free tier

Live edits through `POST /api/edit` on three different interiors: **3.5 – 4.0 seconds each**,
no credits required (Workers AI free allocation). The bedroom and kitchen kept their layout,
camera angle and fittings; only the requested elements changed. Measured results are in
[Test results](#test-results) — including the one request type that underperforms.

Requires a Cloudflare account and an API token. Nothing else.

---

## Quick start

```bash
# 1. One-time setup (Python 3.14 is already installed; `py` finds it)
py -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt

# 2. Add credentials (BOTH are required)
cp .env.example .env      # then edit .env:
#   CLOUDFLARE_ACCOUNT_ID=...    dashboard -> Workers & Pages -> Account ID (right sidebar)
#   CLOUDFLARE_API_TOKEN=...     My Profile -> API Tokens -> Create Token,
#                                permission: Account > Workers AI > Read

# 3. Run
.venv/Scripts/python.exe main.py
# -> http://127.0.0.1:8000/test-ui   (temporary manual test page)
# -> http://127.0.0.1:8000/docs      (auto-generated API docs)
```

Values go on the same line as the key (`CLOUDFLARE_API_TOKEN=cfut_...`). A value on its own
line is ignored by the env loader. `.env` is gitignored and the token is read **server-side
only** — it is never sent to the browser.

`GET /api/health` reports whether both values are configured, never their contents.

---

## Endpoint contract

### `POST /api/edit`

`multipart/form-data`

| Field           | Type   | Required | Notes                                                        |
|-----------------|--------|----------|--------------------------------------------------------------|
| `image`         | file   | yes      | JPEG / PNG / WebP, max 20 MB. Any photo, including a previous result. |
| `change_request`| string | yes      | What to change, in natural language. Blank = 400.             |
| `restrictions`  | string | no       | Hard limits, e.g. "no structural changes".                    |

**Success — `200`**

```json
{
  "ok": true,
  "image_base64": "/9j/4AAQSkZJRgABAQ...",
  "image_mime_type": "image/jpeg",
  "message": "Edited with Cloudflare Workers AI (FLUX.2 klein 4B).",
  "model": "@cf/black-forest-labs/flux-2-klein-4b",
  "latency_ms": 3978
}
```

`message` is a fixed note, not model text — FLUX.2 returns only an image. An image comes back
as base64 so the response is plain JSON with no binary handling.

**Failure — non-2xx**

```json
{ "ok": false, "error": { "code": "invalid_image", "message": "That file could not be read as an image. ..." } }
```

`code` is stable and safe to branch on; `message` is safe to show a user.

| Status | `code` | Cause |
|--------|--------|-------|
| 400 | `missing_image` | No `image` part in the form |
| 400 | `empty_image` | Zero-byte upload |
| 400 | `empty_change_request` | Blank / whitespace-only request |
| 400 | `invalid_image` | Bytes could not be decoded as an image |
| 413 | `image_too_large` | Over 20 MB |
| 415 | `unsupported_image_type` | Not JPEG/PNG/WebP (e.g. GIF, HEIC, PDF) |
| 429 | `rate_limited` | Workers AI rate limit, or today's free allocation used up |
| 502 | `auth_failed` | Token rejected, or it lacks the Workers AI permission |
| 502 | `model_unavailable` | Model not available to this account |
| 502 | `upstream_rejected` | Model rejected the input (error 3030) |
| 502 | `upstream_error` | Other upstream/network failure |
| 504 | `timeout` | Model exceeded the 180 s request timeout |
| 500 | `missing_api_key` | `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` not both set |
| 500 | `server_error` | Catch-all; never leaks a traceback |

### `GET /api/health`

```json
{ "ok": true, "provider": "cloudflare-workers-ai",
  "model": "@cf/black-forest-labs/flux-2-klein-4b", "api_key_configured": true }
```

### Calling it from the app

```js
const body = new FormData();
body.append("image", file);                  // File from <input type="file">
body.append("change_request", changeText);   // required
body.append("restrictions", restrictions);   // optional, "" is fine

const res  = await fetch("http://127.0.0.1:8000/api/edit", { method: "POST", body });
const data = await res.json();

if (!data.ok) throw new Error(data.error.message);   // show .error.message to the user
resultImg.src = `data:${data.image_mime_type};base64,${data.image_base64}`;
```

Or from the shell:

```bash
curl -X POST http://127.0.0.1:8000/api/edit \
  -F "image=@bedroom.jpg" \
  -F "change_request=Restyle this bedroom with warm oak flooring and cream linen bedding" \
  -F "restrictions=No structural changes. Keep the window and radiator."
```

CORS is enabled (`ALLOWED_ORIGINS`, default `*`), so a frontend on another port can call it.

---

## Model used and why

| Model | Verdict |
|-------|---------|
| **`@cf/black-forest-labs/flux-2-klein-4b`** | **Chosen.** Distilled FLUX.2 that both generates and *edits*. Runs on the free Workers AI allocation, fixed 4 inference steps, ~3.5–4 s per edit. On the test interiors it held the cabinets, appliances, door, radiator and camera angle in place while applying the requested change. |
| `@cf/black-forest-labs/flux-2-dev` | Bigger sibling, same multipart contract. In testing it applied the change but **re-framed the room** — wider angle, invented a window. Better raw quality, worse preservation. Not the default. |
| `@cf/black-forest-labs/flux-2-klein-9b` | Returned `500 Internal server error` on this account during testing. Worth re-trying later; same API shape. |
| `@cf/runwayml/stable-diffusion-v1-5-img2img` | **Retired.** Cloudflare still serves docs for it, but calling it now returns `403 … This account is not allowed to access …` (error 5018). There is no `img2img` entry in the account's model catalog. |
| `@cf/runwayml/stable-diffusion-v1-5-inpainting` | Still callable, but needs a mask. Tested with a full-white mask: regenerates the whole frame, producing a completely different room. Useful only if something ever segments the region to change. |
| Google Gemini (`gemini-nano-banana-2.1`) | The previous provider. Better instruction following, but **zero free-tier image quota**: every image model returns `429, limit: 0 requests per day`. Fine if billing is enabled. |

**Swapping models** is contained: only `cloudflare_edit.py` knows about Cloudflare
(`_get_client()` for auth, `_request_once()` for the call). `main.py`, the endpoint contract,
the error codes and the test UI are provider-agnostic.

---

## Cloudflare's API contract — the four things that cost real debugging time

These are not obvious from the model page, and each one fails in a confusing way:

1. **The request must be `multipart/form-data`**, even for a prompt-only call. A JSON body
   returns `400 … required properties at '/' are 'multipart'`.
2. **The image part must be named `input_image_0`** (`_1` … `_3` for more references).
   Sending `input_image` or `image` returns `200 OK` and a perfectly plausible image that
   **ignores your photo** — it silently becomes a text-to-image render. This looks like a
   model quality problem, not an API error.
3. **Every reference image must be smaller than 512×512.** The app sends a 500 px long edge.
   Larger references are not reliably accepted.
4. **Steps are fixed at 4.** `steps` is not a parameter for this model.

Also note `403` is overloaded: it means "bad token" *and* "model retired / not allowed for
this account" (error code 5018). The handler distinguishes them by the error text, so a
retired model never gets reported as an auth problem.

---

## How the instruction is built

`build_prompt()` combines the change request with a fixed set of preservation rules and puts
the restrictions in their own labelled block:

- apply *only* the requested change;
- same camera position, angle, framing, perspective;
- architecture unchanged (walls, floor, ceiling, windows, doors, built-ins);
- same lighting, shadows, colour temperature;
- every unmentioned object keeps its position, size, colour, material;
- photograph, not a render; no text or watermarks;
- **explicit tie-break:** if the change request conflicts with a restriction, the restriction wins.

Two details measurably helped:

- **Opening with `Edit image 0, …`** — the reference is numbered, so the model edits it
  instead of treating the prompt as a new scene.
- **Naming "camera angle" and "perspective" explicitly**, rather than a vague "keep
  everything else". The vague version drifted; the explicit list did not.

Concrete material changes ("oak floor", "sage cabinet doors", "linen bedding") are followed
faithfully. Pure removal instructions ("clear the clutter") are the weak spot — see below.

---

## Reprompting

The endpoint is stateless. To iterate, send the **previous output back in as `image`** with a
new `change_request`. No session IDs, and the user can keep whichever version they liked best.
FLUX.2 itself is a single-shot editor, so each call is independent — which is exactly what the
stateless contract wants.

---

## Input handling (all automatic)

- **Validation** by decoding with Pillow, not by trusting the browser's MIME string.
- **EXIF rotation** honoured, so portrait phone photos don't arrive sideways.
- **Reference downscale** to a 500 px long edge (the API's <512 limit). A 5000×3000 upload
  becomes a 500×300 reference.
- **Output size** keeps the original aspect ratio at a 1024 px long edge, clamped to the
  model's 256–1920 range and rounded to a multiple of 8. The same 5000×3000 upload asks for
  a 1024×616 output.
- **Re-encode** to JPEG q92. Transparent PNGs are flattened onto white first rather than
  turning black.
- **Retry:** at most **one** retry, only for timeouts / 429 / 5xx, after a 1.5 s pause. No loops.
- **Timeout:** 180 s per attempt.

---

## TEMP TEST UI

`temp_test_ui/index.html` — a deliberately disposable harness, served at `/test-ui`. It is
**not** the product UI (a teammate owns that) and nothing depends on it; delete it freely.

- file picker with an inline preview of the original
- **two** text boxes: change request + restrictions
- Generate button with a spinner, an elapsed-seconds counter, and the button disabled while working
- original and result **side by side**, with pixel dimensions
- errors rendered on-screen with their `code` and `message`
- **"Use result as new input"**, which reloads the last result into the picker so you can
  reprompt from it — the full iteration loop in two clicks
- reported latency and model name after each run

Single static HTML file, vanilla JS, no build step, no framework to collide with the app.

---

## Test results

### Image quality / latency — measured on the live API

| Photo | Change request | Layout drift | Restrictions held | Latency |
|---|---|---|---|---|
| Bedroom (1920×1440) | oak flooring, cream linen bedding, large abstract print | **None.** Door, wall, skirting and radiator in identical positions; same camera angle | ✅ Door + radiator explicitly preserved | **3978 ms** |
| Kitchen (1920×2560) | herringbone oak floor, sage upper cabinet doors | **None.** Gas range, microwave, sink, faucet and worktop unmoved | ✅ Sink/stove/microwave/window stayed put | **3475 ms** |
| Messy kitchen (1920×1536) | "clear all the clutter, restyle tidy and calm" | **None** — layout preserved | ✅ Layout restriction held | **3459 ms** |

**Honest finding:** the third request **barely applied**. The layout was preserved, but the
open drawers, dishes and open fridge door stayed — a removal-style instruction is much weaker
than a material/style change. Concrete edits (floor, cabinets, bedding, art) work reliably;
"declutter this" does not. The README's limitation section reflects this rather than hiding it.

### Validation matrix — re-verified after the provider swap

| Scenario | Expected | Result |
|---|---|---|
| No image part | 400 `missing_image` | ✅ |
| Non-image bytes | 400 `invalid_image` | ✅ |
| Whitespace-only change request | 400 `empty_change_request` | ✅ |
| GIF upload | 415 `unsupported_image_type` | ✅ |
| 5000×3000 upload | reference 500×300, output 1024×616 | ✅ |
| RGBA PNG upload | flattened to RGB, output 1024×768 | ✅ |
| `/test-ui` | 200, HTML, labelled TEMP TEST UI | ✅ |
| `/api/health` | reports provider, model, `api_key_configured` | ✅ |
| Real model call | 200 with an edited JPEG | ✅ (three photos) |

### Cloudflare findings worth keeping

- `stable-diffusion-v1-5-img2img` is gone from the catalog; the old call now 403s with
  error 5018. Do not trust docs pages that still list it.
- The `input_image_0` naming trap silently degrades editing into text-to-image. Three
  different kitchens came back for the same input before the field name was fixed.
- The free tier does **not** need credits for this model — earlier attempts with
  `flux-1-kontext-pro` would have (third-party, billed through credits); klein-4b does not.

---

## Known limitations

- **Small reference image.** Workers AI caps references below 512×512, so the model works
  from a fairly low-resolution copy. Fine details (small text on a poster, a picture frame's
  contents) can't be preserved reliably.
- **Removal instructions are weak.** "Clear the clutter", "remove the rug" apply unreliably,
  because the model has to invent what is behind the object. Additive/material changes are
  much stronger.
- **Big perspective changes drift.** Asking to "show the whole room" or "change the
  viewpoint" breaks preservation by definition; `flux-2-dev` also drifts on smaller ones.
- **Not pixel-exact.** The model re-renders the frame; edges of unchanged objects can shift
  by a few pixels.
- **No masking.** "Change only the blue sofa" is honoured semantically, not geometrically.
- **Stateless by design.** The model sees only the image and text you send; "make that a
  bit darker" only works if you send the previous result back in.
- **One image in, one out.** Multi-reference editing (up to 4 images on this model) is not
  exposed by the endpoint — small to add later, out of scope for the MVP.
- **`ALLOWED_ORIGINS=*`** is wide open for local use. Tighten it before anything is public.
- **No auth or rate limiting** on the endpoint itself — it assumes the teammate's app is the
  only caller. Each call spends the account's Workers AI allocation.
- Out of scope by design: plan/steps, cost estimates, shop prices, chatbot, login, saved
  projects, deployment, and visual polish.

---

## Files

| File | Purpose |
|---|---|
| `cloudflare_edit.py` | Core: prompt, validation/resizing, Cloudflare multipart call, one retry, response parsing |
| `main.py` | FastAPI app: `POST /api/edit`, `GET /api/health`, JSON errors, CORS, `/test-ui` |
| `temp_test_ui/index.html` | **TEMP TEST UI** — disposable manual test harness |
| `test_photos/` | Sample interiors used for testing (see credits below) |
| `requirements.txt` | Pinned runtime dependencies |
| `.env.example` | Template for the two Cloudflare values (copy to `.env`) |
| `.gitignore` | Keeps `.env`, `.venv/`, `__pycache__/` and local test output out of git |

### Test photo credits

| File | Source | Licence |
|---|---|---|
| `bedroom.jpg` | “Empty bedroom (4103505582)”, AnemoneProjectors, Wikimedia Commons | CC BY-SA 2.0 |
| `dim_bedroom.jpg` | “Bedroom @ night (3119861751)”, Matt @ PEK, Wikimedia Commons | CC BY-SA 2.0 |
| `kitchen.jpg` | “Apartment Kitchen with Sink and Oven”, Kurt Kaiser, Wikimedia Commons | Public domain (CC0) |
| `messy_kitchen.jpg` | “White kitchen with cabinet doors opened”, Wikimedia Commons | CC BY-SA 3.0 |

Test-use only; these are not shipped with the app.
