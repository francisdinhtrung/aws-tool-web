import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Modal, Field, Select, Spinner, ErrorBox, Tabs, JsonArea, useToast, copyText } from './ui.jsx';
import { REGIONS } from '../lib/dynamo.js';
import { s3, presign, deletePrefix, BUCKET_NAME_RE, baseName, parentPrefix } from '../lib/s3.js';

// S3 "not configured" errors mean "empty" for the property editors.
const EMPTY_ERRORS = new Set([
  'NoSuchBucketPolicy', 'NoSuchCORSConfiguration', 'NoSuchLifecycleConfiguration', 'NoSuchTagSet', 'NoSuchTagSetError',
  'ServerSideEncryptionConfigurationNotFoundError', 'NoSuchPublicAccessBlockConfiguration', 'NoSuchWebsiteConfiguration',
]);
export async function orEmpty(promise, empty = null) {
  try {
    return await promise;
  } catch (e) {
    if (EMPTY_ERRORS.has(e.name)) return empty;
    throw e;
  }
}

function FooterButtons({ onClose, onOk, busy, label = 'Save', danger, disabled }) {
  return (
    <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onOk} disabled={busy || disabled}>{busy ? <Spinner /> : label}</button>
    </>
  );
}

function useAction(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      setBusy(false);
      onDone?.(out);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// --- Buckets ----------------------------------------------------------------------
export function CreateBucketModal({ onClose, onCreated }) {
  const { conn } = useApp();
  const [name, setName] = useState('');
  const [region, setRegion] = useState(conn?.region || 'us-east-1');
  const [versioning, setVersioning] = useState(false);
  const { busy, error, run } = useAction(() => onCreated(name));
  const isEndpoint = conn?.kind === 'endpoint';
  const valid = BUCKET_NAME_RE.test(name) && !name.includes('..');
  const create = () =>
    run(async () => {
      const input = { Bucket: name };
      if (!isEndpoint && region !== 'us-east-1') input.CreateBucketConfiguration = { LocationConstraint: region };
      await s3('CreateBucket', input);
      if (versioning) await s3('PutBucketVersioning', { Bucket: name, VersioningConfiguration: { Status: 'Enabled' } });
    });
  return (
    <Modal title="Create bucket" onClose={onClose} footer={<FooterButtons onClose={onClose} onOk={create} busy={busy} label="Create" disabled={!valid} />}>
      <ErrorBox error={error} />
      <Field label="Bucket name" hint="3–63 chars: lowercase letters, numbers, dots and hyphens. Must be globally unique.">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && valid && create()} />
      </Field>
      {name && !valid && <div className="text-bad small mb">Invalid bucket name.</div>}
      {!isEndpoint && (
        <Field label="Region">
          <Select value={region} onChange={setRegion} options={[...new Set([region, ...REGIONS])]} />
        </Field>
      )}
      <label className="check"><input type="checkbox" checked={versioning} onChange={(e) => setVersioning(e.target.checked)} /> Enable versioning</label>
      <div className="muted small mt">New buckets block all public access and use SSE-S3 encryption by default.</div>
    </Modal>
  );
}

