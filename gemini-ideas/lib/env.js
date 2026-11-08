import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Minimal .env loader so the app needs no dependencies.
// Values already present in the environment always win, so real env vars and
// project secrets override the file.
export async function loadEnvFile(dir) {
  let text;

  try {
    text = await readFile(join(dir, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }

  return true;
}
