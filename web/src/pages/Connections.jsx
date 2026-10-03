import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { useApp } from '../context.js';
import { Modal, Field, Select, ErrorBox, Spinner, useToast, nextId } from '../components/ui.jsx';
import { REGIONS } from '../lib/dynamo.js';

const PRESETS = {
  static: { label: 'Access keys', keys: ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token'] },
  sso: { label: 'IAM Identity Center (SSO)', keys: ['sso_session', 'sso_start_url', 'sso_region', 'sso_account_id', 'sso_role_name'] },
  'assume-role': { label: 'Assume role', keys: ['role_arn', 'source_profile', 'credential_source', 'external_id', 'role_session_name', 'mfa_serial', 'duration_seconds'] },
  process: { label: 'Credential process', keys: ['credential_process'] },
  'web-identity': { label: 'Web identity', keys: ['role_arn', 'web_identity_token_file', 'role_session_name'] },
  other: { label: 'Custom / other', keys: [] },
};
const COMMON = ['region', 'output'];
const SECRET = new Set(['aws_secret_access_key', 'aws_session_token']);
const LABELS = {
  aws_access_key_id: 'Access key ID', aws_secret_access_key: 'Secret access key', aws_session_token: 'Session token (optional)',
  sso_session: 'SSO session name', sso_start_url: 'SSO start URL', sso_region: 'SSO region', sso_account_id: 'Account ID', sso_role_name: 'Role name',
  role_arn: 'Role ARN', source_profile: 'Source profile', credential_source: 'Credential source (Environment / Ec2InstanceMetadata / EcsContainer)',
  external_id: 'External ID', role_session_name: 'Role session name', mfa_serial: 'MFA serial (not supported in web UI)', duration_seconds: 'Duration (seconds)',
  credential_process: 'Command', web_identity_token_file: 'Token file', region: 'Default region', output: 'Output format',
};

function ProfileModal({ profile, profiles, onClose, onSaved }) {
  const isNew = !profile;
  const [name, setName] = useState(profile?.name || '');
  const [type, setType] = useState(profile?.type || 'static');
  const [values, setValues] = useState(() => ({ ...(profile?.settings || {}) }));
  const known = new Set([...COMMON, ...Object.values(PRESETS).flatMap((p) => p.keys)]);
  const [extra, setExtra] = useState(() =>
    Object.entries(profile?.settings || {})
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => ({ id: nextId(), k, v })),
  );
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const has = (k) => profile?.secrets?.includes(k);

  const save = async () => {
    setBusy(true);
    setError(null);
    const settings = {};
    for (const k of [...COMMON, ...PRESETS[type].keys]) {
      if (values[k] !== undefined && (values[k] !== '' || (SECRET.has(k) && has(k)))) settings[k] = values[k];
    }
    // keep secret keys of the preset even when untouched so they are not deleted
    for (const k of PRESETS[type].keys) if (SECRET.has(k) && has(k) && settings[k] === undefined) settings[k] = '';
    for (const { k, v } of extra) if (k.trim()) settings[k.trim()] = v;
    try {
      if (isNew) await api('/api/profiles', { method: 'POST', body: { name, settings } });
      else await api(`/api/profiles/${encodeURIComponent(profile.name)}`, { method: 'PUT', body: { name, settings } });
      onSaved(name);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const input = (k) => {
    if (k === 'region' || k === 'sso_region') {
      return (
        <input list="regions" value={values[k] || ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} placeholder="us-east-1" />
      );
    }
    if (k === 'output') return <Select value={values[k] || ''} onChange={(v) => setValues({ ...values, [k]: v })} options={[['', '(none)'], 'json', 'yaml', 'yaml-stream', 'text', 'table']} />;
    if (k === 'source_profile') {
      return <Select value={values[k] || ''} onChange={(v) => setValues({ ...values, [k]: v })} options={[['', '(none)'], ...profiles.filter((p) => p.name !== profile?.name).map((p) => p.name)]} />;
    }
    return (
      <input
        type={SECRET.has(k) ? 'password' : 'text'}
        autoComplete="off"
        value={values[k] || ''}
        placeholder={SECRET.has(k) && has(k) ? '•••••••• (unchanged — leave empty to keep)' : ''}
        onChange={(e) => setValues({ ...values, [k]: e.target.value })}
      />
    );
  };

  return (
    <Modal
      title={isNew ? 'New AWS profile' : `Edit profile: ${profile.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name}>{busy ? <Spinner /> : 'Save profile'}</button>
        </>
      }
    >
      <datalist id="regions">{REGIONS.map((r) => <option key={r} value={r} />)}</datalist>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid-2">
        <Field label="Profile name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-profile" autoFocus={isNew} />
        </Field>
        <Field label="Credential type">
          <Select value={type} onChange={setType} options={Object.entries(PRESETS).map(([k, p]) => [k, p.label])} />
        </Field>
      </div>
      <div className="grid-2">
        {[...COMMON, ...PRESETS[type].keys].map((k) => (
          <Field key={k} label={LABELS[k] || k}>
            {input(k)}
          </Field>
        ))}
      </div>
      {type === 'sso' && (
        <div className="alert alert-info">
          SSO tokens are read from <code>~/.aws/sso/cache</code>. Run <code>aws sso login --profile {name || '<name>'}</code> on the host machine first; the container reuses the cached token.
        </div>
      )}
      <h4>Additional settings</h4>
      <div className="builder">
        {extra.map((r, i) => (
          <div className="builder-row" key={r.id}>
            <input value={r.k} placeholder="key (e.g. retry_mode)" onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <input value={r.v} placeholder="value" onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button className="icon-btn" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn btn-xs" onClick={() => setExtra([...extra, { id: nextId(), k: '', v: '' }])}>+ Add setting</button>
      </div>
    </Modal>
  );
}

function EndpointModal({ endpoint, profiles, onClose, onSaved, s3, cwl, mq, fx }) {
  const isNew = !endpoint;
  const [v, setV] = useState(
    () =>
      endpoint ||
      (s3
        ? { name: 'MinIO', endpoint: 'http://localhost:9000', region: 'us-east-1', authMode: 'keys' }
        : cwl || mq || fx
          ? { name: 'LocalStack', endpoint: 'http://localhost:4566', region: 'us-east-1', authMode: 'local' }
          : { name: 'DynamoDB Local', endpoint: 'http://localhost:8000', region: 'us-east-1', authMode: 'local' }),
  );
  // In the S3 workspace the main URL field edits the S3 endpoint (s3Endpoint overrides endpoint when set).
  const s3Key = s3 && endpoint?.s3Endpoint ? 's3Endpoint' : 'endpoint';
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (p) => setV({ ...v, ...p });
  const save = async () => {
    setBusy(true);
    try {
      const out = isNew
        ? await api('/api/connections', { method: 'POST', body: v })
        : await api(`/api/connections/${endpoint.id}`, { method: 'PUT', body: v });
      onSaved(out);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isNew ? 'New endpoint connection' : `Edit: ${endpoint.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name"><input value={v.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      {s3 ? (
        <Field label="S3 endpoint URL" hint="MinIO http://localhost:9000, LocalStack http://localhost:4566… Inside Docker, use http://host.docker.internal:<port> for a server on your machine. Path-style addressing is used.">
          <input value={v[s3Key] || ''} onChange={(e) => set({ [s3Key]: e.target.value })} />
        </Field>
      ) : (
        <>
          <Field label="Endpoint URL" hint="Inside Docker, use http://dynamodb-local:8000 (compose service) or http://host.docker.internal:8000 for a server on your machine.">
            <input value={v.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
          </Field>
          <Field label="S3 endpoint URL (optional)" hint="Used by the S3 browser when S3 runs on another URL. Empty = same as the endpoint above.">
            <input value={v.s3Endpoint || ''} onChange={(e) => set({ s3Endpoint: e.target.value })} placeholder="(same as endpoint URL)" />
          </Field>
          <Field label="CloudWatch Logs endpoint URL (optional)" hint="Used by CloudWatch Logs when it runs on another URL. Empty = same as the endpoint above.">
            <input value={v.logsEndpoint || ''} onChange={(e) => set({ logsEndpoint: e.target.value })} placeholder="(same as endpoint URL)" />
          </Field>
          <Field label="SQS endpoint URL (optional)" hint="Used by SQS when it runs on another URL, e.g. ElasticMQ http://localhost:9324. Empty = same as the endpoint above.">
            <input value={v.sqsEndpoint || ''} onChange={(e) => set({ sqsEndpoint: e.target.value })} placeholder="(same as endpoint URL)" />
          </Field>
          <Field label="Lambda endpoint URL (optional)" hint="Used by Lambda (and its IAM / CloudWatch calls) when it runs on another URL. Empty = same as the endpoint above.">
            <input value={v.lambdaEndpoint || ''} onChange={(e) => set({ lambdaEndpoint: e.target.value })} placeholder="(same as endpoint URL)" />
          </Field>
          <Field label="Step Functions endpoint URL (optional)" hint="Used by Step Functions when it runs on another URL, e.g. Step Functions Local http://localhost:8083. Empty = same as the endpoint above.">
            <input value={v.sfnEndpoint || ''} onChange={(e) => set({ sfnEndpoint: e.target.value })} placeholder="(same as endpoint URL)" />
          </Field>
        </>
      )}
      <div className="grid-2">
        <Field label="Region"><input list="regions2" value={v.region} onChange={(e) => set({ region: e.target.value })} /></Field>
        <Field label="Credentials">
          <Select value={v.authMode} onChange={(authMode) => set({ authMode })} options={[['local', s3 ? 'Dummy (local / anonymous)' : 'Dummy (DynamoDB Local)'], ['keys', 'Access keys'], ['profile', 'AWS profile']]} />
        </Field>
      </div>
      <datalist id="regions2">{REGIONS.map((r) => <option key={r} value={r} />)}</datalist>
      {v.authMode === 'keys' && (
        <div className="grid-2">
          <Field label="Access key ID"><input value={v.accessKeyId || ''} onChange={(e) => set({ accessKeyId: e.target.value })} autoComplete="off" /></Field>
          <Field label="Secret access key">
            <input type="password" autoComplete="off" value={v.secretAccessKey || ''} placeholder={endpoint?.hasSecret ? '(unchanged)' : ''} onChange={(e) => set({ secretAccessKey: e.target.value })} />
          </Field>
        </div>
      )}
      {v.authMode === 'profile' && (
        <Field label="Profile"><Select value={v.profile || ''} onChange={(profile) => set({ profile })} options={[['', '— select —'], ...profiles.map((p) => p.name)]} /></Field>
      )}
      {!s3 && <div className="muted small">DynamoDB Local tip: the access key ID acts as a namespace unless DynamoDB Local runs with <code>-sharedDb</code>.</div>}
    </Modal>
  );
}

export default function Connections() {
  const { profiles, endpoints, reloadConnections, conn, setConn, workspace } = useApp();
  const s3 = workspace === 's3';
  const cwl = workspace === 'logs';
  const mq = workspace === 'sqs';
  const fx = workspace === 'lambda';
  const sf = workspace === 'sfn';
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(null); // {kind:'profile'|'endpoint', value}
  const [tests, setTests] = useState({});

  useEffect(() => {
    api('/api/info').then(setInfo).catch(() => {});
  }, []);

  const test = async (key, c) => {
    setTests((t) => ({ ...t, [key]: { busy: true } }));
    try {
      const r = await api('/api/test', { method: 'POST', body: { service: workspace }, conn: c });
      const what =
        r.stateMachineCount !== undefined
          ? `${r.stateMachineCount}${r.more ? '+' : ''} state machines in ${r.region}`
          : r.functionCount !== undefined
          ? `${r.functionCount}${r.more ? '+' : ''} functions in ${r.region}`
          : r.logGroupCount !== undefined
          ? `${r.logGroupCount}${r.more ? '+' : ''} log groups in ${r.region}`
          : r.queueCount !== undefined
            ? `${r.queueCount}${r.more ? '+' : ''} queues in ${r.region}`
            : r.bucketCount !== undefined
            ? `${r.bucketCount} buckets`
            : `${r.tableCount}${r.more ? '+' : ''} tables in ${r.region}`;
      setTests((t) => ({ ...t, [key]: { ok: true, text: `${r.identity ? `${r.identity.arn} · ` : ''}${what}` } }));
    } catch (e) {
      setTests((t) => ({ ...t, [key]: { ok: false, text: errorText(e) } }));
    }
  };

  const delProfile = async (p) => {
    if (!window.confirm(`Delete profile "${p.name}" from ~/.aws/config and ~/.aws/credentials?\nA .bak backup of each file is kept.`)) return;
    try {
      await api(`/api/profiles/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
      if (conn?.kind === 'profile' && conn.profile === p.name) setConn(null);
      await reloadConnections();
      toast('Profile deleted');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const delEndpoint = async (e) => {
    if (!window.confirm(`Delete connection "${e.name}"?`)) return;
    await api(`/api/connections/${e.id}`, { method: 'DELETE' });
    if (conn?.kind === 'endpoint' && conn.id === e.id) setConn(null);
    await reloadConnections();
  };

  const TestCell = ({ k }) => {
    const t = tests[k];
    if (!t) return null;
    if (t.busy) return <Spinner />;
    return <span className={t.ok ? 'text-ok small' : 'text-bad small'} title={t.text}>{t.ok ? '✓ ' : '✗ '}{t.text}</span>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Connections</h2>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>AWS profiles</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ kind: 'profile', value: null })} disabled={info && !info.awsDirWritable}>+ New profile</button>
        </div>
        {info && (
          <div className="muted small">
            Reading <code>{info.configFile}</code> and <code>{info.credentialsFile}</code>
            {!info.awsDirWritable && <span className="text-bad"> — directory is read-only; mount ~/.aws read-write to edit profiles.</span>}
          </div>
        )}
        <table className="grid grid-plain">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Region</th><th>Details</th><th>Test</th><th /></tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.name}>
                <td><strong>{p.name}</strong>{conn?.kind === 'profile' && conn.profile === p.name && <span className="badge badge-ok">active</span>}</td>
                <td>{PRESETS[p.type]?.label || p.type}</td>
                <td>{p.region || <span className="muted">—</span>}</td>
                <td className="small muted ellipsis">
                  {p.settings.aws_access_key_id && `key ${p.settings.aws_access_key_id.slice(0, 4)}…${p.settings.aws_access_key_id.slice(-4)}`}
                  {p.settings.role_arn && ` ${p.settings.role_arn}`}
                  {p.settings.sso_account_id && ` account ${p.settings.sso_account_id} / ${p.settings.sso_role_name || ''}`}
                  {p.settings.source_profile && ` via ${p.settings.source_profile}`}
                </td>
                <td><TestCell k={`p:${p.name}`} /></td>
                <td className="row-actions">
                  <button className="btn btn-xs" onClick={() => setConn({ kind: 'profile', profile: p.name, region: p.region || 'us-east-1' })}>Use</button>
                  <button className="btn btn-xs" onClick={() => test(`p:${p.name}`, { kind: 'profile', profile: p.name, region: p.region })}>Test</button>
                  <button className="btn btn-xs" onClick={() => setEditing({ kind: 'profile', value: p })}>Edit</button>
                  <button className="btn btn-xs btn-danger" onClick={() => delProfile(p)}>Delete</button>
                </td>
              </tr>
            ))}
            {!profiles.length && (
              <tr><td colSpan={6} className="muted">No profiles found. Create one, or mount your ~/.aws directory into the container.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Custom endpoints</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ kind: 'endpoint', value: null })}>+ New endpoint</button>
        </div>
        <div className="muted small">{s3 ? 'MinIO, LocalStack or any S3-compatible storage.' : cwl ? 'LocalStack or any CloudWatch Logs-compatible endpoint.' : mq ? 'LocalStack, ElasticMQ or any SQS-compatible endpoint.' : fx ? 'LocalStack or any Lambda-compatible endpoint.' : sf ? 'LocalStack, Step Functions Local or any Step Functions-compatible endpoint.' : 'DynamoDB Local, LocalStack or any DynamoDB-compatible endpoint.'}</div>
        <table className="grid grid-plain">
          <thead><tr><th>Name</th><th>Endpoint</th><th>Region</th><th>Credentials</th><th>Test</th><th /></tr></thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.id}>
                <td><strong>{e.name}</strong>{conn?.kind === 'endpoint' && conn.id === e.id && <span className="badge badge-ok">active</span>}</td>
                <td><code>{s3 ? e.s3Endpoint || e.endpoint : cwl ? e.logsEndpoint || e.endpoint : mq ? e.sqsEndpoint || e.endpoint : fx ? e.lambdaEndpoint || e.endpoint : sf ? e.sfnEndpoint || e.endpoint : e.endpoint}</code></td>
                <td>{e.region}</td>
                <td>{e.authMode === 'profile' ? `profile ${e.profile}` : e.authMode === 'keys' ? 'access keys' : 'dummy'}</td>
                <td><TestCell k={`e:${e.id}`} /></td>
                <td className="row-actions">
                  <button className="btn btn-xs" onClick={() => setConn({ kind: 'endpoint', id: e.id })}>Use</button>
                  <button className="btn btn-xs" onClick={() => test(`e:${e.id}`, { kind: 'endpoint', id: e.id })}>Test</button>
                  <button className="btn btn-xs" onClick={() => setEditing({ kind: 'endpoint', value: e })}>Edit</button>
                  <button className="btn btn-xs btn-danger" onClick={() => delEndpoint(e)}>Delete</button>
                </td>
              </tr>
            ))}
            {!endpoints.length && <tr><td colSpan={6} className="muted">No custom endpoints.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing?.kind === 'profile' && (
        <ProfileModal
          profile={editing.value}
          profiles={profiles}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await reloadConnections();
            if (conn?.kind === 'profile' && editing.value && conn.profile === editing.value.name && name !== editing.value.name) {
              setConn({ ...conn, profile: name });
            }
            toast('Profile saved');
          }}
        />
      )}
      {editing?.kind === 'endpoint' && (
        <EndpointModal
          endpoint={editing.value}
          profiles={profiles}
          s3={s3}
          cwl={cwl}
          mq={mq}
          fx={fx}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reloadConnections();
            toast('Connection saved');
          }}
        />
      )}
    </div>
  );
}
