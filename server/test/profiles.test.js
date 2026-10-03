import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempEnv } from './helpers.js';
import { listProfiles, saveProfile, deleteProfile, getProfileRegion, awsPaths, HttpError } from '../src/profiles.js';

const CONFIG = `# keep me
[default]
region = us-west-2

[profile dev.team]
region = eu-west-1
s3 =
  max_concurrent_requests = 10
output = json

[profile sso]
sso_session = corp
sso_account_id = 111
sso_role_name = Admin

[profile role]
role_arn = arn:aws:iam::1:role/r
source_profile = default

[profile proc]
credential_process = /bin/creds

[profile web]
web_identity_token_file = /tok

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
`;
const CREDS = `[default]
aws_access_key_id = AKIADEFAULT
aws_secret_access_key = secret-default

[only-creds]
aws_access_key_id = AKIAONLY
aws_secret_access_key = secret-only
aws_session_token = token-only
`;

let env;
beforeEach(async () => {
  env = await tempEnv({ config: CONFIG, credentials: CREDS });
});
afterEach(() => env.cleanup());

describe('awsPaths', () => {
  it('honours AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE overrides', () => {
    process.env.AWS_CONFIG_FILE = '/x/config';
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/x/creds';
    expect(awsPaths()).toMatchObject({ config: '/x/config', credentials: '/x/creds' });
    delete process.env.AWS_CONFIG_FILE;
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  });

  it('falls back to ~/.aws when AWS_DIR is unset', () => {
    const saved = process.env.AWS_DIR;
    delete process.env.AWS_DIR;
    expect(awsPaths().dir).toMatch(/\.aws$/);
    process.env.AWS_DIR = saved;
  });
});

describe('listProfiles', () => {
  it('merges config + credentials, detects types and masks secrets', async () => {
    const list = await listProfiles();
    expect(list.map((p) => p.name)).toEqual(['default', 'dev.team', 'only-creds', 'proc', 'role', 'sso', 'web']);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName.default).toMatchObject({
      region: 'us-west-2',
      type: 'static',
      settings: { region: 'us-west-2', aws_access_key_id: 'AKIADEFAULT', aws_secret_access_key: '' },
      secrets: ['aws_secret_access_key'],
    });
    expect(byName['only-creds'].secrets).toEqual(['aws_secret_access_key', 'aws_session_token']);
    expect(byName['only-creds'].settings.aws_session_token).toBe('');
    expect(byName.sso.type).toBe('sso');
    expect(byName.role.type).toBe('assume-role');
    expect(byName.proc.type).toBe('process');
    expect(byName.web.type).toBe('web-identity');
    expect(byName['dev.team'].type).toBe('other');
    expect(JSON.stringify(list)).not.toMatch(/secret-|token-only/);
  });

  it('returns [] when the files do not exist', async () => {
    await fs.rm(env.aws, { recursive: true });
    expect(await listProfiles()).toEqual([]);
  });

  it('rethrows unexpected read errors', async () => {
    process.env.AWS_CONFIG_FILE = env.aws; // a directory -> EISDIR
    await expect(listProfiles()).rejects.toThrow();
    delete process.env.AWS_CONFIG_FILE;
  });
});

describe('getProfileRegion', () => {
  it('returns the configured region or empty string', async () => {
    expect(await getProfileRegion('dev.team')).toBe('eu-west-1');
    expect(await getProfileRegion('only-creds')).toBe('');
    expect(await getProfileRegion('missing')).toBe('');
  });
});

