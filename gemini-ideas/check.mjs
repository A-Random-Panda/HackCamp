// One-command self-check: node check.mjs
// Verifies HACKCLUB_AI_API_KEY is present, checks the configured model is in the
// public Hack Club AI model list, and runs a real ideas request. Never prints the key.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile } from './lib/env.js';
import {
  generateIdeas,
  HackClubAIError,
  getApiBase,
  getModelCandidates,
  getModelName,
} from './lib/hackclub-ai.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
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
const apiKey = process.env.HACKCLUB_AI_API_KEY;

console.log(`\nAI Renovator - Hack Club AI check (${getModelName()})\n`);
info(`Working directory: ${dir}`);
info(`.env file: ${envFileLoaded ? 'found' : 'not found'}`);
info(`Credentials source: ${envFileLoaded ? '.env and/or environment' : 'environment only'}`);

if (!apiKey) {
  fail(
    'HACKCLUB_AI_API_KEY is not set.',
    `Create a key at https://ai.hackclub.com/dashboard, add it to ${join(dir, '.env')} and run this again.`,
  );
  console.log('\nStopping here because nothing else can be checked without the API key.\n');
  process.exit(1);
}

pass(`HACKCLUB_AI_API_KEY is set (${apiKey.length} characters)`);

// Step 1: the model list is public, so verify the configured model IDs exist.
try {
  const response = await fetch(`${getApiBase()}/models`, { signal: AbortSignal.timeout(20_000) });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    fail(`Could not list Hack Club AI models (HTTP ${response.status}).`);
  } else {
    const available = new Set((data?.data || []).map((model) => model.id));
    const models = getModelCandidates();

    for (const model of models) {
      if (available.has(model)) {
        pass(`Model available: ${model}`);
      } else {
        fail(`Model not listed by Hack Club AI: ${model}`, 'Set HACKCLUB_IDEAS_MODEL to a model from /proxy/v1/models.');
      }
    }
  }
} catch (error) {
  fail('Could not reach the Hack Club AI model list.', error.message);
}

// Step 2: a real generation through the app's own code path.
try {
  const ideas = await generateIdeas({
    description: 'Small bathroom, replace the old wall tiles and swap the vanity for a compact sink unit.',
    roomType: 'Bathroom',
    location: 'Manchester, UK',
    constraints: 'Renting, one weekend, no experience.',
  });

  pass(`Hack Club AI returned a response the app could parse (answered by ${ideas.model})`);
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
  const message = error instanceof HackClubAIError ? error.message : String(error?.message || error);
  fail('The ideas request failed.', message);
}

if (failures) {
  console.log(`\n${failures} check(s) failed.\n`);
} else {
  console.log('\nEverything works - the app should generate ideas with prices and stores.\n');
}

process.exit(failures ? 1 : 0);
