import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseIni, readEntries, writeEntries, serializeIni } from './ini.js';

// Resolved on every call so the environment can change at runtime (and in tests).
export function awsPaths() {
  const dir = process.env.AWS_DIR || path.join(os.homedir(), '.aws');
  return {
    dir,
    config: process.env.AWS_CONFIG_FILE || path.join(dir, 'config'),
    credentials: process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(dir, 'credentials'),
  };
}

const CRED_KEYS = new Set(['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token']);
const SECRET_KEYS = new Set(['aws_secret_access_key', 'aws_session_token']);
const NAME_RE = /^[A-Za-z0-9_.@+\-]+$/;
const KEY_RE = /^[A-Za-z0-9_.\-]+$/;

export class HttpError extends Error {
  constructor(status, name, message) {
    super(message);
    this.status = status;
    this.name = name;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

async function writeWithBackup(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {
    /* first write: nothing to back up */
  }
  await fs.writeFile(file, text, { mode: 0o600 });
}

const configSection = (p) => (p === 'default' ? 'default' : `profile ${p}`);
function profileOfConfigSection(name) {
  if (name === 'default') return 'default';
  const m = name.match(/^profile\s+(.+)$/);
  return m ? m[1].trim() : null;
}

function detectType(s) {
  if (s.aws_access_key_id) return 'static';
  if (s.sso_session || s.sso_start_url) return 'sso';
  if (s.role_arn) return 'assume-role';
  if (s.credential_process) return 'process';
  if (s.web_identity_token_file) return 'web-identity';
  return 'other';
}

async function load() {
  const { config, credentials } = awsPaths();
  const [cfgText, credText] = await Promise.all([readText(config), readText(credentials)]);
  return { cfg: parseIni(cfgText), cred: parseIni(credText) };
}

function collect({ cfg, cred }) {
  const map = new Map();
  const get = (n) => {
    if (!map.has(n)) map.set(n, { name: n, config: {}, credentials: {} });
    return map.get(n);
  };
  for (const s of cfg) {
    const p = s.name && profileOfConfigSection(s.name);
    if (p) get(p).config = readEntries(s);
  }
  for (const s of cred) if (s.name) get(s.name).credentials = readEntries(s);
  return map;
}

export async function listProfiles() {
  const map = collect(await load());
  return [...map.values()]
    .map((p) => {
      const all = { ...p.config, ...p.credentials };
      const settings = {};
      const secrets = [];
      for (const [k, v] of Object.entries(all)) {
        if (SECRET_KEYS.has(k)) {
          secrets.push(k);
          settings[k] = '';
        } else settings[k] = v;
      }
      return { name: p.name, region: all.region || '', type: detectType(all), settings, secrets };
    })
    .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}

export async function getProfileRegion(name) {
  const map = collect(await load());
  return map.get(name)?.config.region || '';
}

function upsert(sections, oldName, newName, values) {
  let sec = sections.find((s) => s.name === oldName);
  if (!Object.keys(values).length) {
    if (sec) sections.splice(sections.indexOf(sec), 1);
    return;
  }
  if (!sec) {
    sec = { name: newName, lines: [] };
    sections.push(sec);
  }
  sec.name = newName;
  writeEntries(sec, values);
}

export async function saveProfile(name, settings, originalName) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'InvalidName', 'Profile name may only contain letters, digits and _ . @ + -');
  const files = await load();
  const map = collect(files);
  const oldName = originalName || name;
  if ((!originalName || originalName !== name) && map.has(name)) {
    throw new HttpError(409, 'ProfileExists', `Profile "${name}" already exists`);
  }
  if (originalName && !map.has(originalName)) throw new HttpError(404, 'ProfileNotFound', `Profile "${originalName}" not found`);
  const old = map.get(oldName) || { config: {}, credentials: {} };
  const oldAll = { ...old.config, ...old.credentials };

  const cfgVals = {};
  const credVals = {};
  for (let [k, v] of Object.entries(settings || {})) {
    k = String(k).trim();
    v = String(v ?? '').trim();
    if (!k) continue;
    if (!KEY_RE.test(k)) throw new HttpError(400, 'InvalidKey', `Invalid setting name "${k}"`);
    if (/[\r\n]/.test(v)) throw new HttpError(400, 'InvalidValue', `Value of "${k}" must be a single line`);
    // Secrets are never sent to the browser; an empty value means "keep the existing one".
    if (SECRET_KEYS.has(k) && v === '') v = oldAll[k] ?? '';
    // Empty values are dropped, except parents of nested blocks ("s3 =" followed by indented lines).
    if (v === '' && oldAll[k] !== '') continue;
    (CRED_KEYS.has(k) ? credVals : cfgVals)[k] = v;
  }

  upsert(files.cfg, configSection(oldName), configSection(name), cfgVals);
  upsert(files.cred, oldName, name, credVals);
  await writeWithBackup(awsPaths().config, serializeIni(files.cfg));
  await writeWithBackup(awsPaths().credentials, serializeIni(files.cred));
}

export async function deleteProfile(name) {
  const files = await load();
  const cfgLen = files.cfg.length;
  const credLen = files.cred.length;
  files.cfg = files.cfg.filter((s) => s.name !== configSection(name));
  files.cred = files.cred.filter((s) => s.name !== name);
  if (files.cfg.length === cfgLen && files.cred.length === credLen) {
    throw new HttpError(404, 'ProfileNotFound', `Profile "${name}" not found`);
  }
  if (files.cfg.length !== cfgLen) await writeWithBackup(awsPaths().config, serializeIni(files.cfg));
  if (files.cred.length !== credLen) await writeWithBackup(awsPaths().credentials, serializeIni(files.cred));
}
