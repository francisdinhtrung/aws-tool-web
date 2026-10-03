import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '../api.js';
import { Spinner, ErrorBox, Empty, Field, JsonArea, Modal, useToast } from './ui.jsx';
import { readFileBase64 } from './LambdaModals.jsx';
import { lambda, codeFiles, deployCode, codeDownloadUrl, sortFiles, handlerFile, fmtBytes } from '../lib/lambda.js';

/** Deploys a new package (zip upload, S3 object or container image). */
function UploadModal({ name, cfg, onClose, onDone }) {
  const image = cfg.PackageType === 'Image';
  const [mode, setMode] = useState(image ? 'image' : 'zip');
  const [file, setFile] = useState(null);
  const [s3, setS3] = useState({ bucket: '', key: '', version: '' });
  const [imageUri, setImageUri] = useState('');
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setError(null);
    const input = { FunctionName: name, ...(publish ? { Publish: true } : {}), Architectures: cfg.Architectures };
    try {
      if (mode === 'zip') {
        if (!file) throw new Error('Choose a .zip file');
        if (file.size > 50 * 1024 * 1024) throw new Error('Direct uploads are limited to 50 MB; upload to S3 first');
        setBusy(true);
        input.ZipFile = await readFileBase64(file);
      } else if (mode === 's3') {
        if (!s3.bucket.trim() || !s3.key.trim()) throw new Error('Bucket and key are required');
        Object.assign(input, { S3Bucket: s3.bucket.trim(), S3Key: s3.key.trim(), ...(s3.version.trim() ? { S3ObjectVersion: s3.version.trim() } : {}) });
      } else {
        if (!imageUri.trim()) throw new Error('Image URI is required');
        input.ImageUri = imageUri.trim();
      }
      setBusy(true);
      await lambda('UpdateFunctionCode', input);
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Deploy new code"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Deploy'}</button></>}
    >
      <ErrorBox error={error} />
      {!image && (
        <div className="seg" role="radiogroup" aria-label="Source">
          <button className={mode === 'zip' ? 'active' : ''} onClick={() => setMode('zip')}>Upload .zip</button>
          <button className={mode === 's3' ? 'active' : ''} onClick={() => setMode('s3')}>From S3</button>
        </div>
      )}
      {mode === 'zip' && (
        <Field label="Deployment package" hint="Replaces all the code of the function.">
          <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files[0] || null)} aria-label="Zip file" />
        </Field>
      )}
      {mode === 's3' && (
        <div className="grid-3">
          <Field label="Bucket"><input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} aria-label="Bucket" /></Field>
          <Field label="Key"><input value={s3.key} onChange={(e) => setS3({ ...s3, key: e.target.value })} aria-label="Key" /></Field>
          <Field label="Version (optional)"><input value={s3.version} onChange={(e) => setS3({ ...s3, version: e.target.value })} aria-label="Object version" /></Field>
        </div>
      )}
      {mode === 'image' && (
        <Field label="Image URI"><input value={imageUri} onChange={(e) => setImageUri(e.target.value)} aria-label="Image URI" placeholder="123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v2" /></Field>
      )}
      <label className="check"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish a new version</label>
    </Modal>
  );
}

