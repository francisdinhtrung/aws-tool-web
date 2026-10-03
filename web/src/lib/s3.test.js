import { describe, it, expect, vi } from 'vitest';
import { mockBackend } from '../test/utils.jsx';
import { setConn } from '../api.js';
import {
  fmtBytes, baseName, parentPrefix, extOf, s3Path, parseS3Route, copySource, objectUrl, listPage, listAllKeys, expandSelection,
  deleteKeys, pool, previewKind, fileIcon, typeLabel, guessType, BUCKET_NAME_RE, filesFromDrop, downloadObject,
} from './s3.js';

describe('formatting and paths', () => {
  it('formats sizes', () => {
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('splits keys', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('a/b/')).toBe('b');
    expect(parentPrefix('a/b/')).toBe('a/');
    expect(parentPrefix('a/')).toBe('');
    expect(extOf('x.TAR.GZ')).toBe('gz');
    expect(extOf('Makefile')).toBe('');
  });

  it('round-trips bucket and prefix through the hash route', () => {
    expect(s3Path('')).toBe('/s3');
    const path = s3Path('my-bucket', 'a b/ảnh/');
    const arg = decodeURI(encodeURI(path)).split('/').filter(Boolean).slice(1).join('/');
    expect(parseS3Route(arg)).toEqual({ bucket: 'my-bucket', prefix: 'a b/ảnh/' });
    expect(parseS3Route('b')).toEqual({ bucket: 'b', prefix: '' });
    expect(parseS3Route('b/x')).toEqual({ bucket: 'b', prefix: 'x/' });
    expect(parseS3Route('')).toEqual({ bucket: '', prefix: '' });
  });

  it('encodes copy sources and object URLs', () => {
    expect(copySource('b', 'a b/c+d.txt')).toBe('b/a%20b/c%2Bd.txt');
    expect(copySource('b', 'k', 'v/1')).toBe('b/k?versionId=v%2F1');
    setConn({ kind: 'endpoint', id: 'e1' });
    const u = new URL(objectUrl('b', 'a b', { inline: true, versionId: 'v' }), 'http://x');
    expect(u.pathname).toBe('/api/s3/object');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ bucket: 'b', key: 'a b', inline: '1', versionId: 'v' });
    expect(JSON.parse(decodeURIComponent(u.searchParams.get('conn')))).toEqual({ kind: 'endpoint', id: 'e1' });
    setConn(null);
    expect(objectUrl('b', 'k')).toBe('/api/s3/object?bucket=b&key=k');
  });

  it('downloads through a temporary link', () => {
    downloadObject('b', 'dir/a.txt');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });

  it('classifies files', () => {
    expect(previewKind('a.png')).toBe('image');
    expect(previewKind('a.bin', 'video/mp4')).toBe('video');
    expect(previewKind('a.mp3')).toBe('audio');
    expect(previewKind('a.pdf')).toBe('pdf');
    expect(previewKind('a.json')).toBe('text');
    expect(previewKind('Dockerfile')).toBe('text');
    expect(previewKind('x.yml')).toBe('text');
    expect(previewKind('a.zip')).toBe(null);
    expect(fileIcon({ type: 'folder', name: 'x' })).toBe('📁');
    expect(fileIcon({ type: 'file', name: 'x.tgz' })).toBe('🗜');
    expect(fileIcon({ type: 'file', name: 'x.bin' })).toBe('📄');
    expect(typeLabel({ type: 'file', name: 'a.csv' })).toBe('CSV file');
    expect(typeLabel({ type: 'file', name: 'README' })).toBe('File');
    expect(guessType('a.svg')).toBe('image/svg+xml');
    expect(guessType('a.unknown')).toBe('application/octet-stream');
  });

  it('validates bucket names', () => {
    for (const n of ['abc', 'my-bucket.v2', 'a1b']) expect(BUCKET_NAME_RE.test(n)).toBe(true);
    for (const n of ['ab', 'Abc', '-abc', 'abc-', '192.168.1.1', 'xn--abc', 'a_b']) expect(BUCKET_NAME_RE.test(n)).toBe(false);
  });
});

