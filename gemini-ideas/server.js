import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIdeas, CloudflareAIError, getModelCandidates, getModelName } from './lib/cloudflare-ai.js';
import { loadEnvFile } from './lib/env.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new CloudflareAIError('Request body is too large.', 413);
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CloudflareAIError('Request body must be valid JSON.', 400);
  }
}

function validateInput(body) {
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (description.length < 10) {
    throw new CloudflareAIError('Please describe the renovation in at least 10 characters.', 400);
  }

  if (description.length > 2000) {
    throw new CloudflareAIError('Please keep the description under 2000 characters.', 400);
  }

  const roomType = typeof body.roomType === 'string' ? body.roomType.trim().slice(0, 60) : '';
  const constraints = typeof body.constraints === 'string' ? body.constraints.trim().slice(0, 500) : '';
  const location = typeof body.location === 'string' ? body.location.trim().slice(0, 120) : '';

  return { description, roomType, constraints, location };
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, relative));

  // Refuse anything that escapes the public directory.
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': file.length,
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/ideas') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST for /api/ideas.' });
        return;
      }

      const input = validateInput(await readJsonBody(req));
      const ideas = await generateIdeas(input);
      sendJson(res, 200, ideas);
      return;
    }

    if (url.pathname === '/api/health') {
      const accountIdConfigured = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
      const tokenConfigured = Boolean(process.env.CLOUDFLARE_API_TOKEN);

      sendJson(res, 200, {
        ok: true,
        provider: 'cloudflare-workers-ai',
        model: getModelName(),
        fallbackModels: getModelCandidates().slice(1),
        apiKeyConfigured: accountIdConfigured && tokenConfigured,
        accountIdConfigured,
        tokenConfigured,
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof CloudflareAIError) {
      if (error.status >= 500) console.error(`[cloudflare-ai] ${error.status}: ${error.message}`);
      sendJson(res, error.status, { error: error.message });
      return;
    }

    console.error('[server] unexpected error:', error);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

await loadEnvFile(__dirname);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const hasAccount = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
  const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const missing = [!hasAccount && 'CLOUDFLARE_ACCOUNT_ID', !hasToken && 'CLOUDFLARE_API_TOKEN'].filter(Boolean);
  const keyState = missing.length
    ? `MISSING - set ${missing.join(' and ')} in ${join(__dirname, '.env')}, then restart`
    : 'configured';

  console.log(`Renovation ideas test UI: http://localhost:${PORT}`);
  console.log(
    `Provider: Cloudflare Workers AI | Model: ${getModelName()} (fallbacks: ${getModelCandidates()
      .slice(1)
      .join(', ')}) | Credentials: ${keyState}`,
  );
});
