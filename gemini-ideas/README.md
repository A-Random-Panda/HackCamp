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
node server.js
```

Open <http://localhost:3000>. Port and model can be changed with `PORT` and `GEMINI_MODEL`.

Never commit `gemini-ideas/.env`; the repo's `.gitignore` already excludes it.

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
  "model": "gemini-2.5-flash"
}
```

`GET /api/health` reports the configured model and whether `GEMINI_API_KEY` is present.

## Files

- `server.js` - HTTP server, `POST /api/ideas`, `GET /api/health`, static `public/`
- `lib/gemini.js` - prompt, response schema, Gemini call, response normalisation
- `public/` - the temporary test UI

## Integrating later

The frontend is temporary. The reusable part is `generateIdeas(input)` in `lib/gemini.js`;
call it from the main app's route and drop `public/` and `server.js`.
