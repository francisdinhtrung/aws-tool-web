import { api, getConn } from '../api.js';

export const s3 = (op, input = {}) => api(`/api/s3/op/${op}`, { method: 'POST', body: input });

export const fmtBytes = (b) => {
  if (b === undefined || b === null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let n = Number(b);
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

export const baseName = (key) => String(key).replace(/\/$/, '').split('/').pop();
export const parentPrefix = (prefix) => {
  const parts = prefix.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
};
export const extOf = (name) => {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};

// Route helpers: #/s3/<bucket>/<prefix>
export const s3Path = (bucket, prefix = '') => (bucket ? `/s3/${encodeURIComponent(bucket)}/${prefix.split('/').map(encodeURIComponent).join('/')}` : '/s3');
export function parseS3Route(arg) {
  const i = arg.indexOf('/');
  if (!arg) return { bucket: '', prefix: '' };
  if (i < 0) return { bucket: decodeURIComponent(arg), prefix: '' };
  const rest = arg.slice(i + 1).split('/').map(decodeURIComponent).join('/');
  return { bucket: decodeURIComponent(arg.slice(0, i)), prefix: rest && !rest.endsWith('/') ? `${rest}/` : rest };
}

// CopySource is "bucket/key" with the key URL-encoded per segment.
export const copySource = (bucket, key, versionId) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;

export function objectUrl(bucket, key, { inline = false, versionId } = {}) {
  const q = new URLSearchParams({ bucket, key });
  if (inline) q.set('inline', '1');
  if (versionId) q.set('versionId', versionId);
  const c = getConn();
  if (c) q.set('conn', encodeURIComponent(JSON.stringify(c)));
  return `/api/s3/object?${q}`;
}

export function downloadObject(bucket, key, versionId) {
  const a = document.createElement('a');
  a.href = objectUrl(bucket, key, { versionId });
  a.download = baseName(key);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// One page of a "folder" listing: common prefixes become folders.
export async function listPage(bucket, prefix, token, { delimiter = true, maxKeys = 1000 } = {}) {
  const out = await s3('ListObjectsV2', {
    Bucket: bucket,
    Prefix: prefix || undefined,
    Delimiter: delimiter ? '/' : undefined,
    ContinuationToken: token || undefined,
    MaxKeys: maxKeys,
  });
  const folders = (out.CommonPrefixes || []).map((p) => ({ type: 'folder', key: p.Prefix, name: baseName(p.Prefix) }));
  const files = (out.Contents || [])
    .filter((o) => o.Key !== prefix) // the "folder marker" object itself
    .map((o) => ({
      type: o.Key.endsWith('/') ? 'folder' : 'file',
      key: o.Key,
      name: baseName(o.Key),
      size: o.Size,
      modified: o.LastModified,
      storageClass: o.StorageClass,
      etag: o.ETag,
    }));
  return { items: [...folders, ...files], next: out.IsTruncated ? out.NextContinuationToken : null };
}

// Every object key under a prefix (recursive).
export async function listAllKeys(bucket, prefix, onProgress, signal) {
  const all = [];
  let token;
  do {
    if (signal?.aborted) throw new Error('Cancelled');
    const out = await s3('ListObjectsV2', { Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token });
    all.push(...(out.Contents || []).map((o) => ({ key: o.Key, size: o.Size })));
    token = out.IsTruncated ? out.NextContinuationToken : null;
    onProgress?.(all.length);
  } while (token);
  return all;
}

// Expand a selection (files + folders) into the objects it covers, with the path relative to `base`.
export async function expandSelection(bucket, items, base) {
  const out = [];
  for (const it of items) {
    if (it.type === 'folder') {
      for (const o of await listAllKeys(bucket, it.key)) out.push({ ...o, rel: o.key.slice(base.length) });
    } else out.push({ key: it.key, size: it.size, rel: it.key.slice(base.length) });
  }
  return out;
}

export async function deleteKeys(bucket, keys) {
  const errors = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await s3('DeleteObjects', { Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } });
    errors.push(...(out.Errors || []));
  }
  return errors;
}

export const deletePrefix = (bucket, prefix, { versions = false, confirm } = {}) =>
  api('/api/s3/delete-prefix', { method: 'POST', body: { bucket, prefix, versions, confirm } });

export const presign = (bucket, key, expires, versionId) => api('/api/s3/presign', { method: 'POST', body: { bucket, key, expires, versionId } });

// Runs fn over items with limited concurrency.
export async function pool(items, limit, fn, signal) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      if (signal?.aborted) throw new Error('Cancelled');
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Upload a Blob/File through the server with progress. Returns { promise, abort }. */
export function uploadBlob(bucket, key, blob, onProgress, conn = getConn()) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    const q = new URLSearchParams({ bucket, key });
    xhr.open('PUT', `/api/s3/object?${q}`);
    xhr.setRequestHeader('x-requested-with', 'dynamodb-studio');
    if (conn) xhr.setRequestHeader('x-conn', encodeURIComponent(JSON.stringify(conn)));
    xhr.setRequestHeader('x-object-content-type', blob.type || guessType(key));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { message: xhr.responseText };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(Object.assign(new Error(body?.message || `HTTP ${xhr.status}`), { name: body?.error || 'Error', status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Cancelled'));
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

const TYPES = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', parquet: 'application/vnd.apache.parquet',
};
export const guessType = (name) => TYPES[extOf(name)] || 'application/octet-stream';

const TEXT_EXT = new Set(['txt', 'log', 'md', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rb', 'rs', 'sh', 'sql', 'ini', 'conf', 'cfg', 'toml', 'env', 'properties', 'tf', 'gitignore', 'dockerfile']);

export function previewKind(name, contentType = '') {
  const ext = extOf(name);
  const t = contentType || guessType(name);
  if (/^image\//.test(t) && ext !== 'tiff') return 'image';
  if (/^video\//.test(t)) return 'video';
  if (/^audio\//.test(t)) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (/^text\//.test(t) || /json|xml|yaml|javascript/.test(t) || TEXT_EXT.has(ext) || name.toLowerCase() === 'dockerfile') return 'text';
  return null;
}

export function fileIcon(item) {
  if (item.type === 'folder') return '📁';
  const k = previewKind(item.name);
  if (k === 'image') return '🖼';
  if (k === 'video') return '🎞';
  if (k === 'audio') return '🎵';
  if (k === 'pdf') return '📕';
  if (['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2'].includes(extOf(item.name))) return '🗜';
  if (k === 'text') return '📝';
  return '📄';
}

export const typeLabel = (item) => (item.type === 'folder' ? 'Folder' : extOf(item.name) ? `${extOf(item.name).toUpperCase()} file` : 'File');

export const STORAGE_CLASSES = ['STANDARD', 'INTELLIGENT_TIERING', 'STANDARD_IA', 'ONEZONE_IA', 'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE', 'REDUCED_REDUNDANCY'];

export const BUCKET_NAME_RE = /^(?!xn--)(?!.*-s3alias$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Read a dropped DataTransfer (files and folders) into [{ file, path }].
export async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((file) => ({ file, path: file.name }));
  const out = [];
  const walk = async (entry, base) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: base + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${base}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