export function DeleteBucketModal({ bucket, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [empty, setEmpty] = useState(false);
  const [status, setStatus] = useState('');
  const { busy, error, run } = useAction(onDeleted);
  const del = () =>
    run(async () => {
      if (empty) {
        setStatus('Deleting all objects and versions…');
        const out = await deletePrefix(bucket, '', { versions: true, confirm: bucket });
        if (out.errors.length) throw new Error(`Could not delete ${out.errors.length} objects, e.g. ${out.errors[0].key}: ${out.errors[0].message}`);
      }
      setStatus('Deleting bucket…');
      await s3('DeleteBucket', { Bucket: bucket });
    });
  return (
    <Modal title={`Delete bucket ${bucket}`} onClose={onClose} footer={<FooterButtons onClose={onClose} onOk={del} busy={busy} danger label="Delete bucket" disabled={typed !== bucket} />}>
      <ErrorBox error={error} />
      <div className="alert alert-warn">This permanently deletes the bucket. It cannot be undone.</div>
      <label className="check mb"><input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> Empty the bucket first (delete every object and every version)</label>
      <Field label={`Type "${bucket}" to confirm`}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </Field>
      {busy && <div className="muted small"><Spinner /> {status}</div>}
    </Modal>
  );
}

// --- Key/value editor (tags, metadata) ----------------------------------------------
export function KeyValueEditor({ rows, onChange, keyLabel = 'Key', valueLabel = 'Value', max }) {
  const set = (i, p) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="kv-edit">
      {rows.length > 0 && (
        <div className="kv-edit-row attr-head"><span>{keyLabel}</span><span>{valueLabel}</span><span /></div>
      )}
      {rows.map((r, i) => (
        <div className="kv-edit-row" key={i}>
          <input value={r.k} onChange={(e) => set(i, { k: e.target.value })} aria-label={keyLabel} />
          <input value={r.v} onChange={(e) => set(i, { v: e.target.value })} aria-label={valueLabel} />
          <button className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">×</button>
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, { k: '', v: '' }])} disabled={max && rows.length >= max}>+ Add</button>
    </div>
  );
}
export const tagsToRows = (tags = []) => tags.map((t) => ({ k: t.Key, v: t.Value }));
export const rowsToTags = (rows) => rows.filter((r) => r.k.trim()).map((r) => ({ Key: r.k.trim(), Value: r.v }));

// --- Bucket properties ----------------------------------------------------------------
function JsonSetting({ load, save, remove, placeholder, help }) {
  const toast = useToast();
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    load()
      .then((v) => setText(v === null ? '' : JSON.stringify(v, null, 2)))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(msg);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  if (text === null) return error ? <ErrorBox error={error} /> : <Spinner />;
  return (
    <div>
      {help && <div className="muted small mb">{help}</div>}
      <ErrorBox error={error} />
      <JsonArea value={text} onChange={setText} rows={16} placeholder={placeholder} />
      <div className="row-gap mt">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() =>
            act(async () => {
              let v;
              try {
                v = JSON.parse(text);
              } catch (e) {
                throw new Error(`Invalid JSON: ${e.message}`);
              }
              await save(v);
            }, 'Saved')
          }
        >
          Save
        </button>
        {remove && <button className="btn btn-danger btn-sm" disabled={busy || !text.trim()} onClick={() => act(remove, 'Removed')}>Remove</button>}
        {busy && <Spinner />}
      </div>
    </div>
  );
}

