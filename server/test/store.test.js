import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempEnv } from './helpers.js';
import { readJson, writeJson, exists, newId, listModels, getModel, saveModel, deleteModel, dataDir } from '../src/store.js';

let env;
beforeEach(async () => {
  env = await tempEnv();
});
afterEach(() => env.cleanup());

describe('json store', () => {
  it('uses DATA_DIR, falling back to ./data', () => {
    expect(dataDir()).toBe(env.data);
    const saved = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    expect(dataDir()).toBe(path.resolve('data'));
    process.env.DATA_DIR = saved;
  });

  it('returns the fallback for missing files and round-trips data', async () => {
    expect(await readJson('x.json', [1])).toEqual([1]);
    expect(await exists('x.json')).toBe(false);
    await writeJson('nested/x.json', { a: 1 });
    expect(await readJson('nested/x.json')).toEqual({ a: 1 });
    expect(await exists('nested/x.json')).toBe(true);
    const files = await fs.readdir(path.join(env.data, 'nested'));
    expect(files).toEqual(['x.json']); // temp file renamed away
  });

  it('rethrows parse errors', async () => {
    await fs.mkdir(env.data, { recursive: true });
    await fs.writeFile(path.join(env.data, 'bad.json'), '{oops');
    await expect(readJson('bad.json', null)).rejects.toThrow(SyntaxError);
  });

  it('generates uuids', () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newId()).not.toBe(newId());
  });
});

describe('models', () => {
  it('lists models sorted by last modified, skipping corrupt and non-json files', async () => {
    expect(await listModels()).toEqual([]);
    await saveModel('a', { ModelName: 'A', ModelMetadata: { DateLastModified: '2026-01-01', Description: 'first' }, DataModel: [{}, {}] });
    await saveModel('b', { ModelName: 'B', ModelMetadata: { DateLastModified: '2026-05-01' } });
    await saveModel('c', {});
    await fs.writeFile(path.join(env.data, 'models', 'broken.json'), 'nope');
    await fs.writeFile(path.join(env.data, 'models', 'readme.txt'), 'x');
    const list = await listModels();
    expect(list.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(list[1]).toEqual({ id: 'a', name: 'A', description: 'first', tables: 2, updated: '2026-01-01' });
    expect(list[2]).toEqual({ id: 'c', name: 'c.json', description: '', tables: 0, updated: '' });
  });

  it('gets, saves and deletes a model', async () => {
    await saveModel('m-1', { ModelName: 'M' });
    expect(await getModel('m-1')).toEqual({ ModelName: 'M' });
    await deleteModel('m-1');
    await expect(getModel('m-1')).rejects.toMatchObject({ status: 404, name: 'ModelNotFound' });
    await deleteModel('m-1'); // deleting twice is fine
  });

  it.each(['../etc/passwd', 'a/b', 'a.json', ''])('rejects unsafe id %j', async (id) => {
    await expect(getModel(id)).rejects.toMatchObject({ status: 400, name: 'InvalidId' });
    await expect(saveModel(id, {})).rejects.toMatchObject({ status: 400 });
    await expect(deleteModel(id)).rejects.toMatchObject({ status: 400 });
  });
});
