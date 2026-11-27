import React, { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { navigate, useApp } from '../context.js';
import { SecretEditor, ScheduleSecretDeletion } from '../components/SecretModals.jsx';
import { copyText, Empty, ErrorBox, Field, Modal, Select, Spinner, useToast } from '../components/ui.jsx';
import { fmtDate } from '../lib/s3.js';
import { secrets } from '../lib/secrets.js';

const secretPath = (id) => `/secrets?secret=${encodeURIComponent(id)}`;
const resourceId = (entry) => entry.ARN || entry.Name;

function SecretStatus({ deleted }) {
  return <span className={`secret-status${deleted ? ' pending' : ''}`}>{deleted ? 'Scheduled for deletion' : 'Active'}</span>;
}

function OpenSecret({ onClose, onOpen }) {
  const [input, setInput] = useState('');
  const id = input.trim();
  const open = () => { if (id) onOpen(id); };
  return (
    <Modal title="Open secret" onClose={onClose} footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={open} disabled={!id}>Open</button>
      </>
    )}>
      <Field label="Secret name or ARN">
        <input autoFocus className="mono" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} />
      </Field>
    </Modal>
  );
}

function SecretValue({ secretId, versions, disabled }) {
  const toast = useToast();
  const [stage, setStage] = useState('AWSCURRENT');
  const [result, setResult] = useState(null);
  const request = useRef(null);
  const stages = [...new Set(['AWSCURRENT', ...Object.values(versions || {}).flat()])];
  const currentStage = stages.includes(stage) ? stage : 'AWSCURRENT';
  const value = result?.data?.SecretString ?? result?.data?.SecretBinary;
  const binary = result?.data?.SecretString === undefined && result?.data?.SecretBinary !== undefined;

  useEffect(() => () => request.current?.abort(), []);

  const hide = () => {
    request.current?.abort();
    setResult(null);
  };
  const retrieve = async () => {
    const controller = new AbortController();
    request.current = controller;
    setResult({ loading: true });
    try {
      const data = await secrets('GetSecretValue', { SecretId: secretId, VersionStage: currentStage }, controller.signal);
      if (!controller.signal.aborted) setResult({ data });
    } catch (e) {
      if (!controller.signal.aborted) setResult({ error: errorText(e) });
    } finally {
      if (request.current === controller) request.current = null;
    }
  };
  const copy = async () => {
    const copied = await copyText(value).catch(() => false);
    if (copied) toast('Secret value copied');
    else toast('Could not copy the secret value', 'error');
  };

  return (
    <section className="card secret-panel" aria-label="Secret value">
      <header className="secret-panel-heading">
        <h3>Secret value</h3>
        <Field label="Version stage" inline>
          <Select value={currentStage} onChange={(next) => { hide(); setStage(next); }} options={stages} disabled={disabled} />
        </Field>
      </header>
      <div className="secret-panel-body">
        <ErrorBox error={result?.error} />
        {result?.data ? (
          <>
            <div className="secret-value-actions row-gap wrap">
              {binary && <span className="muted small">Binary value shown as Base64.</span>}
              <div className="push-right row-gap wrap">
                <button className="btn btn-sm" onClick={hide}>Hide value</button>
                {value !== undefined && <button className="btn btn-primary btn-sm" onClick={copy}>Copy value</button>}
              </div>
            </div>
            {value === undefined ? <Empty>This version has no value.</Empty> : <pre className="code pre-wrap secret-code">{value}</pre>}
          </>
        ) : (
          <div className="secret-hidden">
            <span className="secret-lock-mark" aria-hidden="true"><span className="lock-glyph" /></span>
            <strong>{result?.loading ? 'Retrieving value…' : 'Value hidden'}</strong>
            <p className="muted small">{result?.loading ? 'Waiting for Secrets Manager.' : 'Retrieve this version to view its contents.'}</p>
            {result?.loading ? (
              <button className="btn" onClick={hide}>Cancel retrieval</button>
            ) : <button className="btn btn-primary" onClick={retrieve} disabled={disabled}>Retrieve value</button>}
          </div>
        )}
      </div>
    </section>
  );
}

