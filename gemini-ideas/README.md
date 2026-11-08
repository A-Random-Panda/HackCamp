# Ideas service (tools, prices, stores and steps)

This service owns one part of Renovo: asking an AI model for the **tools and resources**
a renovation needs with **rough prices**, **where to buy them locally**, and the
**possible steps**. It also ships a deliberately simple test frontend.

Generation runs on the **[Google Gemini API](https://ai.google.dev)** using the native
`generateContent` endpoint, not an OpenAI-compatible proxy.

## Run it

```bash
cd gemini-ideas
cp .env.example .env          # then add GEMINI_API_KEY
node server.js                # or: npm start
node check.mjs                # optional: verify the key, models and a real request
```

Open <http://localhost:3000>. Port and model can be changed with `PORT` and
`GEMINI_TEXT_MODEL`.

### Gemini API credentials

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Add it to `gemini-ideas/.env`:

```bash
GEMINI_API_KEY=...
```

Optional settings:

```bash
GEMINI_TEXT_MODEL=gemini-3.8-flash
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

The default model is `gemini-3.8-flash`; if it is unavailable, the service retries once
with `gemini-3.5-flash-lite`. The server calls
`POST {GEMINI_API_BASE_URL}/models/{model}:generateContent` with the `x-goog-api-key`
header, sends the planner prompt as a system instruction, and requests a single JSON
object with `responseMimeType: "application/json"` and a `responseSchema`. Never commit
`gemini-ideas/.env`; it is gitignored.

## Troubleshooting

`node check.mjs` reports:

1. whether `.env` was found and the key is set (it never prints the key),
2. whether the configured model IDs are in Gemini's model list,
3. a real `generateIdeas()` round trip and what came back.

Common causes:

- **"GEMINI_API_KEY is not set"** — the `.env` file must sit next to `server.js`
  (`gemini-ideas/.env`), and the server must be restarted after editing it. The page
  shows a banner when the key is missing.
- **HTTP 401 / 403** — the key is wrong, revoked or lacks access. Create a new one in
  Google AI Studio.
- **HTTP 404 / model not listed** — set `GEMINI_TEXT_MODEL` to a model from
  `GET {GEMINI_API_BASE_URL}/models`.
- **Invalid JSON or an empty response** — the service retries with the fallback model
  once. Re-run if it persists.

## API

`POST /api/ideas`

```json
{
  "description": "Small 1990s bathroom, rip out tiles and vanity, walk-in shower",
  "roomType": "Bathroom",
  "location": "Manchester, UK",
  "constraints": "renting, one weekend, no experience"
}
```

`description` (10-2000 chars) is required; `roomType`, `location` and `constraints` are
optional. `location` picks the currency and store suggestions, so plans without it fall
back to USD and generic store types.

Response:

```json
{
  "summary": "string",
  "budget": "GBP 250-450 (rough)",
  "toolsAndResources": [
    {
      "name": "tile breaker",
      "category": "tool",
      "whyNeeded": "string",
      "whoDoesIt": "diy|professional|either",
      "estimatedPrice": "GBP 25-45 or rent GBP 15/day",
      "whereToBuy": ["Screwfix", "Toolstation"]
    }
  ],
  "stores": [
    { "name": "Screwfix", "type": "big-box hardware", "bestFor": "tiling tools and safety gear" }
  ],
  "steps": [
    {
      "order": 1,
      "title": "string",
      "detail": "string",
      "estimatedTime": "half a day",
      "needs": ["tile breaker"]
    }
  ],
  "tips": ["string"],
  "model": "gemini-3.8-flash"
}
```

Prices are rough strings from the model, not calculated totals. Store names are chains
that commonly serve that region, or store types when no specific shop is known; addresses
and stock are never invented.

`GET /api/health` reports the provider, the active model, fallback models and whether
`GEMINI_API_KEY` is configured:

```json
{
  "ok": true,
  "provider": "gemini",
  "model": "gemini-3.8-flash",
  "fallbackModels": ["gemini-3.5-flash-lite"],
  "apiKeyConfigured": true
}
```

## Files

- `server.js` — HTTP server, `POST /api/ideas`, `GET /api/health`, static `public/`
- `lib/gemini-ai.js` — prompt, JSON schema, Gemini API call, response normalization
- `lib/env.js` — minimal `.env` loader (no dependency)
- `check.mjs` — diagnostic script (`node check.mjs`)
- `public/` — temporary test UI

## Integrating later

The reusable part is `generateIdeas(input)` in `lib/gemini-ai.js`; call it from the main
app's route and drop `public/`, `server.js` and `check.mjs`.
