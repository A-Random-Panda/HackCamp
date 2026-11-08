// One-command self-check: node check.mjs
// Verifies the key is present, accepted by Google, that the model exists for
// this key, and that a real ideas request comes back. Never prints the key.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile } from './lib/env.js';
import { generateIdeas, GeminiError, MODEL_NAME } from './lib/gemini.js';

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
const apiKey = process.env.GEMINI_API_KEY;

console.log(`\nAI Renovator - Gemini ideas check (${MODEL_NAME})\n`);
info(`Working directory: ${dir}`);
info(`.env file: ${envFileLoaded ? 'found' : 'not found'}`);
info(`GEMINI_API_KEY source: ${envFileLoaded ? '.env and/or environment' : 'environment only'}`);

if (!apiKey) {
  fail(
    'GEMINI_API_KEY is not set.',
    `Create ${join(dir, '.env')} containing GEMINI_API_KEY=your-key and run this again.`,
  );
  console.log('\nStopping here because nothing else can be checked without a key.\n');
  process.exit(1);
}

pass(`GEMINI_API_KEY is set (${apiKey.length} characters, starts with ${apiKey.slice(0, 4)}...)`);

// Step 1: is the key accepted at all?
let models = [];
try {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      // keep raw text
    }
    fail(`Google rejected the key (HTTP ${response.status}).`, detail);
    console.log('');
    process.exit(1);
  }

  const data = await response.json();
  models = (data.models || []).map((model) => String(model.name || '').replace(/^models\//, ''));
  pass(`Google accepted the key (${models.length} models visible)`);
} catch (error) {
  fail('Could not reach the Gemini API.', error.message);
  console.log('');
  process.exit(1);
}

// Step 2: does this key have the model this app asks for?
if (models.includes(MODEL_NAME)) {
  pass(`Model ${MODEL_NAME} is available to this key`);
} else {
  const textModels = models.filter((name) => /flash|pro/.test(name) && !/image|tts|live|audio|video|embed/.test(name));
  fail(
    `Model ${MODEL_NAME} is not in this key's model list.`,
    textModels.length
      ? `Try one of: ${textModels.slice(0, 8).join(', ')} - set it with GEMINI_MODEL=<name> in .env`
      : 'No text models listed for this key; check the project in Google AI Studio.',
  );
}

// Step 3: a real generation through the app's own code path.
try {
  const ideas = await generateIdeas({
    description: 'Small bathroom, replace the old wall tiles and swap the vanity for a compact sink unit.',
    roomType: 'Bathroom',
    constraints: 'Renting, one weekend, no experience.',
  });

  pass('Gemini returned a response the app could parse');
  info(`Summary: ${ideas.summary || '(empty)'}`);
  info(`Tools/resources: ${ideas.toolsAndResources.length}`);
  info(`Steps: ${ideas.steps.length}`);
  if (ideas.steps[0]) info(`First step: ${ideas.steps[0].order}. ${ideas.steps[0].title}`);
  if (ideas.toolsAndResources[0]) info(`First tool: ${ideas.toolsAndResources[0].name}`);
} catch (error) {
  const message = error instanceof GeminiError ? error.message : String(error?.message || error);
  fail('The ideas request failed.', message);
}

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nEverything works - the app should generate ideas.\n');
process.exit(failures ? 1 : 0);
