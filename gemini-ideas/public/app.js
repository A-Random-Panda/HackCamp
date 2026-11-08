const form = document.querySelector('#renovation-form');
const submitButton = document.querySelector('#submit-button');
const serverNotice = document.querySelector('#server-notice');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const summaryEl = document.querySelector('#summary');
const budgetEl = document.querySelector('#budget');
const toolsEl = document.querySelector('#tools');
const storesEl = document.querySelector('#stores');
const storesCard = document.querySelector('#stores-card');
const stepsEl = document.querySelector('#steps');
const tipsEl = document.querySelector('#tips');
const tipsCard = document.querySelector('#tips-card');

const CATEGORY_LABELS = {
  tool: 'Tool',
  material: 'Material',
  consumable: 'Consumable',
  safety: 'Safety',
  service: 'Service',
  permit: 'Permit',
};

function setStatus(message, kind = 'info') {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
  statusEl.hidden = !message;
}

function clearResults() {
  resultsEl.hidden = true;
  budgetEl.hidden = true;
  budgetEl.textContent = '';
  toolsEl.replaceChildren();
  storesEl.replaceChildren();
  storesCard.hidden = true;
  stepsEl.replaceChildren();
  tipsEl.replaceChildren();
  tipsCard.hidden = true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTools(tools) {
  for (const tool of tools) {
    const item = el('li', 'tool');

    const head = el('div', 'tool-head');
    head.append(el('strong', '', tool.name));
    head.append(el('span', `tag tag-${tool.category}`, CATEGORY_LABELS[tool.category] || tool.category));
    if (tool.estimatedPrice) head.append(el('span', 'tag tag-price', tool.estimatedPrice));
    item.append(head);

    if (tool.whyNeeded) item.append(el('p', 'why', tool.whyNeeded));
    if (tool.whereToBuy?.length) item.append(el('p', 'buy', `Buy at: ${tool.whereToBuy.join(', ')}`));
    if (tool.whoDoesIt && tool.whoDoesIt !== 'either') {
      item.append(el('span', `tag tag-${tool.whoDoesIt}`, tool.whoDoesIt === 'diy' ? 'DIY' : 'Hire a pro'));
    }

    toolsEl.append(item);
  }

  if (!tools.length) toolsEl.append(el('li', 'why', 'Hack Club AI listed no tools for this job.'));
}

function renderStores(stores) {
  for (const store of stores) {
    const item = el('li', 'store');

    const head = el('div', 'store-head');
    head.append(el('strong', '', store.name));
    if (store.type) head.append(el('span', 'tag', store.type));
    item.append(head);

    if (store.bestFor) item.append(el('p', 'why', `Best for: ${store.bestFor}`));
    storesEl.append(item);
  }

  storesCard.hidden = stores.length === 0;
}

function renderSteps(steps) {
  for (const step of steps) {
    const item = el('li', 'step');
    item.append(el('h3', '', `${step.order}. ${step.title}`));
    if (step.detail) item.append(el('p', '', step.detail));

    const meta = el('div', 'meta');
    if (step.estimatedTime) meta.append(el('span', 'tag tag-time', step.estimatedTime));
    if (step.needs?.length) meta.append(el('span', 'tag', `Needs: ${step.needs.join(', ')}`));
    if (meta.childElementCount) item.append(meta);

    stepsEl.append(item);
  }

  if (!steps.length) stepsEl.append(el('li', 'why', 'Hack Club AI listed no steps for this job.'));
}

function render(ideas) {
  summaryEl.textContent = ideas.summary;

  if (ideas.budget) {
    budgetEl.textContent = `Rough budget: ${ideas.budget}`;
    budgetEl.hidden = false;
  } else {
    budgetEl.hidden = true;
  }

  renderTools(ideas.toolsAndResources || []);
  renderStores(ideas.stores || []);
  renderSteps(ideas.steps || []);

  if (ideas.tips?.length) {
    for (const tip of ideas.tips) tipsEl.append(el('li', '', tip));
    tipsCard.hidden = false;
  }

  resultsEl.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const description = form.description.value.trim();
  if (description.length < 10) {
    setStatus('Please describe the renovation in a bit more detail.', 'error');
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = 'Thinking...';
  clearResults();
  setStatus('Asking Hack Club AI for tools, prices, shops and steps...');

  try {
    const response = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description,
        roomType: form.roomType.value,
        location: form.location.value.trim(),
        constraints: form.constraints.value.trim(),
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Request failed with status ${response.status}.`);
    }

    render(payload);
    setStatus('');
  } catch (error) {
    setStatus(error.message || 'Something went wrong.', 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = resultsEl.hidden
      ? 'Generate tools, prices & steps'
      : 'Regenerate tools, prices & steps';
  }
});

// Tell the user up front when this server has no key, instead of only failing on submit.
async function checkServerConfig() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();

    if (!health.apiKeyConfigured) {
      serverNotice.textContent =
        `This server is missing HACKCLUB_AI_API_KEY (model ${health.model}). Add it to gemini-ideas/.env ` +
        'and restart the server - the file must sit next to server.js, not in the repo root.';
      serverNotice.hidden = false;
    } else {
      serverNotice.hidden = true;
    }
  } catch {
    serverNotice.textContent = 'Could not reach the server API. Is server.js still running?';
    serverNotice.hidden = false;
  }
}

checkServerConfig();