export default function CodeTab({ name, fn, cfg, refresh, qualifier, reloadVersions }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [edits, setEdits] = useState({}); // path -> text, or null = deleted
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const image = cfg.PackageType === 'Image';
  const readOnly = Boolean(qualifier);

  const load = useCallback(async () => {
    if (image) return;
    setLoading(true);
    setError(null);
    try {
      const out = await codeFiles(name, qualifier || undefined);
      setData(out);
      setEdits({});
      setOpen((o) => (o && out.files.some((f) => f.path === o) ? o : handlerFile(cfg.Handler, out.files)));
    } catch (e) {
      setError(errorText(e));
      setData(null);
    }
    setLoading(false);
  }, [name, qualifier, image, cfg.Handler]);

  useEffect(() => {
    load();
  }, [load]);

  const files = useMemo(() => {
    if (!data) return [];
    const list = data.files.map((f) => ({ ...f, deleted: edits[f.path] === null, changed: typeof edits[f.path] === 'string' && edits[f.path] !== f.content }));
    for (const [path, text] of Object.entries(edits)) if (text !== null && !data.files.some((f) => f.path === path)) list.push({ path, size: text.length, content: '', added: true, changed: true });
    return sortFiles(list);
  }, [data, edits]);

  const changes = Object.fromEntries(
    Object.entries(edits).filter(([p, t]) => {
      const orig = data?.files.find((f) => f.path === p);
      return t === null ? Boolean(orig) : !orig || orig.content !== t;
    }),
  );
  const dirty = Object.keys(changes).length;
  const current = files.find((f) => f.path === open);
  const text = current ? (typeof edits[open] === 'string' ? edits[open] : current.content) : '';
  const handler = data ? handlerFile(cfg.Handler, data.files) : null;

  const deploy = useCallback(async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deployCode({ FunctionName: name, changes, expectedSha256: data.codeSha256, ...(publish ? { Publish: true } : {}) });
      toast(publish ? 'Deployed and published a new version' : 'Deployed');
      await refresh();
      if (publish) reloadVersions();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }, [dirty, busy, name, changes, data, publish, toast, refresh, reloadVersions, load]);

  // Ctrl/Cmd+S deploys.
  useEffect(() => {
    const f = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty && !readOnly) {
        e.preventDefault();
        deploy();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [deploy, dirty, readOnly]);

  const newFile = () => {
    const p = window.prompt('New file path (e.g. lib/helpers.mjs)');
    if (!p) return;
    const path = p.trim().replace(/^\/+/, '');
    if (!path || path.split('/').includes('..') || path.endsWith('/')) return toast('Invalid path', 'error');
    if (files.some((f) => f.path === path && !f.deleted)) return toast('File already exists', 'error');
    setEdits((e) => ({ ...e, [path]: '' }));
    setOpen(path);
  };
  const renameFile = () => {
    if (!current || current.binary) return;
    const p = window.prompt('Rename to', current.path);
    const path = p?.trim().replace(/^\/+/, '');
    if (!path || path === current.path) return;
    if (path.split('/').includes('..')) return toast('Invalid path', 'error');
    setEdits((e) => {
      const n = { ...e, [path]: text };
      if (current.added) delete n[current.path];
      else n[current.path] = null;
      return n;
    });
    setOpen(path);
  };
  const removeFile = () => {
    if (!current) return;
    if (!window.confirm(`Delete ${current.path} from the package?`)) return;
    setEdits((e) => {
      const n = { ...e };
      if (current.added) delete n[current.path];
      else n[current.path] = null;
      return n;
    });
  };

  if (image) {
    return (
      <div className="card">
        <div className="card-head">
          <h3>Container image</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setUploading(true)}>Deploy new image</button>
        </div>
        <dl className="kv">
          <dt>Image URI</dt><dd><code>{fn.Code?.ImageUri || '—'}</code></dd>
          <dt>Resolved image</dt><dd><code>{fn.Code?.ResolvedImageUri || '—'}</code></dd>
          {cfg.ImageConfigResponse?.ImageConfig && (<><dt>Image config</dt><dd><code>{JSON.stringify(cfg.ImageConfigResponse.ImageConfig)}</code></dd></>)}
        </dl>
        {uploading && <UploadModal name={name} cfg={cfg} onClose={() => setUploading(false)} onDone={() => { setUploading(false); toast('Image update started'); refresh(); }} />}
      </div>
    );
  }

  return (
    <div className="card code-card">
      <div className="card-head">
        <h3>Code {qualifier && <span className="badge">{qualifier} (read only)</span>}</h3>
        <div className="row-gap wrap">
          {!readOnly && <button className="btn btn-sm" onClick={() => setUploading(true)}>⇪ Upload .zip / S3</button>}
          <a className="btn btn-sm" href={codeDownloadUrl(name, qualifier || undefined)} download>⇩ Download .zip</a>
          <button className="btn btn-sm" onClick={load} disabled={loading}>↻ Reload</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {loading && !data && <Spinner />}
      {data && (
        <>
          <div className="muted small code-meta">
            Package {fmtBytes(data.codeSize)} · {data.files.length} files · handler <code>{cfg.Handler}</code>
            {data.truncated && ' · some files are too large to edit here'}
            {cfg.Layers?.length > 0 && ` · ${cfg.Layers.length} layer(s) not shown`}
          </div>
          <div className="code-split">
            <div className="code-files" role="list" aria-label="Files">
              {!readOnly && (
                <div className="row-gap code-files-tools">
                  <button className="btn btn-xs" onClick={newFile} aria-label="New file">＋ File</button>
                  <button className="btn btn-xs" onClick={renameFile} disabled={!current || current.binary || current.deleted} aria-label="Rename file">Rename</button>
                  <button className="btn btn-xs" onClick={removeFile} disabled={!current || current.deleted} aria-label="Delete file">Delete</button>
                </div>
              )}
              {files.map((f) => (
                <button
                  key={f.path}
                  role="listitem"
                  className={`code-file${open === f.path ? ' active' : ''}${f.deleted ? ' deleted' : ''}`}
                  onClick={() => setOpen(f.path)}
                  title={`${f.path} · ${fmtBytes(f.size)}${f.binary ? ' · binary or too large' : ''}`}
                  style={{ paddingLeft: 8 + (f.path.split('/').length - 1) * 12 }}
                >
                  <span className="ellipsis">{f.path.split('/').length > 1 && <span className="muted">{f.path.split('/').slice(0, -1).join('/')}/</span>}{f.path.split('/').pop()}</span>
                  {f.path === handler && <span className="badge">handler</span>}
                  {f.changed && !f.deleted && <span className="code-dot" title="Modified">●</span>}
                </button>
              ))}
              {!files.length && <div className="muted small pad">Empty package.</div>}
            </div>
            <div className="code-editor">
              {!current && <Empty>Select a file.</Empty>}
              {current && current.deleted && <Empty>{current.path} will be deleted on deploy. <button className="btn btn-xs" onClick={() => setEdits((e) => { const n = { ...e }; delete n[current.path]; return n; })}>Undo</button></Empty>}
              {current && !current.deleted && current.binary && <Empty>{current.path} is binary or larger than 1 MB ({fmtBytes(current.size)}) and cannot be edited here.</Empty>}
              {current && !current.deleted && !current.binary && (
                <>
                  <div className="code-editor-head small muted"><span className="mono">{current.path}</span>{current.changed && <span className="text-warn"> · modified</span>}</div>
                  <JsonArea value={text} onChange={readOnly ? undefined : (t) => setEdits((e) => ({ ...e, [current.path]: t }))} readOnly={readOnly} rows={26} />
                </>
              )}
            </div>
          </div>
          {!readOnly && (
            <div className="row-gap wrap mt-s">
              <button className="btn btn-primary" onClick={deploy} disabled={!dirty || busy}>{busy ? <Spinner /> : `Deploy${dirty ? ` (${dirty} change${dirty === 1 ? '' : 's'})` : ''}`}</button>
              <button className="btn" onClick={() => setEdits({})} disabled={!dirty || busy}>Discard changes</button>
              <label className="check"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish a new version</label>
              <span className="muted small">Ctrl/⌘ + S to deploy. The package is rebuilt from the current code, so file permissions are kept.</span>
            </div>
          )}
        </>
      )}
      {uploading && <UploadModal name={name} cfg={cfg} onClose={() => setUploading(false)} onDone={() => { setUploading(false); toast('Code update started'); refresh().then(load); }} />}
    </div>
  );
}
