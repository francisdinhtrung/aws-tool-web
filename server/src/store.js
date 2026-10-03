import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const dataDir = () => process.env.DATA_DIR || path.resolve('data');
const modelsDir = () => path.join(dataDir(), 'models');
const ID_RE = /^[a-zA-Z0-9-]+$/;

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir(), file), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function writeJson(file, data) {
  const full = path.join(dataDir(), file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, full);
}

export async function exists(file) {
  try {
    await fs.access(path.join(dataDir(), file));
    return true;
  } catch {
    return false;
  }
}

export const newId = () => crypto.randomUUID();

function checkId(id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error('Invalid id'), { status: 400, name: 'InvalidId' });
}

export async function listModels() {
  await fs.mkdir(modelsDir(), { recursive: true });
  const files = (await fs.readdir(modelsDir())).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(modelsDir(), f), 'utf8'));
      out.push({
        id: f.slice(0, -5),
        name: m.ModelName || f,
        description: m.ModelMetadata?.Description || '',
        tables: (m.DataModel || []).length,
        updated: m.ModelMetadata?.DateLastModified || '',
      });
    } catch {
      /* skip corrupt files */
    }
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export async function getModel(id) {
  checkId(id);
  const m = await readJson(`models/${id}.json`, null);
  if (!m) throw Object.assign(new Error('Model not found'), { status: 404, name: 'ModelNotFound' });
  return m;
}

export async function saveModel(id, model) {
  checkId(id);
  await writeJson(`models/${id}.json`, model);
}

export async function deleteModel(id) {
  checkId(id);
  await fs.rm(path.join(modelsDir(), `${id}.json`), { force: true });
}
