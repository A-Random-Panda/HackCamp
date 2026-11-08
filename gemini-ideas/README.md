# Ideas service (tools, prices, stores and steps)

This service owns one part of Renovo: asking an AI model for the **tools and resources**
a renovation needs with **rough prices**, **where to buy them locally**, and the
**possible steps**. It also ships a deliberately simple test frontend.

Generation runs on **[Hack Club AI](https://ai.hackclub.com)** using an
OpenAI-compatible chat-completions endpoint.

## Run it

```bash
cd gemini-ideas
cp .env.example .env          # then add HACKCLUB_AI_API_KEY
node server.js                # or: npm start
node check.mjs                # optional: verify the key, model and a real request
```

Open <http://localhost:3000>. Port and model can be changed with `PORT` and
`HACKCLUB_IDEAS_MODEL`.

### Hack Club AI credentials

1. Create an API key at <https://ai.hackclub.com/dashboard>.
2. Add it to `gemini-ideas/.env`:

```bash
HACKCLUB_AI_API_KEY=...
```

Optional settings:

```bash
HACKCLUB_AI_BASE_URL=https://ai.hackclub.com/proxy/v1
HACKCLUB_IDEAS_MODEL=google/gemini-2.5-flash
```

The default model is `google/gemini-2.5-flash`; if it is unavailable, the service
retries once with `qwen/qwen3-32b`. The server calls
`POST {HACKCLUB_AI_BASE_URL}/chat/completions` with `Authorization: Bearer <key>` and
asks the model for a single JSON object. Never commit `gemini-ideas/.env`; it is
gitignored.

## Troubleshooting

`node check.mjs` reports:

1. whether `.env` was found and the key is set (it never prints the key),
2. whether the configured model IDs are in Hack Club AI's public model list,
3. a real `generateIdeas()` round trip and what came back.

Common causes:

- **"HACKCLUB_AI_API_KEY is not set"** — the `.env` file must sit next to `server.js`
  (`gemini-ideas/.env`), and the server must be restarted after editing it. The page
  shows a banner when the key is missing.
- **HTTP 401 / 403** — the key is wrong or revoked. Create a new one from the Hack Club
  AI dashboard.
- **HTTP 404 / model not listed** — set `HACKCLUB_IDEAS_MODEL` to an ID from
  `GET https://ai.hackclub.com/proxy/v1/models`.
- **Invalid JSON** — the model did not follow the schema. The service retries with the
  fallback model once. Re-run if it persists.

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
  "model": "google/gemini-2.5-flash"
}
```

Prices are rough strings from the model, not calculated totals. Store names are chains
that commonly serve that region, or store types when no specific shop is known; addresses
and stock are never invented.

`GET /api/health` reports the provider, the active model, fallback models and whether
`HACKCLUB_AI_API_KEY` is configured:

```json
{
  "ok": true,
  "provider": "hackclub-ai",
  "model": "google/gemini-2.5-flash",
  "fallbackModels": ["qwen/qwen3-32b"],
  "apiKeyConfigured": true
}
```

## Files

- `server.js` — HTTP server, `POST /api/ideas`, `GET /api/health`, static `public/`
- `lib/hackclub-ai.js` — prompt, JSON schema, Hack Club AI call, response normalization
- `lib/env.js` — minimal `.env` loader (no dependency)
- `check.mjs` — diagnostic script (`node check.mjs`)
- `public/` — temporary test UI

## Integrating later

The reusable part is `generateIdeas(input)` in `lib/hackclub-ai.js`; call it from the main
app's route and drop `public/`, `server.js` and `check.mjs`.