describe('listing and batch helpers', () => {
  it('turns a delimited listing into folders and files, hiding the folder marker', async () => {
    const be = mockBackend({
      'POST /api/s3/op/ListObjectsV2': {
        CommonPrefixes: [{ Prefix: 'p/sub/' }],
        Contents: [{ Key: 'p/', Size: 0 }, { Key: 'p/a.txt', Size: 3, LastModified: '2026-01-01', StorageClass: 'STANDARD' }],
        IsTruncated: true,
        NextContinuationToken: 'n',
      },
    });
    const page = await listPage('b', 'p/', 't');
    expect(be.calls('POST /api/s3/op/ListObjectsV2')[0]).toEqual({ Bucket: 'b', Prefix: 'p/', Delimiter: '/', ContinuationToken: 't', MaxKeys: 1000 });
    expect(page.next).toBe('n');
    expect(page.items).toEqual([
      { type: 'folder', key: 'p/sub/', name: 'sub' },
      { type: 'file', key: 'p/a.txt', name: 'a.txt', size: 3, modified: '2026-01-01', storageClass: 'STANDARD', etag: undefined },
    ]);
  });

  it('lists recursively across pages and expands selections relative to a base', async () => {
    let n = 0;
    mockBackend({
      'POST /api/s3/op/ListObjectsV2': () =>
        ++n === 1 ? { Contents: [{ Key: 'p/f/1', Size: 1 }], IsTruncated: true, NextContinuationToken: 'x' } : { Contents: [{ Key: 'p/f/2', Size: 2 }] },
    });
    const progress = vi.fn();
    expect(await listAllKeys('b', 'p/f/', progress)).toEqual([{ key: 'p/f/1', size: 1 }, { key: 'p/f/2', size: 2 }]);
    expect(progress).toHaveBeenLastCalledWith(2);
    n = 1; // next listing returns a single page
    const out = await expandSelection('b', [{ type: 'folder', key: 'p/f/' }, { type: 'file', key: 'p/z.txt', size: 9 }], 'p/');
    expect(out).toEqual([{ key: 'p/f/2', size: 2, rel: 'f/2' }, { key: 'p/z.txt', size: 9, rel: 'z.txt' }]);
    await expect(listAllKeys('b', '', null, { aborted: true })).rejects.toThrow('Cancelled');
  });

  it('deletes keys in batches of 1000 and returns errors', async () => {
    const be = mockBackend({ 'POST /api/s3/op/DeleteObjects': (body) => ({ Errors: body.Delete.Objects.length < 1000 ? [{ Key: 'k', Code: 'AccessDenied' }] : [] }) });
    const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
    expect(await deleteKeys('b', keys)).toEqual([{ Key: 'k', Code: 'AccessDenied' }]);
    const calls = be.calls('POST /api/s3/op/DeleteObjects');
    expect(calls.map((c) => c.Delete.Objects.length)).toEqual([1000, 500]);
  });

  it('pool limits concurrency and honours abort', async () => {
    let active = 0;
    let peak = 0;
    const seen = [];
    await pool([1, 2, 3, 4, 5], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(x);
      active--;
    });
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    await expect(pool([1], 1, async () => {}, { aborted: true })).rejects.toThrow('Cancelled');
  });

  it('reads dropped files and nested folders', async () => {
    const file = (name) => ({ isFile: true, file: (ok) => ok(new File(['x'], name)) });
    const dir = (name, children) => {
      let done = false;
      return { isDirectory: true, name, createReader: () => ({ readEntries: (ok) => ok(done ? [] : ((done = true), children)) }) };
    };
    const dt = { items: [{ webkitGetAsEntry: () => file('a.txt') }, { webkitGetAsEntry: () => dir('d', [file('b.txt'), dir('e', [file('c.txt')])]) }] };
    expect((await filesFromDrop(dt)).map((f) => f.path)).toEqual(['a.txt', 'd/b.txt', 'd/e/c.txt']);
    expect((await filesFromDrop({ files: [new File(['x'], 'plain.txt')] })).map((f) => f.path)).toEqual(['plain.txt']);
  });
});