function BucketGeneral({ bucket }) {
  const { conn } = useApp();
  const toast = useToast();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const [loc, ver, enc, pab] = await Promise.all([
        s3('GetBucketLocation', { Bucket: bucket }).catch(() => ({})),
        s3('GetBucketVersioning', { Bucket: bucket }).catch(() => ({})),
        orEmpty(s3('GetBucketEncryption', { Bucket: bucket })).catch(() => null),
        orEmpty(s3('GetPublicAccessBlock', { Bucket: bucket })).catch(() => null),
      ]);
      setD({ region: loc.LocationConstraint || 'us-east-1', versioning: ver.Status || 'Disabled', mfaDelete: ver.MFADelete, enc, pab: pab?.PublicAccessBlockConfiguration || {} });
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(msg);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  if (!d) return error ? <ErrorBox error={error} /> : <Spinner />;
  const rule = d.enc?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
  const PAB = [
    ['BlockPublicAcls', 'Block public ACLs'],
    ['IgnorePublicAcls', 'Ignore public ACLs'],
    ['BlockPublicPolicy', 'Block public bucket policies'],
    ['RestrictPublicBuckets', 'Restrict public buckets'],
  ];
  return (
    <div>
      <ErrorBox error={error} />
      <dl className="kv">
        <dt>Name</dt><dd>{bucket}</dd>
        <dt>Region</dt><dd>{conn?.kind === 'endpoint' ? 'n/a (custom endpoint)' : d.region}</dd>
        <dt>ARN</dt><dd><code className="small">arn:aws:s3:::{bucket}</code></dd>
        <dt>Encryption</dt><dd>{rule ? `${rule.SSEAlgorithm}${rule.KMSMasterKeyID ? ` (${rule.KMSMasterKeyID})` : ''}` : '—'}</dd>
        <dt>Versioning</dt>
        <dd className="row-gap">
          <span className={`badge ${d.versioning === 'Enabled' ? 'badge-ok' : d.versioning === 'Suspended' ? 'badge-warn' : ''}`}>{d.versioning}</span>
          {d.versioning === 'Enabled' ? (
            <button className="btn btn-xs" disabled={busy} onClick={() => act(() => s3('PutBucketVersioning', { Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } }), 'Versioning suspended')}>Suspend</button>
          ) : (
            <button className="btn btn-xs" disabled={busy} onClick={() => act(() => s3('PutBucketVersioning', { Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }), 'Versioning enabled')}>Enable</button>
          )}
        </dd>
      </dl>
      <h5>Block public access</h5>
      <div className="check-list">
        {PAB.map(([k, l]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={Boolean(d.pab[k])} onChange={(e) => setD({ ...d, pab: { ...d.pab, [k]: e.target.checked } })} /> {l}
          </label>
        ))}
      </div>
      <button className="btn btn-sm mt" disabled={busy} onClick={() => act(() => s3('PutPublicAccessBlock', { Bucket: bucket, PublicAccessBlockConfiguration: Object.fromEntries(PAB.map(([k]) => [k, Boolean(d.pab[k])])) }), 'Public access settings saved')}>
        Save public access settings
      </button>
    </div>
  );
}

function BucketTags({ bucket }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const { busy, error, run } = useAction(() => toast('Tags saved'));
  useEffect(() => {
    orEmpty(s3('GetBucketTagging', { Bucket: bucket }), { TagSet: [] })
      .then((o) => setRows(tagsToRows(o.TagSet)))
      .catch(() => setRows([]));
  }, [bucket]);
  if (!rows) return <Spinner />;
  const save = () =>
    run(() => {
      const TagSet = rowsToTags(rows);
      return TagSet.length ? s3('PutBucketTagging', { Bucket: bucket, Tagging: { TagSet } }) : s3('DeleteBucketTagging', { Bucket: bucket });
    });
  return (
    <div>
      <ErrorBox error={error} />
      <KeyValueEditor rows={rows} onChange={setRows} max={50} />
      <button className="btn btn-primary btn-sm mt" onClick={save} disabled={busy}>Save tags</button>
    </div>
  );
}

export function BucketPropsModal({ bucket, onClose }) {
  const [tab, setTab] = useState('general');
  return (
    <Modal title={`Bucket: ${bucket}`} onClose={onClose} size="lg">
      <Tabs tabs={[['general', 'General'], ['tags', 'Tags'], ['policy', 'Policy'], ['cors', 'CORS'], ['lifecycle', 'Lifecycle']]} value={tab} onChange={setTab} />
      {tab === 'general' && <BucketGeneral bucket={bucket} />}
      {tab === 'tags' && <BucketTags bucket={bucket} />}
      {tab === 'policy' && (
        <JsonSetting
          key="policy"
          help="Bucket policy document (IAM JSON)."
          placeholder={'{\n  "Version": "2012-10-17",\n  "Statement": []\n}'}
          load={() => orEmpty(s3('GetBucketPolicy', { Bucket: bucket })).then((o) => (o ? JSON.parse(o.Policy) : null))}
          save={(v) => s3('PutBucketPolicy', { Bucket: bucket, Policy: JSON.stringify(v) })}
          remove={() => s3('DeleteBucketPolicy', { Bucket: bucket })}
        />
      )}
      {tab === 'cors' && (
        <JsonSetting
          key="cors"
          help="Array of CORS rules (SDK format: AllowedOrigins, AllowedMethods, AllowedHeaders, ExposeHeaders, MaxAgeSeconds)."
          placeholder={'[\n  {\n    "AllowedOrigins": ["*"],\n    "AllowedMethods": ["GET"],\n    "AllowedHeaders": ["*"],\n    "MaxAgeSeconds": 3000\n  }\n]'}
          load={() => orEmpty(s3('GetBucketCors', { Bucket: bucket })).then((o) => (o ? o.CORSRules : null))}
          save={(v) => s3('PutBucketCors', { Bucket: bucket, CORSConfiguration: { CORSRules: v } })}
          remove={() => s3('DeleteBucketCors', { Bucket: bucket })}
        />
      )}
      {tab === 'lifecycle' && (
        <JsonSetting
          key="lifecycle"
          help="Array of lifecycle rules (SDK format: ID, Status, Filter, Transitions, Expiration, NoncurrentVersionExpiration…)."
          placeholder={'[\n  {\n    "ID": "expire-tmp",\n    "Status": "Enabled",\n    "Filter": { "Prefix": "tmp/" },\n    "Expiration": { "Days": 7 }\n  }\n]'}
          load={() => orEmpty(s3('GetBucketLifecycleConfiguration', { Bucket: bucket })).then((o) => (o ? o.Rules : null))}
          save={(v) => s3('PutBucketLifecycleConfiguration', { Bucket: bucket, LifecycleConfiguration: { Rules: v } })}
          remove={() => s3('DeleteBucketLifecycle', { Bucket: bucket })}
        />
      )}
    </Modal>
  );
}

