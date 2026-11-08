const form = document.querySelector('#renovation-form');
const submitButton = document.querySelector('#submit-button');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const summaryEl = document.querySelector('#summary');
const toolsEl = document.querySelector('#tools');
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
  toolsEl.replaceChildren();
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
    item.append(head);

    if (tool.whyNeeded) item.append(el('p', 'why', tool.whyNeeded));
    if (tool.whoDoesIt && tool.whoDoesIt !== 'either') {
      item.append(el('span', `tag tag-${tool.whoDoesIt}`, tool.whoDoesIt === 'diy' ? 'DIY' : 'Hire a pro'));
    }

    toolsEl.append(item);
  }

  if (!tools.length) toolsEl.append(el('li', 'why', 'Gemini listed no tools for this job.'));
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

  if (!steps.length) stepsEl.append(el('li', 'why', 'Gemini listed no steps for this job.'));
}

function render(ideas) {
  summaryEl.textContent = ideas.summary;
  renderTools(ideas.toolsAndResources || []);
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
  setStatus('Asking Gemini for tools and steps...');

  try {
    const response = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description,
        roomType: form.roomType.value,
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
    submitButton.textContent = resultsEl.hidden ? 'Generate tools & steps' : 'Regenerate tools & steps';
  }
});
