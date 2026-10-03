import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Tabs, Spinner, ErrorBox, Field, Select, useToast, copyText } from './ui.jsx';
import { KeyValueEditor, tagsToRows, rowsToTags, orEmpty } from './S3Modals.jsx';
import { s3, objectUrl, previewKind, fmtBytes, fmtDate, copySource, uploadBlob, downloadObject, STORAGE_CLASSES } from '../lib/s3.js';

const PREVIEW_BYTES = 512 * 1024;
const EDIT_LIMIT = 2 * 1024 * 1024;

function Preview({ bucket, item, head, onSaved }) {
  const toast = useToast();
  const kind = previewKind(item.name, head?.ContentType);
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const size = head?.ContentLength ?? item.size ?? 0;
  const inlineUrl = objectUrl(bucket, item.key, { inline: true });

  useEffect(() => {
    if (kind !== 'text') return;
    setText(null);
    setError(null);
    const headers = size > PREVIEW_BYTES ? { Range: `bytes=0-${PREVIEW_BYTES - 1}` } : {};
    fetch(objectUrl(bucket, item.key), { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`);
        return r.text();
      })
      .then(setText)
      .catch((e) => setError(e.message));
  }, [bucket, item.key, kind, size]);

  const save = async () => {
    setBusy(true);
    try {
      await uploadBlob(bucket, item.key, new Blob([editing], { type: head?.ContentType || 'text/plain' })).promise;
      toast('Saved');
      setText(editing);
      setEditing(null);
      onSaved?.();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  if (!kind) return <div className="empty">No preview for this file type.<div className="mt"><button className="btn btn-sm" onClick={() => downloadObject(bucket, item.key)}>⬇ Download</button></div></div>;
  if (kind === 'image') return <div className="preview-media checker"><img src={inlineUrl} alt={item.name} /></div>;
  if (kind === 'video') return <video className="preview-media" src={inlineUrl} controls />;
  if (kind === 'audio') return <audio src={inlineUrl} controls style={{ width: '100%' }} />;
  if (kind === 'pdf') return (
    <div>
      <iframe className="preview-pdf" src={inlineUrl} title={item.name} />
      <a className="btn btn-sm mt" href={inlineUrl} target="_blank" rel="noreferrer">Open in new tab</a>
    </div>
  );
  if (error) return <ErrorBox error={error} />;
  if (text === null) return <Spinner />;
  if (editing !== null) {
    return (
      <div>
        <textarea className="mono preview-edit" spellCheck={false} value={editing} onChange={(e) => setEditing(e.target.value)} />
        <div className="row-gap mt">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save to S3'}</button>
          <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
          <span className="muted small">Saving replaces the object (custom metadata and tags are not kept).</span>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="row-gap mb">
        {size > PREVIEW_BYTES ? <span className="muted small">Showing first {fmtBytes(PREVIEW_BYTES)} of {fmtBytes(size)}</span> : <span className="muted small">{fmtBytes(size)}</span>}
        <span className="push-right" />
        <button className="btn btn-xs" onClick={() => copyText(text).then(() => toast('Copied'))}>Copy</button>
        {size <= EDIT_LIMIT && <button className="btn btn-xs" onClick={() => setEditing(text)}>✎ Edit</button>}
      </div>
      <pre className="code preview-text">{text}</pre>
    </div>
  );
}

const HEADER_FIELDS = [
  ['ContentType', 'Content-Type'],
  ['CacheControl', 'Cache-Control'],
  ['ContentDisposition', 'Content-Disposition'],
  ['ContentEncoding', 'Content-Encoding'],
  ['ContentLanguage', 'Content-Language'],
];

function Properties({ bucket, item, head, onChanged }) {
  const { conn } = useApp();
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const region = head?.$region;
  const httpUrl = conn?.kind === 'endpoint' ? null : `https://${bucket}.s3.${region || 'us-east-1'}.amazonaws.com/${item.key.split('/').map(encodeURIComponent).join('/')}`;

  const startEdit = () =>
    setEdit({
      ...Object.fromEntries(HEADER_FIELDS.map(([k]) => [k, head[k] || ''])),
      StorageClass: head.StorageClass || 'STANDARD',
      meta: Object.entries(head.Metadata || {}).map(([k, v]) => ({ k, v })),
    });

  // S3 cannot edit metadata in place: copy the object onto itself with MetadataDirective=REPLACE.
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = {
        Bucket: bucket,
        Key: item.key,
        CopySource: copySource(bucket, item.key),
        MetadataDirective: 'REPLACE',
        StorageClass: edit.StorageClass,
        Metadata: Object.fromEntries(edit.meta.filter((r) => r.k.trim()).map((r) => [r.k.trim().toLowerCase(), r.v])),
      };
      for (const [k] of HEADER_FIELDS) if (edit[k]) input[k] = edit[k];
      if (head.ServerSideEncryption === 'aws:kms') {
        input.ServerSideEncryption = 'aws:kms';
        if (head.SSEKMSKeyId) input.SSEKMSKeyId = head.SSEKMSKeyId;
      }
      await s3('CopyObject', input);
      toast('Properties saved');
      setEdit(null);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (edit) {
    return (
      <div>
        <ErrorBox error={error} />
        {HEADER_FIELDS.map(([k, l]) => (
          <Field key={k} label={l}><input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>
        ))}
        <Field label="Storage class"><Select value={edit.StorageClass} onChange={(v) => setEdit({ ...edit, StorageClass: v })} options={STORAGE_CLASSES} /></Field>
        <h5>User metadata (x-amz-meta-*)</h5>
        <KeyValueEditor rows={edit.meta} onChange={(meta) => setEdit({ ...edit, meta })} keyLabel="Name" />
        <div className="row-gap mt">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
          <button className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      </div>
    );
  }
  const rows = [
    ['Key', item.key],
    ['S3 URI', <span className="row-gap"><code className="small">{`s3://${bucket}/${item.key}`}</code><button className="btn btn-xs" onClick={() => copyText(`s3://${bucket}/${item.key}`).then(() => toast('Copied'))}>Copy</button></span>],
    httpUrl && ['Object URL', <span className="row-gap"><code className="small">{httpUrl}</code><button className="btn btn-xs" onClick={() => copyText(httpUrl).then(() => toast('Copied'))}>Copy</button></span>],
    ['ARN', <code className="small">{`arn:aws:s3:::${bucket}/${item.key}`}</code>],
    ['Size', `${fmtBytes(head.ContentLength)} (${Number(head.ContentLength).toLocaleString()} bytes)`],
    ['Last modified', fmtDate(head.LastModified)],
    ['ETag', <code className="small">{head.ETag}</code>],
    ['Storage class', head.StorageClass || 'STANDARD'],
    head.VersionId && ['Version ID', <code className="small">{head.VersionId}</code>],
    ['Encryption', head.ServerSideEncryption ? `${head.ServerSideEncryption}${head.SSEKMSKeyId ? ` (${head.SSEKMSKeyId})` : ''}` : '—'],
    head.Restore && ['Restore', head.Restore],
    head.Expiration && ['Expiration', head.Expiration],
    ...HEADER_FIELDS.filter(([k]) => head[k]).map(([k, l]) => [l, head[k]]),
    ...Object.entries(head.Metadata || {}).map(([k, v]) => [`x-amz-meta-${k}`, v]),
  ].filter(Boolean);
  return (
    <div>
      <dl className="kv kv-narrow">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      <button className="btn btn-sm mt" onClick={startEdit}>✎ Edit metadata / storage class</button>
    </div>
  );
}

function Tags({ bucket, item }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    orEmpty(s3('GetObjectTagging', { Bucket: bucket, Key: item.key }), { TagSet: [] })
      .then((o) => setRows(tagsToRows(o.TagSet)))
      .catch((e) => setError(errorText(e)));
  }, [bucket, item.key]);
  if (!rows) return error ? <ErrorBox error={error} /> : <Spinner />;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const TagSet = rowsToTags(rows);
      if (TagSet.length) await s3('PutObjectTagging', { Bucket: bucket, Key: item.key, Tagging: { TagSet } });
      else await s3('DeleteObjectTagging', { Bucket: bucket, Key: item.key });
      toast('Tags saved');
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  return (
    <div>
      <ErrorBox error={error} />
      <KeyValueEditor rows={rows} onChange={setRows} max={10} />
      <button className="btn btn-primary btn-sm mt" onClick={save} disabled={busy}>Save tags</button>
    </div>
  );
}

function Versions({ bucket, item, onChanged }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
    try {
      const out = [];
      let KeyMarker;
      let VersionIdMarker;
      do {
        const r = await s3('ListObjectVersions', { Bucket: bucket, Prefix: item.key, KeyMarker, VersionIdMarker });
        out.push(...(r.Versions || []).map((v) => ({ ...v, marker: false })), ...(r.DeleteMarkers || []).map((v) => ({ ...v, marker: true })));
        KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
      } while (KeyMarker && out.length < 2000);
      setList(out.filter((v) => v.Key === item.key).sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified)));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    load();
  }, [bucket, item.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      await load();
      onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (!list) return error ? <ErrorBox error={error} /> : <Spinner />;
  if (list.length <= 1 && !list.some((v) => v.VersionId && v.VersionId !== 'null')) return <div className="empty">No other versions. Enable versioning in bucket properties to keep history.</div>;
  return (
    <table className="grid grid-plain">
      <thead><tr><th>Modified</th><th>Size</th><th>Version</th><th /></tr></thead>
      <tbody>
        {list.map((v) => (
          <tr key={v.VersionId}>
            <td>
              {fmtDate(v.LastModified)}
              {v.IsLatest && <span className="badge badge-ok">latest</span>}
              {v.marker && <span className="badge badge-warn">delete marker</span>}
            </td>
            <td>{v.marker ? '—' : fmtBytes(v.Size)}</td>
            <td><code className="small" title={v.VersionId}>{String(v.VersionId).slice(0, 10)}…</code></td>
            <td className="row-actions">
              {!v.marker && <button className="btn btn-xs" title="Download this version" onClick={() => downloadObject(bucket, item.key, v.VersionId)}>⬇</button>}
              {!v.marker && !v.IsLatest && (
                <button className="btn btn-xs" title="Make this version the latest" onClick={() => act(() => s3('CopyObject', { Bucket: bucket, Key: item.key, CopySource: copySource(bucket, item.key, v.VersionId) }), 'Version restored')}>Restore</button>
              )}
              <button
                className="btn btn-xs btn-danger"
                title="Permanently delete this version"
                onClick={() => window.confirm('Permanently delete this version? This cannot be undone.') && act(() => s3('DeleteObject', { Bucket: bucket, Key: item.key, VersionId: v.VersionId }), 'Version deleted')}
              >
                🗑
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function S3Details({ bucket, item, onClose, onChanged, actions }) {
  const [tab, setTab] = useState('preview');
  const [head, setHead] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setHead(null);
    setError(null);
    s3('HeadObject', { Bucket: bucket, Key: item.key })
      .then(setHead)
      .catch((e) => setError(errorText(e)));
  }, [bucket, item.key, tick]);
  const changed = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  return (
    <aside className="s3-details card">
      <div className="card-head">
        <h3 className="ellipsis" title={item.key}>{item.name}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <div className="row-gap wrap mb">{actions}</div>
      <Tabs small tabs={[['preview', 'Preview'], ['props', 'Properties'], ['tags', 'Tags'], ['versions', 'Versions']]} value={tab} onChange={setTab} />
      <ErrorBox error={error} />
      {!head && !error && <Spinner />}
      {head && tab === 'preview' && <Preview key={tick} bucket={bucket} item={item} head={head} onSaved={changed} />}
      {head && tab === 'props' && <Properties bucket={bucket} item={item} head={head} onChanged={changed} />}
      {tab === 'tags' && <Tags bucket={bucket} item={item} />}
      {tab === 'versions' && <Versions bucket={bucket} item={item} onChanged={changed} />}
    </aside>
  );
}