// --- Objects --------------------------------------------------------------------------
export function NewFolderModal({ bucket, prefix, onClose, onCreated }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction(() => onCreated(name));
  const valid = name.trim() && !name.includes('/');
  const create = () => run(() => s3('PutObject', { Bucket: bucket, Key: `${prefix}${name.trim()}/`, Body: '' }));
  return (
    <Modal title="New folder" onClose={onClose} footer={<FooterButtons onClose={onClose} onOk={create} busy={busy} label="Create" disabled={!valid} />}>
      <ErrorBox error={error} />
      <Field label="Folder name" hint={`Created as s3://${bucket}/${prefix}${name || '…'}/`}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && create()} />
      </Field>
    </Modal>
  );
}

export function NewFileModal({ bucket, prefix, onClose, onCreate }) {
  const [name, setName] = useState('new-file.txt');
  const [text, setText] = useState('');
  const valid = name.trim() && !name.endsWith('/');
  return (
    <Modal
      title="New text file"
      size="lg"
      onClose={onClose}
      footer={<FooterButtons onClose={onClose} onOk={() => onCreate(`${prefix}${name.trim()}`, text)} label="Create" disabled={!valid} />}
    >
      <Field label="Name" hint={`s3://${bucket}/${prefix}${name}`}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <JsonArea value={text} onChange={setText} rows={16} />
    </Modal>
  );
}

