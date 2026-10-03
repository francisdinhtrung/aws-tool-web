import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { Spinner, ErrorBox, Empty, Field, Select, CodeBlock, useToast, copyText } from './ui.jsx';
import { MappingModal, PermissionModal, AliasModal, BASIC_EXECUTION_POLICY } from './LambdaModals.jsx';
import {
  lambda, lambdaIam, listAll, sourceService, sourceLabel, policyStatements, policyTriggers, roleNameFromArn, fmtDate, parseLastModified, arnTail,
} from '../lib/lambda.js';
import { sqsPath } from '../lib/sqs.js';

const notFound = (e) => e?.status === 404 || e?.name === 'ResourceNotFoundException';

/** Link to the source inside this app when we have a page for it. */
function SourceLink({ arn }) {
  const svc = sourceService(arn);
  const label = sourceLabel(arn);
  if (svc === 'sqs') return <a href={`#${sqsPath(label)}`} title={arn}>{label}</a>;
  if (svc === 'dynamodb') return <a href={`#/table/${encodeURIComponent(label)}`} title={arn}>{label}</a>;
  return <span title={arn}>{label}</span>;
}

// --- Triggers ------------------------------------------------------------------------------------------
export function TriggersTab({ name }) {
  const toast = useToast();
  const [mappings, setMappings] = useState(null);
  const [push, setPush] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | mapping

  const load = useCallback(async () => {
    setError(null);
    try {
      setMappings(await listAll('ListEventSourceMappings', { FunctionName: name, MaxItems: 100 }, 'EventSourceMappings'));
    } catch (e) {
      setMappings([]);
      setError(errorText(e));
    }
    try {
      setPush(policyTriggers((await lambda('GetPolicy', { FunctionName: name })).Policy));
    } catch (e) {
      setPush(notFound(e) ? [] : { error: errorText(e) });
    }
  }, [name]);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (m) => {
    const enable = m.State === 'Disabled';
    try {
      await lambda('UpdateEventSourceMapping', { UUID: m.UUID, Enabled: enable });
      toast(enable ? 'Enabling trigger' : 'Disabling trigger');
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async (m) => {
    if (!window.confirm(`Delete the trigger from ${sourceLabel(m.EventSourceArn)}? The source itself is not deleted.`)) return;
    try {
      await lambda('DeleteEventSourceMapping', { UUID: m.UUID });
      toast('Trigger deleted');
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="card">
        <div className="card-head">
          <h3>Event source mappings {mappings && <span className="muted">({mappings.length})</span>}</h3>
          <div className="row-gap">
            <button className="btn btn-xs" onClick={load}>↻</button>
            <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>＋ Add trigger</button>
          </div>
        </div>
        {!mappings && <Spinner />}
        {mappings && !mappings.length && <Empty>No polling triggers (SQS, Kinesis, DynamoDB streams, MSK).</Empty>}
        {mappings?.length > 0 && (
          <table className="grid grid-plain">
            <thead><tr><th>Source</th><th>Type</th><th>State</th><th className="col-num">Batch</th><th>Last result</th><th>Filters</th><th /></tr></thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.UUID}>
                  <td><SourceLink arn={m.EventSourceArn} /></td>
                  <td className="small">{sourceService(m.EventSourceArn)}</td>
                  <td><span className={`badge${m.State === 'Enabled' ? ' badge-ok' : m.State === 'Disabled' ? '' : ' badge-warn'}`} title={m.StateTransitionReason}>{m.State}</span></td>
                  <td className="col-num">{m.BatchSize ?? '—'}{m.MaximumBatchingWindowInSeconds ? ` / ${m.MaximumBatchingWindowInSeconds}s` : ''}</td>
                  <td className="small ellipsis" title={m.LastProcessingResult}>{m.LastProcessingResult || '—'}</td>
                  <td className="small">{m.FilterCriteria?.Filters?.length || '—'}</td>
                  <td className="row-actions">
                    <button className="btn btn-xs" onClick={() => toggle(m)} disabled={!['Enabled', 'Disabled'].includes(m.State)}>{m.State === 'Disabled' ? 'Enable' : 'Disable'}</button>
                    <button className="btn btn-xs" onClick={() => setEditing(m)}>Edit</button>
                    <button className="btn btn-xs btn-danger" onClick={() => remove(m)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h3>Push triggers (from the resource-based policy)</h3></div>
        <div className="muted small">Services allowed to invoke the function: API Gateway, S3, SNS, EventBridge… Manage them in the Permissions tab; the source itself is configured in its own service.</div>
        {!push && <Spinner />}
        {push?.error && <div className="text-bad small">{push.error}</div>}
        {Array.isArray(push) && !push.length && <div className="muted small mt-s">None.</div>}
        {Array.isArray(push) && push.length > 0 && (
          <table className="grid grid-plain mt-s">
            <thead><tr><th>Service</th><th>Source</th><th>Statement</th></tr></thead>
            <tbody>
              {push.map((t) => (
                <tr key={t.sid}><td><span className="badge">{t.service}</span></td><td className="mono small">{t.source}</td><td className="small muted">{t.sid}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <MappingModal fn={name} mapping={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast('Trigger saved'); load(); }} />}
    </>
  );
}

// --- Permissions ---------------------------------------------------------------------------------------
const MANAGED = [
  [BASIC_EXECUTION_POLICY, 'AWSLambdaBasicExecutionRole (CloudWatch Logs)'],
  ['arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole', 'AWSLambdaSQSQueueExecutionRole'],
  ['arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole', 'AWSLambdaDynamoDBExecutionRole (streams)'],
  ['arn:aws:iam::aws:policy/service-role/AWSLambdaKinesisExecutionRole', 'AWSLambdaKinesisExecutionRole'],
  ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole', 'AWSLambdaVPCAccessExecutionRole'],
  ['arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess', 'AWSXRayDaemonWriteAccess (tracing)'],
];

export function PermissionsTab({ name, cfg, qualifier }) {
  const toast = useToast();
  const roleName = roleNameFromArn(cfg.Role);
  const [attached, setAttached] = useState(null);
  const [inline, setInline] = useState([]);
  const [roleError, setRoleError] = useState(null);
  const [policy, setPolicy] = useState(undefined);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [attach, setAttach] = useState('');

  const loadRole = useCallback(async () => {
    try {
      const [a, i] = await Promise.all([lambdaIam('ListAttachedRolePolicies', { RoleName: roleName }), lambdaIam('ListRolePolicies', { RoleName: roleName })]);
      setAttached(a.AttachedPolicies || []);
      setInline(i.PolicyNames || []);
    } catch (e) {
      setAttached([]);
      setRoleError(errorText(e));
    }
  }, [roleName]);
  const loadPolicy = useCallback(async () => {
    try {
      setPolicy((await lambda('GetPolicy', { FunctionName: name, ...(qualifier ? { Qualifier: qualifier } : {}) })).Policy);
    } catch (e) {
      if (notFound(e)) setPolicy(null);
      else {
        setPolicy(null);
        setError(errorText(e));
      }
    }
  }, [name, qualifier]);
  useEffect(() => {
    loadRole();
  }, [loadRole]);
  useEffect(() => {
    loadPolicy();
  }, [loadPolicy]);

  const removeStatement = async (sid) => {
    if (!window.confirm(`Remove statement "${sid}"? The principal can no longer invoke the function.`)) return;
    try {
      await lambda('RemovePermission', { FunctionName: name, StatementId: sid, ...(qualifier ? { Qualifier: qualifier } : {}) });
      toast('Permission removed');
      loadPolicy();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const attachPolicy = async () => {
    try {
      await lambdaIam('AttachRolePolicy', { RoleName: roleName, PolicyArn: attach });
      toast('Policy attached');
      setAttach('');
      loadRole();
    } catch (e) {
      setRoleError(errorText(e));
    }
  };
  const statements = policy ? policyStatements(policy) : [];
  const missing = MANAGED.filter(([arn]) => !attached?.some((p) => p.PolicyArn === arn));

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Execution role</h3>
          <a className="btn btn-xs" href={`https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(roleName)}`} target="_blank" rel="noreferrer">Open in IAM ↗</a>
        </div>
        <div className="small"><strong>{roleName}</strong> <span className="muted mono">{cfg.Role}</span></div>
        {roleError && <div className="text-bad small mt-s">{roleError}</div>}
        {attached === null && <Spinner />}
        {attached?.length > 0 && (
          <ul className="fn-policies">
            {attached.map((p) => <li key={p.PolicyArn}><code>{p.PolicyName}</code> <span className="muted small">managed</span></li>)}
            {inline.map((p) => <li key={p}><code>{p}</code> <span className="muted small">inline</span></li>)}
          </ul>
        )}
        {attached && !roleError && (
          <div className="row-gap mt-s">
            <Select value={attach} onChange={setAttach} options={[['', '— attach an AWS managed policy —'], ...missing]} aria-label="Managed policy" />
            <button className="btn btn-sm" onClick={attachPolicy} disabled={!attach}>Attach</button>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Resource-based policy {qualifier && <span className="badge">{qualifier}</span>}</h3>
          <div className="row-gap">
            <button className="btn btn-xs" onClick={loadPolicy}>↻</button>
            <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>＋ Add permission</button>
          </div>
        </div>
        <div className="muted small">Who else may invoke or read this function (other services, accounts).</div>
        <ErrorBox error={error} onClose={() => setError(null)} />
        {policy === undefined && <Spinner />}
        {policy === null && !error && <div className="muted small mt-s">No resource-based policy.</div>}
        {statements.length > 0 && (
          <>
            <table className="grid grid-plain mt-s">
              <thead><tr><th>Statement ID</th><th>Principal</th><th>Action</th><th>Condition</th><th /></tr></thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.sid}>
                    <td className="small">{s.sid}</td>
                    <td className="small">{s.principal}</td>
                    <td className="small">{s.action}</td>
                    <td className="mono small ellipsis" title={s.sourceArn}>{s.sourceArn || s.sourceAccount || (s.urlAuth && `FunctionUrlAuthType = ${s.urlAuth}`) || '—'}</td>
                    <td><button className="btn btn-xs btn-danger" onClick={() => removeStatement(s.sid)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="mt-s"><summary className="small muted">Policy JSON</summary><CodeBlock code={JSON.stringify(JSON.parse(policy), null, 2)} maxHeight="40vh" /></details>
          </>
        )}
      </div>
      {adding && <PermissionModal fn={name} qualifier={qualifier} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); toast('Permission added'); loadPolicy(); }} />}
    </>
  );
}

// --- Versions & aliases -----------------------------------------------------------------------------------
export function VersionsTab({ name, cfg, versions, aliases, reloadVersions, versionNames, setQualifier }) {
  const toast = useToast();
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | alias
  const published = versions.filter((v) => v.Version !== '$LATEST').reverse();

  const act = async (f, msg) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      if (msg) toast(msg);
      await reloadVersions();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const publish = () => act(async () => {
    const out = await lambda('PublishVersion', { FunctionName: name, ...(desc ? { Description: desc } : {}), CodeSha256: cfg.CodeSha256 });
    setDesc('');
    toast(`Published version ${out.Version}`);
  }, null);
  const delVersion = (v) => {
    const used = aliases.filter((a) => a.FunctionVersion === v || a.RoutingConfig?.AdditionalVersionWeights?.[v] !== undefined);
    if (used.length) return setError(`Version ${v} is used by alias ${used.map((a) => a.Name).join(', ')}; point the alias elsewhere first.`);
    if (window.confirm(`Delete version ${v}? This cannot be undone.`)) act(() => lambda('DeleteFunction', { FunctionName: name, Qualifier: v }), `Deleted version ${v}`);
  };
  const delAlias = (a) => window.confirm(`Delete alias ${a.Name}? Callers using ${name}:${a.Name} will fail.`) && act(() => lambda('DeleteAlias', { FunctionName: name, Name: a.Name }), `Deleted alias ${a.Name}`);

  return (
    <>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="card">
        <div className="card-head">
          <h3>Aliases ({aliases.length})</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>＋ Create alias</button>
        </div>
        <div className="muted small">An alias is a stable name (e.g. <code>live</code>) pointing to a version, optionally splitting traffic with a second version (canary).</div>
        {aliases.length > 0 && (
          <table className="grid grid-plain mt-s">
            <thead><tr><th>Name</th><th>Version</th><th>Weighted routing</th><th>Description</th><th /></tr></thead>
            <tbody>
              {aliases.map((a) => {
                const w = Object.entries(a.RoutingConfig?.AdditionalVersionWeights || {});
                return (
                  <tr key={a.Name}>
                    <td><strong>{a.Name}</strong></td>
                    <td>{a.FunctionVersion}</td>
                    <td className="small">{w.length ? w.map(([v, x]) => `${Math.round((1 - x) * 100)}% → ${a.FunctionVersion}, ${Math.round(x * 100)}% → ${v}`).join('; ') : '—'}</td>
                    <td className="small">{a.Description || '—'}</td>
                    <td className="row-actions">
                      <button className="btn btn-xs" onClick={() => setQualifier(a.Name)}>Select</button>
                      <button className="btn btn-xs" title="Copy ARN" onClick={() => copyText(a.AliasArn).then(() => toast('ARN copied'))}>⧉</button>
                      <button className="btn btn-xs" onClick={() => setEditing(a)}>Edit</button>
                      <button className="btn btn-xs btn-danger" onClick={() => delAlias(a)} disabled={busy}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h3>Versions ({published.length})</h3></div>
        <div className="muted small">Publishing freezes the current code and configuration of $LATEST as an immutable, numbered version.</div>
        <div className="row-gap mt-s">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Version description (optional)" aria-label="Version description" className="grow" />
          <button className="btn btn-primary" onClick={publish} disabled={busy}>{busy ? <Spinner /> : 'Publish new version'}</button>
        </div>
        {published.length > 0 && (
          <table className="grid grid-plain mt-s">
            <thead><tr><th>Version</th><th>Description</th><th>Runtime</th><th>Code SHA-256</th><th>Created</th><th /></tr></thead>
            <tbody>
              {published.map((v) => (
                <tr key={v.Version}>
                  <td><strong>{v.Version}</strong> {aliases.filter((a) => a.FunctionVersion === v.Version).map((a) => <span key={a.Name} className="badge">{a.Name}</span>)}</td>
                  <td className="small">{v.Description || '—'}</td>
                  <td className="small">{v.Runtime || v.PackageType}</td>
                  <td className="mono small ellipsis" title={v.CodeSha256}>{String(v.CodeSha256 || '').slice(0, 12)}…</td>
                  <td className="small">{fmtDate(parseLastModified(v.LastModified))}</td>
                  <td className="row-actions">
                    <button className="btn btn-xs" onClick={() => setQualifier(v.Version)}>Select</button>
                    <button className="btn btn-xs btn-danger" onClick={() => delVersion(v.Version)} disabled={busy}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <AliasModal fn={name} alias={editing === 'new' ? null : editing} versions={versionNames} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast('Alias saved'); reloadVersions(); }} />
      )}
    </>
  );
}

// --- Function URL -------------------------------------------------------------------------------------------
const csv = (a) => (a || []).join(', ');
const fromCsv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function UrlTab({ name, qualifier }) {
  const toast = useToast();
  const [url, setUrl] = useState(undefined);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const target = qualifier ? { Qualifier: qualifier } : {};

  const toForm = (c) => ({
    AuthType: c?.AuthType || 'AWS_IAM',
    InvokeMode: c?.InvokeMode || 'BUFFERED',
    cors: Boolean(c?.Cors && Object.keys(c.Cors).length),
    AllowOrigins: csv(c?.Cors?.AllowOrigins) || '*',
    AllowMethods: csv(c?.Cors?.AllowMethods) || '*',
    AllowHeaders: csv(c?.Cors?.AllowHeaders),
    ExposeHeaders: csv(c?.Cors?.ExposeHeaders),
    MaxAge: String(c?.Cors?.MaxAge ?? ''),
    AllowCredentials: Boolean(c?.Cors?.AllowCredentials),
  });

  const load = useCallback(async () => {
    try {
      const c = await lambda('GetFunctionUrlConfig', { FunctionName: name, ...(qualifier ? { Qualifier: qualifier } : {}) });
      setUrl(c);
      setForm(toForm(c));
    } catch (e) {
      setUrl(null);
      setForm(toForm(null));
      if (!notFound(e)) setError(errorText(e));
    }
  }, [name, qualifier]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = {
        FunctionName: name,
        ...target,
        AuthType: form.AuthType,
        InvokeMode: form.InvokeMode,
        Cors: form.cors
          ? {
              AllowOrigins: fromCsv(form.AllowOrigins),
              AllowMethods: fromCsv(form.AllowMethods),
              AllowHeaders: fromCsv(form.AllowHeaders),
              ExposeHeaders: fromCsv(form.ExposeHeaders),
              AllowCredentials: form.AllowCredentials,
              ...(form.MaxAge ? { MaxAge: Number(form.MaxAge) } : {}),
            }
          : {},
      };
      await lambda(url ? 'UpdateFunctionUrlConfig' : 'CreateFunctionUrlConfig', input);
      // Public URLs also need a resource policy statement, like the console adds.
      if (form.AuthType === 'NONE' && (!url || url.AuthType !== 'NONE')) {
        const add = (StatementId, extra) => lambda('AddPermission', { FunctionName: name, ...target, StatementId, Principal: '*', ...extra }).catch((e) => { if (!/already exists/i.test(e.message)) throw e; });
        await add('FunctionURLAllowPublicAccess', { Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'NONE' });
        await add('FunctionURLAllowInvokeAction', { Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true });
      }
      toast(url ? 'Function URL updated' : 'Function URL created');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm('Delete the function URL? Clients using it will get errors.')) return;
    setBusy(true);
    try {
      await lambda('DeleteFunctionUrlConfig', { FunctionName: name, ...target });
      for (const sid of ['FunctionURLAllowPublicAccess', 'FunctionURLAllowInvokeAction']) await lambda('RemovePermission', { FunctionName: name, ...target, StatementId: sid }).catch(() => {});
      toast('Function URL deleted');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (url === undefined || !form) return <Spinner />;
  const set = (p) => setForm({ ...form, ...p });
  return (
    <div className="card">
      <div className="card-head">
        <h3>Function URL {qualifier && <span className="badge">{qualifier}</span>}</h3>
        {url && <button className="btn btn-sm btn-danger" onClick={remove} disabled={busy}>Delete URL</button>}
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {url ? (
        <div className="row-gap wrap fn-url">
          <a href={url.FunctionUrl} target="_blank" rel="noreferrer" className="mono">{url.FunctionUrl}</a>
          <button className="btn btn-xs" onClick={() => copyText(url.FunctionUrl).then(() => toast('URL copied'))}>⧉ Copy</button>
          <span className="muted small">created {fmtDate(url.CreationTime)}</span>
        </div>
      ) : (
        <div className="muted small">A dedicated HTTPS endpoint for the function, without API Gateway.</div>
      )}
      <div className="grid-2 mt-s">
        <Field label="Auth type" hint={form.AuthType === 'NONE' ? <span className="text-warn">Anyone on the internet can call the function. A public permission is added to the policy.</span> : 'Callers must sign requests with SigV4 and have lambda:InvokeFunctionUrl.'}>
          <Select value={form.AuthType} onChange={(AuthType) => set({ AuthType })} options={[['AWS_IAM', 'AWS_IAM'], ['NONE', 'NONE (public)']]} aria-label="Auth type" />
        </Field>
        <Field label="Invoke mode"><Select value={form.InvokeMode} onChange={(InvokeMode) => set({ InvokeMode })} options={[['BUFFERED', 'BUFFERED (default)'], ['RESPONSE_STREAM', 'RESPONSE_STREAM']]} aria-label="Invoke mode" /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={form.cors} onChange={(e) => set({ cors: e.target.checked })} /> Configure CORS</label>
      {form.cors && (
        <div className="grid-2 mt-s">
          <Field label="Allow origins" hint="Comma separated, * = any"><input value={form.AllowOrigins} onChange={(e) => set({ AllowOrigins: e.target.value })} aria-label="Allow origins" /></Field>
          <Field label="Allow methods"><input value={form.AllowMethods} onChange={(e) => set({ AllowMethods: e.target.value })} aria-label="Allow methods" placeholder="GET, POST" /></Field>
          <Field label="Allow headers"><input value={form.AllowHeaders} onChange={(e) => set({ AllowHeaders: e.target.value })} aria-label="Allow headers" placeholder="content-type, authorization" /></Field>
          <Field label="Expose headers"><input value={form.ExposeHeaders} onChange={(e) => set({ ExposeHeaders: e.target.value })} aria-label="Expose headers" /></Field>
          <Field label="Max age (s)"><input type="number" min={0} max={86400} value={form.MaxAge} onChange={(e) => set({ MaxAge: e.target.value })} aria-label="Max age" /></Field>
          <label className="check check-field"><input type="checkbox" checked={form.AllowCredentials} onChange={(e) => set({ AllowCredentials: e.target.checked })} /> Allow credentials</label>
        </div>
      )}
      <button className="btn btn-primary mt-s" onClick={save} disabled={busy}>{busy ? <Spinner /> : url ? 'Save' : 'Create function URL'}</button>
      {url && <div className="muted small mt-s">Try it: <code>curl {form.AuthType === 'NONE' ? '' : '--aws-sigv4 "aws:amz:REGION:lambda" --user "$KEY:$SECRET" '}{url.FunctionUrl}</code> · {arnTail(url.FunctionArn)}</div>}
    </div>
  );
}
