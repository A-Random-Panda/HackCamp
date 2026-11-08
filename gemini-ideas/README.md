# Ideas branch (tools, prices, stores and steps)

The folder and branch name are historical: generation now runs on **Cloudflare Workers AI**,
not Gemini.

This branch owns one piece of AI Renovator: asking an AI model for the **tools and resources**
a renovation needs with **rough prices**, **where to buy them locally**, and the **possible
steps** to do it. It also ships a deliberately simple throwaway frontend so the endpoint can be
tested on its own.

Prices and store suggestions are rough planning estimates, not quotes or live local stock; the
UI says so. It is self-contained: dependency-free Node, plain HTML/CSS/JS, no build step.
Nothing here touches image generation or before/after comparison.

## Run it

```bash
cd gemini-ideas
cp .env.example .env          # then add your Cloudflare account ID and token
npm start                     # or: node server.js
npm run check                 # optional: verify credentials and a real request
```

Open <http://localhost:3000>. Port and model can be changed with `PORT` and `CLOUDFLARE_AI_MODEL`.

### Cloudflare credentials

1. **Account ID** - Cloudflare dashboard -> Workers & Pages -> Account ID (right sidebar).
2. **API token** - <https://dash.cloudflare.com/profile/api-tokens> -> Create Token. Use the
   Workers AI template, or a custom token with **Workers AI: Read** for that account. Copy it
   once; Cloudflare will not show it again.

Both go in `gemini-ideas/.env`:

```bash
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

The server calls the Workers AI REST API at
`POST /accounts/{account_id}/ai/run/{model}` with `Authorization: Bearer <token>` and asks for
JSON Mode (`response_format` with a JSON Schema). Never commit `gemini-ideas/.env`; the repo's
`.gitignore` already excludes it.

## Troubleshooting

`npm run check` is the fastest way to find the problem. It reports:

1. whether `.env` was found and both credentials are set (it never prints the token),
2. whether Cloudflare accepts the token, and whether Workers AI is reachable for that account,
3. a real `generateIdeas()` round trip and what came back, including that prices, a budget and
   local stores are present.

Common causes:

- **"CLOUDFLARE_ACCOUNT_ID is not set"** - the `.env` file must sit next to `server.js`
  (`gemini-ideas/.env`), not in the repo root, and the server must be restarted after editing
  it. The page shows a banner when credentials are missing.
- **`Authentication error` / HTTP 403** - the token lacks Workers AI permission for that
  account, or the account ID belongs to a different account. Create a token from the Workers AI
  template and recheck the ID.
- **`model ... not found`** - that model is not available to your account. Set
  `CLOUDFLARE_AI_MODEL=@cf/...` in `.env`; the model catalog is at
  <https://developers.cloudflare.com/workers-ai/models/>.
- **`JSON Mode couldn't be met`** - the model could not satisfy the schema on that attempt.
  Re-run; the app also retries on the fallback model.
- **A cloud preview still shows the missing-credentials banner** - the preview runs on the
  workspace machine, so the credentials must be set there too, not only on your laptop.

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
optional. `location` picks the currency and the store suggestions, so plans without it fall
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
    { "order": 1, "title": "string", "detail": "string", "estimatedTime": "half a day", "needs": ["tile breaker"] }
  ],
  "tips": ["string"],
  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```

Prices are rough strings from the model in the local currency, not calculated totals. Store
names are chains that commonly serve that region, or store types when no specific shop is
known; addresses and stock are never invented.

`GET /api/health` reports the model, its fallbacks, and whether the account ID and token are
present.

The response's `model` field reports which model actually answered. If the primary model
(`CLOUDFLARE_AI_MODEL`, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) is unavailable
(404/429/5xx, timeout or a JSON Mode failure), the app retries with
`@cf/meta/llama-3.1-8b-instruct-fast`.

## Files

- `server.js` - HTTP server, `POST /api/ideas`, `GET /api/health`, static `public/`
- `lib/cloudflare-ai.js` - prompt, JSON Schema, Workers AI call, response normalisation
- `lib/env.js` - minimal `.env` loader (no dependency)
- `check.mjs` - diagnostic script (`npm run check`)
- `public/` - the temporary test UI

## Integrating later

The frontend is temporary. The reusable part is `generateIdeas(input)` in
`lib/cloudflare-ai.js`; call it from the main app's route and drop `public/`, `server.js` and
`check.mjs`.
