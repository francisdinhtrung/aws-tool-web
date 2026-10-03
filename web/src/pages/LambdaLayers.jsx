import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, Field, Modal, useToast, copyText } from '../components/ui.jsx';
import { readFileBase64 } from '../components/LambdaModals.jsx';
import { lambda, listAll, RUNTIMES, fmtBytes, fmtDate } from '../lib/lambda.js';

function PublishLayerModal({ initialName = '', onClose, onDone }) {
  const [f, setF] = useState({ name: initialName, description: '', runtimes: [], arch: [], license: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));

  const save = async () => {
    setError(null);
    if (!/^[a-zA-Z0-9-_]{1,64}$/.test(f.name)) return setError('Layer name: letters, digits, - and _ (up to 64)');
    if (!file) return setError('Choose a .zip file');
    if (file.size > 50 * 1024 * 1024) return setError('Direct uploads are limited to 50 MB');
    setBusy(true);
    try {
      const out = await lambda('PublishLayerVersion', {
        LayerName: f.name,
        Content: { ZipFile: await readFileBase64(file) },
        ...(f.description ? { Description: f.description } : {}),
        ...(f.runtimes.length ? { CompatibleRuntimes: f.runtimes } : {}),
        ...(f.arch.length ? { CompatibleArchitectures: f.arch } : {}),
        ...(f.license ? { LicenseInfo: f.license } : {}),
      });
      onDone(out);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Publish layer version" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Publish'}</button></>}>
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Layer name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={Boolean(initialName)} aria-label="Layer name" /></Field>
        <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Layer description" /></Field>
      </div>
      <Field label=".zip file" hint="Node.js: nodejs/node_modules/…, Python: python/…, binaries: bin/…">
        <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files[0] || null)} aria-label="Layer zip" />
      </Field>
      <div className="field">
        <span className="field-label">Compatible runtimes (optional)</span>
        <div className="row-gap wrap">{RUNTIMES.map(([r]) => <label key={r} className="check"><input type="checkbox" checked={f.runtimes.includes(r)} onChange={() => toggle('runtimes', r)} /> {r}</label>)}</div>
      </div>
      <div className="row-gap wrap">
        {['x86_64', 'arm64'].map((a) => <label key={a} className="check"><input type="checkbox" checked={f.arch.includes(a)} onChange={() => toggle('arch', a)} /> {a}</label>)}
      </div>
      <Field label="License (optional)"><input value={f.license} onChange={(e) => setF({ ...f, license: e.target.value })} aria-label="License" placeholder="MIT" /></Field>
    </Modal>
  );
}

export default function LambdaLayers() {
  const { conn, functions } = useApp();
  const toast = useToast();
  const [layers, setLayers] = useState(null);
  const [open, setOpen] = useState(null);
  const [versions, setVersions] = useState({});
  const [error, setError] = useState(null);
  const [publishing, setPublishing] = useState(null); // null | '' (new) | layer name

  const load = useCallback(async () => {
    setError(null);
    try {
      setLayers((await listAll('ListLayers', { MaxItems: 50 }, 'Layers')).sort((a, b) => a.LayerName.localeCompare(b.LayerName)));
    } catch (e) {
      setLayers([]);
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    if (conn) load();
  }, [conn, load]);

  const expand = async (name) => {
    setOpen(open === name ? null : name);
    if (versions[name]) return;
    try {
      const v = await listAll('ListLayerVersions', { LayerName: name, MaxItems: 50 }, 'LayerVersions');
      setVersions((m) => ({ ...m, [name]: v }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Functions using a layer (from the already loaded function list).
  const users = (layerArnBase) => (functions || []).filter((f) => (f.Layers || []).some((l) => l.Arn.startsWith(`${layerArnBase}:`)));

  if (!conn) return <div className="page"><Empty>Select a connection.</Empty></div>;
  return (
    <div className="page">
      <div className="page-head">
        <h2>▤ Layers {layers && <span className="muted count">({layers.length})</span>}</h2>
        <div className="push-right row-gap">
          <button className="btn" onClick={load}>↻ Refresh</button>
          <button className="btn btn-primary" onClick={() => setPublishing('')}>＋ Create layer</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {!layers && <Spinner />}
      {layers && !layers.length && !error && <Empty>No layers in this region.</Empty>}
      {layers?.length > 0 && (
        <div className="grid-wrap">
          <table className="grid lg-table">
            <thead><tr><th>Name</th><th>Latest version</th><th>Runtimes</th><th>Created</th><th>Used by</th><th /></tr></thead>
            <tbody>
              {layers.map((l) => {
                const v = l.LatestMatchingVersion || {};
                const used = users(l.LayerArn);
                return (
                  <React.Fragment key={l.LayerName}>
                    <tr>
                      <td><button className="link-btn" onClick={() => expand(l.LayerName)}>{open === l.LayerName ? '▾' : '▸'} {l.LayerName}</button></td>
                      <td>{v.Version}{v.Description && <span className="muted small"> – {v.Description}</span>}</td>
                      <td className="small">{(v.CompatibleRuntimes || []).join(', ') || '—'}</td>
                      <td className="small">{fmtDate(v.CreatedDate)}</td>
                      <td className="small">{used.length ? used.map((f) => <a key={f.FunctionName} href={`#/lambda/function/${encodeURIComponent(f.FunctionName)}`}>{f.FunctionName} </a>) : '—'}</td>
                      <td className="row-actions">
                        <button className="btn btn-xs" onClick={() => copyText(v.LayerVersionArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
                        <button className="btn btn-xs" onClick={() => setPublishing(l.LayerName)}>New version</button>
                      </td>
                    </tr>
                    {open === l.LayerName && (
                      <tr className="sub-row">
                        <td colSpan={6}>
                          {!versions[l.LayerName] ? <Spinner /> : (
                            <table className="grid grid-plain">
                              <thead><tr><th>Version</th><th>Description</th><th>Runtimes</th><th>Architectures</th><th>Created</th><th /></tr></thead>
                              <tbody>
                                {versions[l.LayerName].map((x) => (
                                  <tr key={x.Version}>
                                    <td>{x.Version}</td>
                                    <td className="small">{x.Description || '—'}</td>
                                    <td className="small">{(x.CompatibleRuntimes || []).join(', ') || '—'}</td>
                                    <td className="small">{(x.CompatibleArchitectures || []).join(', ') || '—'}</td>
                                    <td className="small">{fmtDate(x.CreatedDate)}</td>
                                    <td><button className="btn btn-xs" onClick={() => copyText(x.LayerVersionArn).then(() => toast('ARN copied'))}>⧉ ARN</button></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {publishing !== null && (
        <PublishLayerModal
          initialName={publishing}
          onClose={() => setPublishing(null)}
          onDone={(out) => {
            toast(`Published ${out.LayerVersionArn?.split(':').slice(-2).join(':')} (${fmtBytes(out.Content?.CodeSize)})`);
            setPublishing(null);
            setVersions({});
            load();
          }}
        />
      )}
    </div>
  );
}
