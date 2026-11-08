# Gemini ideas branch (tools, resources and steps)

This branch owns one piece of AI Renovator: asking Gemini for the **tools and resources**
a renovation needs and the **possible steps** to do it. It also ships a deliberately simple
throwaway frontend so the endpoint can be tested on its own.

It is self-contained: dependency-free Node, plain HTML/CSS/JS, no build step. Nothing here
touches image generation, before/after comparison or price ranges.

## Run it

```bash
cd gemini-ideas
cp .env.example .env          # then put your GEMINI_API_KEY in .env
npm start                     # or: node server.js
npm run check                 # optional: verify key, model and a real request
```

Open <http://localhost:3000>. Port and model can be changed with `PORT` and `GEMINI_MODEL`.

Never commit `gemini-ideas/.env`; the repo's `.gitignore` already excludes it.

## Troubleshooting

`npm run check` is the fastest way to find the problem. It reports:

1. whether `.env` was found and `GEMINI_API_KEY` is set (it never prints the key),
2. whether Google accepts the key, and which models it can see,
3. whether the configured model is available to that key,
4. a real `generateIdeas()` round trip and what came back.

Common causes:

- **"GEMINI_API_KEY is not set on this server"** - the `.env` file must be next to
  `server.js` (`gemini-ideas/.env`), not in the repo root, and the server must be
  restarted after adding it. The page now shows a banner when the key is missing.
  Project secrets injected into the environment also work and take precedence.
- **`API key not valid`** - the key was copied incompletely or deleted; create a new one
  at <https://aistudio.google.com/apikey>.
- **`model ... is not found`** - that model is not available to your key. `npm run check`
  lists text models the key can see; set `GEMINI_MODEL=<name>` in `.env`.
- **A cloud preview still shows the missing-key banner** - the preview runs on the
  workspace machine, so the key must be set there too (as a project secret or in that
  machine's `gemini-ideas/.env`), not only on your laptop.

## API

`POST /api/ideas`

```json
{
  "description": "Small 1990s bathroom, rip out tiles and vanity, walk-in shower",
  "roomType": "Bathroom",
  "constraints": "renting, one weekend, no experience"
}
```

`description` (10-2000 chars) is required; `roomType` and `constraints` are optional.
Response:

```json
{
  "summary": "string",
  "toolsAndResources": [
    { "name": "tile breaker", "category": "tool", "whyNeeded": "string", "whoDoesIt": "diy|professional|either" }
  ],
  "steps": [
    { "order": 1, "title": "string", "detail": "string", "estimatedTime": "half a day", "needs": ["tile breaker"] }
  ],
  "tips": ["string"],
  "model": "gemini-3.8-flash"
}
```

`GET /api/health` reports the configured model and whether `GEMINI_API_KEY` is present.

## Files

- `server.js` - HTTP server, `POST /api/ideas`, `GET /api/health`, static `public/`
- `lib/gemini.js` - prompt, response schema, Gemini call, response normalisation
- `lib/env.js` - minimal `.env` loader (no dependency)
- `check.mjs` - diagnostic script (`npm run check`)
- `public/` - the temporary test UI

## Integrating later

The frontend is temporary. The reusable part is `generateIdeas(input)` in `lib/gemini.js`;
call it from the main app's route and drop `public/`, `server.js` and `check.mjs`.