// Copy / move a selection, or rename one item.
export function TransferModal({ mode, bucket, prefix, items, onClose, onSubmit }) {
  const { buckets } = useApp();
  const single = items.length === 1 ? items[0] : null;
  const [destBucket, setDestBucket] = useState(bucket);
  const [dest, setDest] = useState(mode === 'rename' ? single.name : prefix);
  const title = mode === 'rename' ? `Rename ${single.name}` : `${mode === 'move' ? 'Move' : 'Copy'} ${items.length === 1 ? single.name : `${items.length} items`}`;
  let problem = '';
  const unchanged = mode === 'rename' && dest === single.name;
  if (mode === 'rename') {
    if (!dest.trim() || dest.includes('/')) problem = 'Enter a name without "/".';
  } else {
    const p = dest && !dest.endsWith('/') ? `${dest}/` : dest;
    if (destBucket === bucket && items.some((i) => i.type === 'folder' && p.startsWith(i.key))) problem = 'Cannot copy a folder into itself.';
    else if (destBucket === bucket && p === prefix) problem = 'Source and destination are the same folder.';
  }
  const submit = () => {
    if (mode === 'rename') {
      const base = parentPrefix(single.key);
      return onSubmit({ destBucket: bucket, destPrefix: `${base}${dest.trim()}${single.type === 'folder' ? '/' : ''}`, rename: true });
    }
    onSubmit({ destBucket, destPrefix: dest && !dest.endsWith('/') ? `${dest}/` : dest });
  };
  return (
    <Modal title={title} onClose={onClose} footer={<FooterButtons onClose={onClose} onOk={submit} label={mode === 'rename' ? 'Rename' : mode === 'move' ? 'Move' : 'Copy'} disabled={Boolean(problem) || unchanged} />}>
      {mode === 'rename' ? (
        <Field label="New name">
          <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !problem && !unchanged && submit()} />
        </Field>
      ) : (
        <div className="grid-2">
          <Field label="Destination bucket">
            <Select value={destBucket} onChange={setDestBucket} options={[...new Set([bucket, ...(buckets || [])])]} />
          </Field>
          <Field label="Destination folder (prefix)" hint="Empty = bucket root">
            <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} placeholder="path/to/folder/" />
          </Field>
        </div>
      )}
      {problem && <div className="text-bad small">{problem}</div>}
      {items.some((i) => i.type === 'folder') && <div className="muted small mt">Folders are processed recursively. {mode !== 'copy' && 'S3 has no real rename: objects are copied, then the originals are deleted.'}</div>}
      <div className="muted small">Objects larger than 5 GB cannot be copied server-side.</div>
    </Modal>
  );
}

export function DeleteModal({ items, onClose, onConfirm }) {
  const folders = items.filter((i) => i.type === 'folder').length;
  return (
    <Modal title="Delete" onClose={onClose} footer={<FooterButtons onClose={onClose} onOk={onConfirm} danger label="Delete" />}>
      <p>
        Delete <strong>{items.length === 1 ? items[0].name : `${items.length} items`}</strong>
        {folders > 0 && ` (including everything inside ${folders === 1 ? 'the folder' : `${folders} folders`})`}?
      </p>
      <ul className="del-list small">
        {items.slice(0, 12).map((i) => <li key={i.key}>{i.type === 'folder' ? '📁' : '📄'} {i.key}</li>)}
        {items.length > 12 && <li className="muted">…and {items.length - 12} more</li>}
      </ul>
      <div className="muted small">In a versioned bucket this adds delete markers; old versions are kept.</div>
    </Modal>
  );
}

const EXPIRES = [[900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day'], [259200, '3 days'], [604800, '7 days (max)']];

export function ShareModal({ bucket, item, versionId, onClose }) {
  const { conn } = useApp();
  const toast = useToast();
  const [expires, setExpires] = useState(3600);
  const [url, setUrl] = useState('');
  const { busy, error, run } = useAction();
  const gen = () => run(async () => setUrl((await presign(bucket, item.key, expires, versionId)).url));
  const s3uri = `s3://${bucket}/${item.key}`;
  return (
    <Modal title={`Share ${baseName(item.key)}`} onClose={onClose} size="lg">
      <ErrorBox error={error} />
      <Field label="S3 URI">
        <div className="input-group"><input readOnly value={s3uri} /><button className="btn" onClick={() => copyText(s3uri).then(() => toast('Copied'))}>Copy</button></div>
      </Field>
      <h5>Pre-signed URL</h5>
      <div className="row-gap mb">
        <Select value={expires} onChange={(v) => setExpires(Number(v))} options={EXPIRES} aria-label="Expires in" />
        <button className="btn btn-primary" onClick={gen} disabled={busy}>{busy ? <Spinner /> : 'Generate'}</button>
      </div>
      {url && (
        <div className="input-group">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => copyText(url).then(() => toast('Copied'))}>Copy</button>
        </div>
      )}
      <div className="muted small mt">
        Anyone with the link can download the object until it expires. Links signed with temporary (SSO / assume-role) credentials stop working when those credentials expire.
        {conn?.kind === 'endpoint' && ' With a custom endpoint the URL uses the endpoint host, which must be reachable from where the link is opened.'}
      </div>
    </Modal>
  );
}