describe('saveProfile', () => {
  it('creates a new profile split across both files and writes .bak backups', async () => {
    await saveProfile('new.one', { region: 'ap-southeast-1', aws_access_key_id: 'AKIANEW', aws_secret_access_key: 'sek', output: '' });
    const cfg = await env.read('config');
    const cred = await env.read('credentials');
    expect(cfg).toContain('[profile new.one]\nregion = ap-southeast-1\n');
    expect(cfg).not.toMatch(/\[profile new\.one\][^[]*output/);
    expect(cfg.startsWith('# keep me\n[default]')).toBe(true);
    expect(cred).toContain('[new.one]\naws_access_key_id = AKIANEW\naws_secret_access_key = sek\n');
    expect(await env.read('config.bak')).toBe(CONFIG);
    expect(await env.read('credentials.bak')).toBe(CREDS);
  });

  it('writes [default] (not [profile default]) in config', async () => {
    await saveProfile('default', { region: 'eu-central-1', aws_access_key_id: 'AKIADEFAULT', aws_secret_access_key: '' }, 'default');
    const cfg = await env.read('config');
    expect(cfg).toContain('[default]\nregion = eu-central-1');
    expect(cfg).not.toContain('[profile default]');
  });

  it('keeps existing secrets when they are sent empty', async () => {
    await saveProfile('default', { region: 'us-east-1', aws_access_key_id: 'AKIADEFAULT', aws_secret_access_key: '' }, 'default');
    expect(await env.read('credentials')).toContain('aws_secret_access_key = secret-default');
  });

  it('removes a secret when the key is omitted', async () => {
    await saveProfile('only-creds', { aws_access_key_id: 'AKIAONLY', aws_secret_access_key: '' }, 'only-creds');
    const cred = await env.read('credentials');
    expect(cred).toContain('secret-only');
    expect(cred).not.toContain('token-only');
  });

  it('renames a profile in both files while preserving comments and nested blocks', async () => {
    await saveProfile('dev2', { region: 'eu-west-1', s3: '', output: 'yaml' }, 'dev.team');
    const cfg = await env.read('config');
    expect(cfg.startsWith('# keep me\n')).toBe(true);
    expect(cfg).toContain('[profile dev2]\nregion = eu-west-1\ns3 =\n  max_concurrent_requests = 10\noutput = yaml\n');
    expect(cfg).not.toContain('dev.team');
    expect(cfg).toContain('[sso-session corp]');
  });

  it('renames credentials sections too', async () => {
    await saveProfile('renamed', { aws_access_key_id: 'AKIAONLY', aws_secret_access_key: '', aws_session_token: '' }, 'only-creds');
    const cred = await env.read('credentials');
    expect(cred).toContain('[renamed]\naws_access_key_id = AKIAONLY\naws_secret_access_key = secret-only\naws_session_token = token-only');
    expect(cred).not.toContain('[only-creds]');
  });

  it('removes the config section when all config keys are removed', async () => {
    await saveProfile('default', { aws_access_key_id: 'AKIADEFAULT', aws_secret_access_key: '' }, 'default');
    expect(await env.read('config')).not.toContain('[default]');
  });

  it('ignores blank keys and trims values', async () => {
    await saveProfile('p', { ' region ': ' us-east-2 ', '': 'x', retry_mode: undefined });
    expect(await env.read('config')).toContain('[profile p]\nregion = us-east-2\n');
  });

  it('creates files and directory when missing', async () => {
    await fs.rm(env.aws, { recursive: true });
    await saveProfile('fresh', { region: 'us-east-1', aws_access_key_id: 'A', aws_secret_access_key: 'B' });
    expect(await env.read('config')).toBe('[profile fresh]\nregion = us-east-1\n');
    expect(await env.read('credentials')).toBe('[fresh]\naws_access_key_id = A\naws_secret_access_key = B\n');
  });

  it.each([
    ['bad name', ['has space', {}], 400, 'InvalidName'],
    ['empty name', ['', {}], 400, 'InvalidName'],
    ['duplicate on create', ['default', {}], 409, 'ProfileExists'],
    ['duplicate on rename', ['default', {}, 'dev.team'], 409, 'ProfileExists'],
    ['missing original', ['zzz', {}, 'nope'], 404, 'ProfileNotFound'],
    ['bad key', ['p', { 'bad key': 'x' }], 400, 'InvalidKey'],
    ['newline injection', ['p', { region: 'x\n[evil]' }], 400, 'InvalidValue'],
  ])('rejects %s', async (_, args, status, name) => {
    const err = await saveProfile(...args).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status, name });
  });
});

describe('deleteProfile', () => {
  it('removes the profile from both files', async () => {
    await deleteProfile('default');
    expect(await env.read('config')).not.toMatch(/^\[default\]/m);
    expect(await env.read('credentials')).not.toMatch(/^\[default\]/m);
    expect(await env.read('credentials')).toContain('[only-creds]');
  });

  it('only rewrites the file that contained the profile', async () => {
    const before = await fs.stat(path.join(env.aws, 'config'));
    await deleteProfile('only-creds');
    const after = await fs.stat(path.join(env.aws, 'config'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(fs.access(path.join(env.aws, 'config.bak'))).rejects.toThrow();
  });

  it('throws 404 for unknown profiles', async () => {
    await expect(deleteProfile('nope')).rejects.toMatchObject({ status: 404, name: 'ProfileNotFound' });
  });
});
