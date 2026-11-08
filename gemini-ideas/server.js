import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIdeas, GeminiError, MODEL_NAME } from './lib/gemini.js';
import { loadEnvFile } from './lib/env.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
    if (size > limitBytes) throw new GeminiError('Request body is too large.', 413);
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GeminiError('Request body must be valid JSON.', 400);
  }
}

function validateInput(body) {
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (description.length < 10) {
    throw new GeminiError('Please describe the renovation in at least 10 characters.', 400);
  }

  if (description.length > 2000) {
    throw new GeminiError('Please keep the description under 2000 characters.', 400);
  }

  const roomType = typeof body.roomType === 'string' ? body.roomType.trim().slice(0, 60) : '';
  const constraints = typeof body.constraints === 'string' ? body.constraints.trim().slice(0, 500) : '';

  return { description, roomType, constraints };
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
      sendJson(res, 200, {
        ok: true,
        model: MODEL_NAME,
        apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof GeminiError) {
      if (error.status >= 500) console.error(`[gemini] ${error.status}: ${error.message}`);
      sendJson(res, error.status, { error: error.message });
      return;
    }

    console.error('[server] unexpected error:', error);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

await loadEnvFile(__dirname);

server.listen(PORT, HOST, () => {
  const keyState = process.env.GEMINI_API_KEY
    ? 'configured'
    : `MISSING - create ${join(__dirname, '.env')} with GEMINI_API_KEY=your-key, then restart`;
  console.log(`Renovation ideas test UI: http://localhost:${PORT}`);
  console.log(`Model: ${MODEL_NAME} | API key: ${keyState}`);
});
