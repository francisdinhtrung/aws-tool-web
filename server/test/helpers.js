import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point AWS_DIR and DATA_DIR at fresh temp folders. Returns helpers for the files.
export async function tempEnv(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddbs-test-'));
  const aws = path.join(root, 'aws');
  const data = path.join(root, 'data');
  await fs.mkdir(aws, { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(aws, name), text);
  process.env.AWS_DIR = aws;
  process.env.DATA_DIR = data;
  delete process.env.AWS_CONFIG_FILE;
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  return {
    root,
    aws,
    data,
    read: (name) => fs.readFile(path.join(aws, name), 'utf8'),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