function SecretDetails({ secretId, onChanged }) {
  const toast = useToast();
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [modal, setModal] = useState(null);
  const name = metadata?.Name || secretId;
  const id = metadata?.ARN || secretId;
  const deleted = Boolean(metadata?.DeletedDate);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    secrets('DescribeSecret', { SecretId: secretId }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setMetadata(data); })
      .catch((e) => { if (!controller.signal.aborted) setLoadError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [secretId, revision]);

  const apply = (fields) => {
    const updated = { ...metadata, ...fields };
    setMetadata(updated);
    onChanged(updated);
  };
  const restore = async () => {
    setRestoring(true);
    setActionError(null);
    try {
      await secrets('RestoreSecret', { SecretId: id });
      apply({ DeletedDate: undefined });
      toast('Secret restored');
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="page secret-page">
      <a href="#/secrets" className="resource-back"><span aria-hidden="true">←</span> Back to secrets</a>
      <div className="resource-heading">
        <div className="resource-title">
          <span className="feature-icon" aria-hidden="true"><span className="lock-glyph" /></span>
          <div><h2>{name}</h2>{metadata && <SecretStatus deleted={deleted} />}</div>
        </div>
        {metadata && (
          <div className="resource-actions row-gap wrap">
            {deleted ? <button className="btn btn-primary" disabled={restoring} onClick={restore}>{restoring ? 'Restoring…' : 'Restore secret'}</button> : (
              <>
                <button className="btn" onClick={() => setModal('edit')} disabled={loading}>Edit secret</button>
                <button className="btn btn-danger" onClick={() => setModal('delete')} disabled={loading}>Schedule deletion</button>
              </>
            )}
          </div>
        )}
      </div>
      <ErrorBox error={loadError} />
      <ErrorBox error={actionError} />
      {loading && <Spinner />}
      <div className={`secret-detail-grid${metadata ? ' with-metadata' : ''}`}>
        <div>
          {deleted && <Empty>Restore this secret to retrieve or update its value.</Empty>}
          {!deleted && !modal && <SecretValue secretId={id} versions={metadata?.VersionIdsToStages} disabled={loading} />}
        </div>
        {metadata && (
          <section className="card secret-panel" aria-labelledby="secret-metadata-title">
            <header className="secret-panel-heading"><h3 id="secret-metadata-title">Details</h3></header>
            <dl className="secret-metadata secret-panel-body">
              {metadata.ARN && <div><dt>ARN</dt><dd><code>{metadata.ARN}</code></dd></div>}
              <div><dt>Description</dt><dd>{metadata.Description || '—'}</dd></div>
              <div><dt>Last changed</dt><dd>{fmtDate(metadata.LastChangedDate)}</dd></div>
            </dl>
          </section>
        )}
      </div>
      {modal === 'edit' && (
        <SecretEditor secret={metadata} onClose={() => setModal(null)} onSaved={(result) => {
          apply({ ARN: result.ARN || metadata.ARN, Description: result.Description });
          setModal(null);
          setRevision((value) => value + 1);
          toast('Secret updated');
        }} />
      )}
      {modal === 'delete' && (
        <ScheduleSecretDeletion secret={metadata} onClose={() => setModal(null)} onScheduled={(DeletedDate) => {
          apply({ DeletedDate });
          setModal(null);
          toast('Secret scheduled for deletion');
        }} />
      )}
    </div>
  );
}

export default function SecretsManager({ secretId }) {
  const { conn, info } = useApp();
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(Boolean(conn));
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null);

  const load = useCallback(async (token) => {
    setLoading(true);
    setError(null);
    try {
      const response = await secrets('ListSecrets', { IncludePlannedDeletion: true, MaxResults: 100, NextToken: token || undefined });
      const page = response.SecretList || [];
      setEntries((current) => token ? [...new Map([...current, ...page].map((entry) => [resourceId(entry), entry])).values()] : page);
      setNext(response.NextToken || null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (conn) load(); }, [conn, load]);

  const remember = (entry) => setEntries((current) => {
    const id = resourceId(entry);
    const index = current.findIndex((item) => resourceId(item) === id);
    return index < 0 ? [entry, ...current] : current.map((item, i) => i === index ? { ...item, ...entry } : item);
  });
  const open = (id) => {
    setModal(null);
    navigate(secretPath(id));
  };
  const q = filter.trim().toLowerCase();
  const shown = entries.filter((entry) => (entry.Name || entry.ARN || '').toLowerCase().includes(q));

  if (!conn) return <div className="page secret-page"><h2>Secrets</h2><Empty>Select a connection and region to manage secrets.</Empty></div>;
  if (secretId) return <SecretDetails key={secretId} secretId={secretId} onChanged={remember} />;

  return (
    <div className="page secret-page">
      <div className="resource-heading">
        <div className="resource-title">
          <span className="feature-icon" aria-hidden="true"><span className="lock-glyph" /></span>
          <div><h2>Secrets</h2><div className="resource-scope">{info.label} <span aria-hidden="true">·</span> <code>{info.region}</code></div></div>
        </div>
        <div className="resource-actions row-gap wrap">
          <button className="btn" onClick={() => setModal('open')}>Open secret</button>
          <button className="btn btn-primary" onClick={() => setModal('create')}><span aria-hidden="true">＋</span> Create secret</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="card secret-inventory" aria-label="Secret inventory">
        <div className="secret-inventory-toolbar">
          <label className="secret-search">
            <span className="search-glyph" aria-hidden="true" />
            <input type="search" aria-label="Filter loaded secrets by name" placeholder="Filter loaded secrets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <button className="btn" onClick={() => load()} disabled={loading}><span aria-hidden="true">↻</span> Refresh</button>
        </div>
        {shown.length > 0 && (
          <div className="secret-table-wrap">
            <table className="grid secret-table">
              <thead><tr><th>Name</th><th>Description</th><th>Last changed</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((entry) => (
                  <tr key={resourceId(entry)}>
                    <td title={entry.ARN}>
                      <a className="secret-name" href={`#${encodeURI(secretPath(resourceId(entry)))}`}>
                        <span className="feature-icon" aria-hidden="true"><span className="lock-glyph" /></span>
                        <span>{entry.Name || entry.ARN}</span>
                      </a>
                    </td>
                    <td title={entry.Description}>{entry.Description || '—'}</td>
                    <td>{fmtDate(entry.LastChangedDate)}</td>
                    <td><SecretStatus deleted={Boolean(entry.DeletedDate)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!shown.length && (
          <div className="secret-inventory-empty">
            {loading ? <Spinner /> : !error && (q ? 'No loaded secrets match your filter.' : next ? 'No secrets on this page.' : 'No secrets in this region.')}
          </div>
        )}
        <div className="secret-inventory-footer">
          <span className="muted small" role="status">{loading ? 'Loading secrets…' : `${q ? `${shown.length} of ` : ''}${entries.length} ${entries.length === 1 ? 'secret' : 'secrets'} loaded`}</span>
          {next && <button className="btn btn-sm" disabled={loading} onClick={() => load(next)}>Load more</button>}
        </div>
      </section>
      {modal === 'open' && <OpenSecret onClose={() => setModal(null)} onOpen={open} />}
      {modal === 'create' && (
        <SecretEditor onClose={() => setModal(null)} onSaved={(entry) => {
          remember(entry);
          open(resourceId(entry));
          toast('Secret created');
        }} />
      )}
    </div>
  );
}
