// One-command self-check: node check.mjs
// Verifies the Cloudflare account ID and token are present, that Workers AI is
// reachable for that token, and that a real ideas request comes back.
// Never prints the token.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile } from './lib/env.js';
import { generateIdeas, CloudflareAIError, getModelCandidates, getModelName } from './lib/cloudflare-ai.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const API_BASE = 'https://api.cloudflare.com/client/v4';
let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message, hint) {
  failures += 1;
  console.log(`FAIL  ${message}`);
  if (hint) console.log(`      -> ${hint}`);
}

function info(message) {
  console.log(`      ${message}`);
}

const envFileLoaded = await loadEnvFile(dir);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

console.log(`\nAI Renovator - Cloudflare Workers AI check (${getModelName()})\n`);
info(`Working directory: ${dir}`);
info(`.env file: ${envFileLoaded ? 'found' : 'not found'}`);
info(`Credentials source: ${envFileLoaded ? '.env and/or environment' : 'environment only'}`);

if (!accountId) {
  fail(
    'CLOUDFLARE_ACCOUNT_ID is not set.',
    `Find it in the Cloudflare dashboard (Workers & Pages -> Account ID), add it to ${join(dir, '.env')} and run this again.`,
  );
}

if (!apiToken) {
  fail(
    'CLOUDFLARE_API_TOKEN is not set.',
    `Create an API token with Workers AI permission and add it to ${join(dir, '.env')}, then run this again.`,
  );
}

if (!accountId || !apiToken) {
  console.log('\nStopping here because nothing else can be checked without credentials.\n');
  process.exit(1);
}

pass(`CLOUDFLARE_ACCOUNT_ID is set (${accountId.length} characters)`);
pass(`CLOUDFLARE_API_TOKEN is set (${apiToken.length} characters, starts with ${apiToken.slice(0, 4)}...)`);

// Step 1: is the token active at all?
try {
  const response = await fetch(`${API_BASE}/user/tokens/verify`, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.success === false) {
    const detail = (data?.errors || []).map((entry) => entry.message).filter(Boolean).join('; ');
    fail(`Cloudflare rejected the token (HTTP ${response.status}).`, detail || 'No details returned.');
    console.log('');
    process.exit(1);
  }

  pass(`Cloudflare accepted the token (status: ${data?.result?.status || 'active'})`);
} catch (error) {
  fail('Could not reach the Cloudflare API.', error.message);
  console.log('');
  process.exit(1);
}

// Step 2: can this token actually reach Workers AI for this account?
try {
  const response = await fetch(`${API_BASE}/accounts/${accountId}/ai/models/search?per_page=1`, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.success === false) {
    const detail =
      (data?.errors || []).map((entry) => `${entry.code}: ${entry.message}`).join(' | ') || `HTTP ${response.status}`;
    fail(
      'Workers AI is not reachable for this account and token.',
      `${detail} - check the account ID and that the token includes Workers AI: Read.`,
    );
  } else {
    pass('Workers AI is reachable for this account');
  }
} catch (error) {
  fail('Could not query the Workers AI model catalog.', error.message);
}

// Step 3: a real generation through the app's own code path.
try {
  const ideas = await generateIdeas({
    description: 'Small bathroom, replace the old wall tiles and swap the vanity for a compact sink unit.',
    roomType: 'Bathroom',
    location: 'Manchester, UK',
    constraints: 'Renting, one weekend, no experience.',
  });

  pass(`Cloudflare AI returned a response the app could parse (answered by ${ideas.model})`);
  info(`Summary: ${ideas.summary || '(empty)'}`);
  info(`Rough budget: ${ideas.budget || '(empty)'}`);
  info(`Tools/resources: ${ideas.toolsAndResources.length}`);
  info(`Steps: ${ideas.steps.length}`);
  info(`Stores: ${ideas.stores.length}`);
  if (ideas.steps[0]) info(`First step: ${ideas.steps[0].order}. ${ideas.steps[0].title}`);
  if (ideas.toolsAndResources[0]) {
    const first = ideas.toolsAndResources[0];
    info(
      `First tool: ${first.name} | price: ${first.estimatedPrice || '(missing)'} | buy at: ${
        first.whereToBuy?.join(', ') || '(missing)'
      }`,
    );
  }
  if (ideas.stores[0]) info(`First store: ${ideas.stores[0].name} (${ideas.stores[0].type})`);

  const priced = ideas.toolsAndResources.filter((tool) => tool.estimatedPrice).length;
  if (!priced) fail('No tool/resource has a price.', 'Check estimatedPrice in the schema and prompt.');

  const withoutStore = ideas.toolsAndResources.filter((tool) => !tool.whereToBuy?.length);
  if (withoutStore.length) {
    fail(
      `${withoutStore.length} tool(s)/resource(s) have no whereToBuy store.`,
      `Check whereToBuy in the schema and prompt (missing: ${withoutStore.map((tool) => tool.name).join(', ')}).`,
    );
  }

  if (!ideas.stores.length) fail('No local stores were returned.', 'Check the stores field in the schema and prompt.');
  if (!ideas.budget) fail('No rough total budget was returned.', 'Check the budget field in the schema and prompt.');
} catch (error) {
  const message = error instanceof CloudflareAIError ? error.message : String(error?.message || error);
  fail('The ideas request failed.', message);
}

if (failures) {
  console.log(`\n${failures} check(s) failed.\n`);
} else {
  console.log('\nEverything works - the app should generate ideas with prices and stores.\n');
}

process.exit(failures ? 1 : 0);
