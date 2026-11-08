const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

const PRIMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const FALLBACK_MODELS = ['@cf/meta/llama-3.1-8b-instruct-fast'];
const RETRYABLE_STATUSES = new Set([404, 429, 500, 502, 503, 504]);

// Read env lazily: the server loads .env after this module is imported.
function primaryModel() {
  return process.env.CLOUDFLARE_AI_MODEL || PRIMARY_MODEL;
}

export function getModelName() {
  return primaryModel();
}

export function getModelCandidates() {
  return [...new Set([primaryModel(), ...FALLBACK_MODELS])];
}

const SYSTEM_PROMPT = `You are a practical renovation planner.
You are given a description of a space the user wants to renovate and, optionally, their location.
Your job is limited to three things:
1. The tools and resources needed for the renovation, each with a rough price.
2. The possible steps of the renovation, in a sensible order.
3. Where to buy those tools and materials near the user's location.

Rules:
- Base your answer on the user's description; do not invent a different room or a different scope.
- Keep scope realistic for a hands-on renovation, not a full rebuild.
- List only tools/resources that the described work actually needs. Group reusable things (e.g. "cordless drill") and consumables (e.g. "painter's tape") separately via the category field.
- Name the professional help or permits explicitly when the work legally or practically needs them, and give their rough cost or callout fee.
- Every tool/resource needs a rough price range in the currency used where the user is located; use USD only when the location is unknown or ambiguous. Use rent pricing where renting is the normal choice. These are planning estimates, not quotes.
- Suggest stores that realistically serve that location: prefer chains that operate in that country or region and, where you do not know specific shops, describe the store type (e.g. "independent tile shop") instead of inventing names or addresses.
- Every tool/resource must list at least one store in whereToBuy, using names from the stores list or the same store type.
- Never invent exact prices, stock levels, addresses, phone numbers or links. Write "varies" or "check locally" when unsure.
- Steps must be ordered, start with preparation/protection and end with cleanup or finishing.
- Each step should say what "done" looks like in one or two sentences, and which tools it needs.
- estimatedTime is a rough human effort such as "half a day" or "2-3 hours"; if unsure use a range.
- Be concise and concrete. No filler, no marketing language.
- Reply with JSON that matches the response schema.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences on what the renovation involves and its main risk.',
    },
    budget: {
      type: 'string',
      description:
        'Rough total budget range for all listed tools, materials and services, in local currency, e.g. "EUR 300-550".',
    },
    toolsAndResources: {
      type: 'array',
      description: 'Everything the user needs to have or hire before and during the work.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: {
            type: 'string',
            enum: ['tool', 'material', 'consumable', 'safety', 'service', 'permit'],
          },
          whyNeeded: { type: 'string' },
          whoDoesIt: {
            type: 'string',
            enum: ['diy', 'professional', 'either'],
            description: 'Whether the user can do this themselves or should hire someone.',
          },
          estimatedPrice: {
            type: 'string',
            description:
              'Rough price or range in local currency, e.g. "EUR 20-35", "rent EUR 45/day", "callout EUR 80-120".',
          },
          whereToBuy: {
            type: 'array',
            items: { type: 'string' },
            description: 'At least one short store name from the stores list that sells or rents this item.',
          },
        },
        required: ['name', 'category', 'whyNeeded', 'estimatedPrice', 'whereToBuy'],
      },
    },
    stores: {
      type: 'array',
      description: 'Realistic places to buy or rent the tools and materials near the stated location.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Chain name, or a store type when no specific chain is known.',
          },
          type: {
            type: 'string',
            description: 'e.g. big-box hardware, tile specialist, tool rental, online.',
          },
          bestFor: {
            type: 'string',
            description: 'Which items from this plan to get there.',
          },
        },
        required: ['name', 'type', 'bestFor'],
      },
    },
    steps: {
      type: 'array',
      description: 'Ordered renovation steps.',
      items: {
        type: 'object',
        properties: {
          order: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
          estimatedTime: { type: 'string' },
          needs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of tools/resources from this answer that this step needs.',
          },
        },
        required: ['order', 'title', 'detail'],
      },
    },
    tips: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to three short practical warnings specific to this job.',
    },
  },
  required: ['summary', 'budget', 'toolsAndResources', 'stores', 'steps'],
};

export class CloudflareAIError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'CloudflareAIError';
    this.status = status;
  }
}

function buildPrompt({ description, roomType, constraints, location }) {
  const lines = ['Space:', roomType ? roomType : 'not specified', '', 'Renovation description:', description];

  if (location) {
    lines.push('', 'Location (for store suggestions and currency):', location);
  }

  if (constraints) {
    lines.push('', 'Constraints from the user:', constraints);
  }

  lines.push(
    '',
    'Return the tools/resources with rough prices, the ordered steps, a rough total budget and local stores. Follow the response schema.',
  );

  return lines.join('\n');
}

function parseJson(raw, model) {
  if (raw && typeof raw === 'object') {
    return normalizeIdeas(raw, model);
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    throw new CloudflareAIError('Cloudflare AI returned an empty response.');
  }

  // The API is asked for JSON, but strip a stray code fence if the model adds one.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new CloudflareAIError('Cloudflare AI returned a response that was not valid JSON.');
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
          estimatedPrice: typeof item.estimatedPrice === 'string' ? item.estimatedPrice.trim() : '',
          whereToBuy: Array.isArray(item.whereToBuy)
            ? item.whereToBuy.filter((store) => typeof store === 'string' && store.trim()).map((store) => store.trim())
            : [],
        }))
    : [];

  const budget = typeof raw.budget === 'string' ? raw.budget.trim() : '';

  const stores = Array.isArray(raw.stores)
    ? raw.stores
        .filter((store) => store && typeof store.name === 'string' && store.name.trim())
        .map((store) => ({
          name: store.name.trim(),
          type: typeof store.type === 'string' ? store.type.trim() : '',
          bestFor: typeof store.bestFor === 'string' ? store.bestFor.trim() : '',
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
    throw new CloudflareAIError('Cloudflare AI returned no usable renovation ideas.');
  }

  const tips = Array.isArray(raw.tips)
    ? raw.tips.filter((tip) => typeof tip === 'string' && tip.trim()).map((tip) => tip.trim())
    : [];

  return { summary, budget, toolsAndResources, stores, steps, tips, model };
}

async function requestModel(model, input, accountId, apiToken) {
  const url = `${API_BASE}/${accountId}/ai/run/${model}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(input) },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        max_tokens: 4096,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const reason =
      error?.name === 'TimeoutError' ? 'Cloudflare AI took too long to respond.' : 'Could not reach Cloudflare AI.';
    throw new CloudflareAIError(reason);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || data?.success === false) {
    const detail =
      (data?.errors || [])
        .map((entry) => entry?.message)
        .filter(Boolean)
        .join('; ') || `HTTP ${response.status}`;
    throw new CloudflareAIError(`Cloudflare AI error (${response.status}): ${detail}`, response.status);
  }

  const result = data?.result ?? data;
  const raw = result?.response ?? result;
  return parseJson(raw, model);
}

export async function generateIdeas(input) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId) {
    throw new CloudflareAIError(
      'CLOUDFLARE_ACCOUNT_ID is not set on this server. Add it to gemini-ideas/.env next to server.js and restart the server, then check /api/health.',
      500,
    );
  }

  if (!apiToken) {
    throw new CloudflareAIError(
      'CLOUDFLARE_API_TOKEN is not set on this server. Add it to gemini-ideas/.env next to server.js and restart the server, then check /api/health.',
      500,
    );
  }

  const models = getModelCandidates();

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    try {
      return await requestModel(model, input, accountId, apiToken);
    } catch (error) {
      const nextModel = models[index + 1];
      const retryable =
        error instanceof CloudflareAIError &&
        (RETRYABLE_STATUSES.has(error.status) || /JSON Mode/i.test(error.message));

      if (!retryable || !nextModel) throw error;

      console.warn(`[cloudflare-ai] ${model} unusable (${error.message}); retrying with ${nextModel}`);
    }
  }

  // The loop always returns or throws.
  throw new CloudflareAIError('Cloudflare AI could not answer with any configured model.');
}
