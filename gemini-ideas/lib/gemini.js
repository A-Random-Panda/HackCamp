const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const RETRYABLE_STATUSES = new Set([404, 429, 500, 502, 503, 504]);

// Read env lazily: the server loads .env after this module is imported.
function primaryModel() {
  return process.env.GEMINI_MODEL || PRIMARY_MODEL;
}

export function getModelName() {
  return primaryModel();
}

export function getModelCandidates() {
  return [...new Set([primaryModel(), ...FALLBACK_MODELS])];
}

const SYSTEM_PROMPT = `You are a practical renovation planner.
You are given a description of a space the user wants to renovate.
Your job is limited to two things:
1. The tools and resources needed for the renovation.
2. The possible steps of the renovation, in a sensible order.

Rules:
- Base your answer on the user's description; do not invent a different room or a different scope.
- Keep scope realistic for a hands-on renovation, not a full rebuild.
- List only tools/resources that the described work actually needs. Group reusable things (e.g. "cordless drill") and consumables (e.g. "painter's tape") separately via the category field.
- Name the professional help or permits explicitly when the work legally or practically needs them.
- Steps must be ordered, start with preparation/protection and end with cleanup or finishing.
- Each step should say what "done" looks like in one or two sentences, and which tools it needs.
- estimatedTime is a rough human effort such as "half a day" or "2-3 hours"; if unsure use a range.
- Do not give price ranges, shop recommendations or shopping links; another part of the app handles pricing.
- Be concise and concrete. No filler, no marketing language.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  propertyOrdering: ['summary', 'toolsAndResources', 'steps', 'tips'],
  properties: {
    summary: {
      type: 'STRING',
      description: 'One or two sentences on what the renovation involves and its main risk.',
    },
    toolsAndResources: {
      type: 'ARRAY',
      description: 'Everything the user needs to have or hire before and during the work.',
      items: {
        type: 'OBJECT',
        propertyOrdering: ['name', 'category', 'whyNeeded', 'whoDoesIt'],
        properties: {
          name: { type: 'STRING' },
          category: {
            type: 'STRING',
            enum: ['tool', 'material', 'consumable', 'safety', 'service', 'permit'],
          },
          whyNeeded: { type: 'STRING' },
          whoDoesIt: {
            type: 'STRING',
            enum: ['diy', 'professional', 'either'],
            description: 'Whether the user can do this themselves or should hire someone.',
          },
        },
        required: ['name', 'category', 'whyNeeded'],
      },
    },
    steps: {
      type: 'ARRAY',
      description: 'Ordered renovation steps.',
      items: {
        type: 'OBJECT',
        propertyOrdering: ['order', 'title', 'detail', 'estimatedTime', 'needs'],
        properties: {
          order: { type: 'INTEGER' },
          title: { type: 'STRING' },
          detail: { type: 'STRING' },
          estimatedTime: { type: 'STRING' },
          needs: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Names of tools/resources from this answer that this step needs.',
          },
        },
        required: ['order', 'title', 'detail'],
      },
    },
    tips: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Up to three short practical warnings specific to this job.',
    },
  },
  required: ['summary', 'toolsAndResources', 'steps'],
};

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

function buildPrompt({ description, roomType, constraints }) {
  const lines = ['Space:', roomType ? roomType : 'not specified', '', 'Renovation description:', description];

  if (constraints) {
    lines.push('', 'Constraints from the user:', constraints);
  }

  lines.push(
    '',
    'Return the tools/resources needed and the ordered steps. Follow the response schema.',
  );

  return lines.join('\n');
}

function parseJson(text, model) {
  if (!text) {
    throw new GeminiError('Gemini returned an empty response.');
  }

  // The API is asked for JSON, but strip a stray code fence if the model adds one.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new GeminiError('Gemini returned a response that was not valid JSON.');
  }

  return normalizeIdeas(parsed, model);
}

function normalizeIdeas(raw, model) {
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';

  const toolsAndResources = Array.isArray(raw.toolsAndResources)
    ? raw.toolsAndResources
        .filter((item) => item && typeof item.name === 'string' && item.name.trim())
        .map((item) => ({
          name: item.name.trim(),
          category: typeof item.category === 'string' ? item.category.trim().toLowerCase() : 'tool',
          whyNeeded: typeof item.whyNeeded === 'string' ? item.whyNeeded.trim() : '',
          whoDoesIt: typeof item.whoDoesIt === 'string' ? item.whoDoesIt.trim().toLowerCase() : 'either',
        }))
    : [];

  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .filter((step) => step && typeof step.title === 'string' && step.title.trim())
        .map((step, index) => ({
          order: Number.isFinite(step.order) ? step.order : index + 1,
          title: step.title.trim(),
          detail: typeof step.detail === 'string' ? step.detail.trim() : '',
          estimatedTime: typeof step.estimatedTime === 'string' ? step.estimatedTime.trim() : '',
          needs: Array.isArray(step.needs)
            ? step.needs.filter((need) => typeof need === 'string' && need.trim()).map((need) => need.trim())
            : [],
        }))
        .sort((a, b) => a.order - b.order)
        .map((step, index) => ({ ...step, order: index + 1 }))
    : [];

  if (!summary && !toolsAndResources.length && !steps.length) {
    throw new GeminiError('Gemini returned no usable renovation ideas.');
  }

  const tips = Array.isArray(raw.tips)
    ? raw.tips.filter((tip) => typeof tip === 'string' && tip.trim()).map((tip) => tip.trim())
    : [];

  return { summary, toolsAndResources, steps, tips, model };
}

async function requestModel(model, input, apiKey) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'Gemini took too long to respond.' : 'Could not reach Gemini.';
    throw new GeminiError(reason);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      // keep the raw text
    }
    throw new GeminiError(
      `Gemini API error (${response.status}): ${detail || 'no details returned'}`,
      response.status,
    );
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];

  if (!candidate || candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
    throw new GeminiError('Gemini declined to answer this request.', 422);
  }

  const text = (candidate.content?.parts || [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');

  return parseJson(text, model);
}

export async function generateIdeas(input) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new GeminiError(
      'GEMINI_API_KEY is not set on this server. Add it to gemini-ideas/.env next to server.js and restart the server, then check /api/health.',
      500,
    );
  }

  const models = getModelCandidates();

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    try {
      return await requestModel(model, input, apiKey);
    } catch (error) {
      const nextModel = models[index + 1];
      const retryable = error instanceof GeminiError && RETRYABLE_STATUSES.has(error.status);

      if (!retryable || !nextModel) throw error;

      console.warn(`[gemini] ${model} unavailable (${error.message}); retrying with ${nextModel}`);
    }
  }

  // The loop always returns or throws.
  throw new GeminiError('Gemini could not answer with any configured model.');
}
