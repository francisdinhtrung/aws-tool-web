import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { Spinner, ErrorBox, Field, Select, useToast, download, Modal } from './ui.jsx';
import { KeyValueRows } from './SqsModals.jsx';
import {
  lambda, listAll, RUNTIMES, configErrors, envFromRows, envToRows, parseDotEnv, tagDiff, roleNameFromArn, fmtTimeout, fmtMemory, LIMITS, arnTail,
} from '../lib/lambda.js';

const list = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const same = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Picks a layer version from ListLayers / ListLayerVersions, or takes a pasted ARN. */
function LayerPicker({ runtime, arch, onAdd, onClose }) {
  const [layers, setLayers] = useState(null);
  const [layer, setLayer] = useState('');
  const [versions, setVersions] = useState([]);
  const [arn, setArn] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    listAll('ListLayers', { MaxItems: 50 }, 'Layers').then(setLayers).catch((e) => { setLayers([]); setError(errorText(e)); });
  }, []);
  useEffect(() => {
    if (!layer) return setVersions([]);
    listAll('ListLayerVersions', { LayerName: layer, MaxItems: 50 }, 'LayerVersions').then((v) => {
      setVersions(v);
      setArn(v[0]?.LayerVersionArn || '');
    }).catch((e) => setError(errorText(e)));
  }, [layer]);
  const fits = (v) => (!v.CompatibleRuntimes?.length || !runtime || v.CompatibleRuntimes.includes(runtime)) && (!v.CompatibleArchitectures?.length || v.CompatibleArchitectures.includes(arch));
  return (
    <Modal title="Add layer" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!/^arn:/.test(arn)} onClick={() => onAdd(arn.trim())}>Add</button></>}>
      <ErrorBox error={error} />
      <Field label="Layer in this account">
        {layers === null ? <Spinner /> : <Select value={layer} onChange={setLayer} options={[['', layers.length ? '— choose —' : '— no layers —'], ...layers.map((l) => l.LayerName)]} aria-label="Layer" />}
      </Field>
      {versions.length > 0 && (
        <Field label="Version">
          <Select value={arn} onChange={setArn} options={versions.map((v) => [v.LayerVersionArn, `${v.Version}${v.Description ? ` – ${v.Description}` : ''}${fits(v) ? '' : ' (not compatible)'}`])} aria-label="Layer version" />
        </Field>
      )}
      <Field label="Layer version ARN" hint="Or paste any layer version ARN (public layers too).">
        <input value={arn} onChange={(e) => setArn(e.target.value)} aria-label="Layer ARN" placeholder="arn:aws:lambda:us-east-1:123456789012:layer:name:1" />
      </Field>
    </Modal>
  );
}

const fromCfg = (cfg) => ({
  Description: cfg.Description || '',
  Handler: cfg.Handler || '',
  Runtime: cfg.Runtime || '',
  MemorySize: String(cfg.MemorySize || ''),
  Timeout: String(cfg.Timeout || ''),
  EphemeralStorage: String(cfg.EphemeralStorage?.Size || 512),
  Role: cfg.Role || '',
  Layers: (cfg.Layers || []).map((l) => l.Arn),
  SubnetIds: (cfg.VpcConfig?.SubnetIds || []).join(', '),
  SecurityGroupIds: (cfg.VpcConfig?.SecurityGroupIds || []).join(', '),
  Ipv6: Boolean(cfg.VpcConfig?.Ipv6AllowedForDualStack),
  Tracing: cfg.TracingConfig?.Mode || 'PassThrough',
  LogFormat: cfg.LoggingConfig?.LogFormat || 'Text',
  LogGroup: cfg.LoggingConfig?.LogGroup || '',
  AppLevel: cfg.LoggingConfig?.ApplicationLogLevel || '',
  SysLevel: cfg.LoggingConfig?.SystemLogLevel || '',
  Dlq: cfg.DeadLetterConfig?.TargetArn || '',
  Kms: cfg.KMSKeyArn || '',
  SnapStart: cfg.SnapStart?.ApplyOn || 'None',
});

/** UpdateFunctionConfiguration input with the fields that changed. */
export function configChanges(cfg, v) {
  const o = fromCfg(cfg);
  const out = {};
  if (v.Description !== o.Description) out.Description = v.Description;
  if (cfg.PackageType !== 'Image') {
    if (v.Handler !== o.Handler) out.Handler = v.Handler;
    if (v.Runtime !== o.Runtime) out.Runtime = v.Runtime;
  }
  if (v.MemorySize !== o.MemorySize) out.MemorySize = Number(v.MemorySize);
  if (v.Timeout !== o.Timeout) out.Timeout = Number(v.Timeout);
  if (v.EphemeralStorage !== o.EphemeralStorage) out.EphemeralStorage = { Size: Number(v.EphemeralStorage) };
  if (v.Role !== o.Role) out.Role = v.Role;
  if (!same(v.Layers, o.Layers)) out.Layers = v.Layers;
  if (v.SubnetIds !== o.SubnetIds || v.SecurityGroupIds !== o.SecurityGroupIds || v.Ipv6 !== o.Ipv6) {
    out.VpcConfig = { SubnetIds: list(v.SubnetIds), SecurityGroupIds: list(v.SecurityGroupIds), ...(list(v.SubnetIds).length ? { Ipv6AllowedForDualStack: v.Ipv6 } : {}) };
  }
  if (v.Tracing !== o.Tracing) out.TracingConfig = { Mode: v.Tracing };
  if (v.LogFormat !== o.LogFormat || v.LogGroup !== o.LogGroup || v.AppLevel !== o.AppLevel || v.SysLevel !== o.SysLevel) {
    out.LoggingConfig = { LogFormat: v.LogFormat, ...(v.LogGroup ? { LogGroup: v.LogGroup } : {}) };
    if (v.LogFormat === 'JSON') Object.assign(out.LoggingConfig, v.AppLevel ? { ApplicationLogLevel: v.AppLevel } : {}, v.SysLevel ? { SystemLogLevel: v.SysLevel } : {});
  }
  if (v.Dlq !== o.Dlq) out.DeadLetterConfig = { TargetArn: v.Dlq.trim() };
  if (v.Kms !== o.Kms) out.KMSKeyArn = v.Kms.trim();
  if (v.SnapStart !== o.SnapStart) out.SnapStart = { ApplyOn: v.SnapStart };
  return out;
}

const LEVELS = ['', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

export function GeneralTab({ name, cfg, refresh }) {
  const toast = useToast();
  const [v, setV] = useState(() => fromCfg(cfg));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [addingLayer, setAddingLayer] = useState(false);
  const set = (p) => setV((x) => ({ ...x, ...p }));
  const errs = configErrors(v);
  const changes = configChanges(cfg, v);
  const dirty = Object.keys(changes).length;
  const image = cfg.PackageType === 'Image';
  const updating = cfg.LastUpdateStatus === 'InProgress' || cfg.State === 'Pending';

  useEffect(() => setV(fromCfg(cfg)), [cfg]);

  const save = async () => {
    if (Object.keys(errs).length) return setError(Object.values(errs)[0]);
    setBusy(true);
    setError(null);
    try {
      await lambda('UpdateFunctionConfiguration', { FunctionName: name, ...changes });
      toast('Configuration update started');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const runtimes = [...new Set([v.Runtime, ...RUNTIMES.map((r) => r[0])].filter(Boolean))].map((r) => [r, RUNTIMES.find((x) => x[0] === r)?.[1] || `${r} (deprecated)`]);
  const roleUrl = `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(roleNameFromArn(cfg.Role))}`;

  return (
    <>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid-2 cards">
        <div className="card">
          <div className="card-head"><h3>General</h3></div>
          <Field label="Description"><input value={v.Description} onChange={(e) => set({ Description: e.target.value })} aria-label="Description" /></Field>
          {!image && (
            <div className="grid-2">
              <Field label="Runtime"><Select value={v.Runtime} onChange={(Runtime) => set({ Runtime })} options={runtimes} aria-label="Runtime" /></Field>
              <Field label="Handler"><input value={v.Handler} onChange={(e) => set({ Handler: e.target.value })} aria-label="Handler" /></Field>
            </div>
          )}
          <div className="grid-3">
            <Field label="Memory (MB)" hint={errs.MemorySize ? <span className="text-bad">{errs.MemorySize}</span> : `${LIMITS.memory.join(' – ')} · ${fmtMemory(Number(v.MemorySize))}. CPU scales with memory.`}>
              <input type="number" min={128} max={10240} value={v.MemorySize} onChange={(e) => set({ MemorySize: e.target.value })} aria-label="Memory" />
            </Field>
            <Field label="Timeout (s)" hint={errs.Timeout ? <span className="text-bad">{errs.Timeout}</span> : `1 – 900 · ${fmtTimeout(Number(v.Timeout))}`}>
              <input type="number" min={1} max={900} value={v.Timeout} onChange={(e) => set({ Timeout: e.target.value })} aria-label="Timeout" />
            </Field>
            <Field label="Ephemeral storage /tmp (MB)" hint={errs.EphemeralStorage ? <span className="text-bad">{errs.EphemeralStorage}</span> : '512 – 10240'}>
              <input type="number" min={512} max={10240} value={v.EphemeralStorage} onChange={(e) => set({ EphemeralStorage: e.target.value })} aria-label="Ephemeral storage" />
            </Field>
          </div>
          <Field label="Execution role" hint={<>Lambda assumes this role to run the function. <a href={roleUrl} target="_blank" rel="noreferrer">Open in IAM ↗</a></>}>
            <input value={v.Role} onChange={(e) => set({ Role: e.target.value })} aria-label="Execution role" />
          </Field>
          <div className="muted small">Architecture <strong>{(cfg.Architectures || ['x86_64']).join(', ')}</strong> can only change together with new code (Code tab → upload).</div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Monitoring & logging</h3></div>
          <div className="grid-2">
            <Field label="X-Ray tracing"><Select value={v.Tracing} onChange={(Tracing) => set({ Tracing })} options={[['PassThrough', 'Off (pass through)'], ['Active', 'Active']]} aria-label="Tracing" /></Field>
            <Field label="Log format"><Select value={v.LogFormat} onChange={(LogFormat) => set({ LogFormat })} options={['Text', 'JSON']} aria-label="Log format" /></Field>
          </div>
          {v.LogFormat === 'JSON' && (
            <div className="grid-2">
              <Field label="Application log level"><Select value={v.AppLevel} onChange={(AppLevel) => set({ AppLevel })} options={LEVELS.map((l) => [l, l || '(default INFO)'])} aria-label="Application log level" /></Field>
              <Field label="System log level"><Select value={v.SysLevel} onChange={(SysLevel) => set({ SysLevel })} options={LEVELS.filter((l) => ['', 'DEBUG', 'INFO', 'WARN'].includes(l)).map((l) => [l, l || '(default INFO)'])} aria-label="System log level" /></Field>
            </div>
          )}
          <Field label="Log group" hint={`Empty = /aws/lambda/${name}`}><input value={v.LogGroup} onChange={(e) => set({ LogGroup: e.target.value })} aria-label="Log group" placeholder={`/aws/lambda/${name}`} /></Field>
          <h4>Error handling & encryption</h4>
          <Field label="Dead-letter queue (async)" hint="SQS queue or SNS topic ARN for failed asynchronous events. Empty = none.">
            <input value={v.Dlq} onChange={(e) => set({ Dlq: e.target.value })} aria-label="Dead-letter queue" placeholder="arn:aws:sqs:us-east-1:123456789012:dlq" />
          </Field>
          <Field label="KMS key for environment variables" hint="Empty = AWS managed key."><input value={v.Kms} onChange={(e) => set({ Kms: e.target.value })} aria-label="KMS key" /></Field>
          {/^(java|python3\.1[2-9]|dotnet8)/.test(cfg.Runtime || '') && (
            <Field label="SnapStart" hint="Snapshots initialized published versions to cut cold starts.">
              <Select value={v.SnapStart} onChange={(SnapStart) => set({ SnapStart })} options={[['None', 'Off'], ['PublishedVersions', 'Published versions']]} aria-label="SnapStart" />
            </Field>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Layers ({v.Layers.length}/5)</h3>
            <button className="btn btn-xs" onClick={() => setAddingLayer(true)} disabled={v.Layers.length >= 5 || image}>＋ Add layer</button>
          </div>
          {image && <div className="muted small">Container image functions cannot use layers.</div>}
          {!v.Layers.length && !image && <div className="muted small">No layers. Layers share libraries, a custom runtime or config between functions.</div>}
          {v.Layers.map((arn, i) => (
            <div key={arn} className="row-gap fn-layer">
              <span className="muted small">{i + 1}.</span>
              <code className="grow ellipsis" title={arn}>{arn.split(':').slice(-2).join(':')}</code>
              <button className="icon-btn" title="Move up" disabled={!i} onClick={() => set({ Layers: v.Layers.map((x, j) => (j === i - 1 ? arn : j === i ? v.Layers[i - 1] : x)) })}>↑</button>
              <button className="icon-btn" title="Remove" onClick={() => set({ Layers: v.Layers.filter((x) => x !== arn) })}>×</button>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head"><h3>VPC</h3></div>
          <div className="muted small">Attach the function to private subnets to reach RDS, ElastiCache… Internet access then needs a NAT gateway. Clear both fields to detach.</div>
          <Field label="Subnet IDs" hint="Comma or space separated"><input value={v.SubnetIds} onChange={(e) => set({ SubnetIds: e.target.value })} aria-label="Subnet IDs" placeholder="subnet-0abc, subnet-0def" /></Field>
          <Field label="Security group IDs"><input value={v.SecurityGroupIds} onChange={(e) => set({ SecurityGroupIds: e.target.value })} aria-label="Security group IDs" placeholder="sg-0123" /></Field>
          <label className="check"><input type="checkbox" checked={v.Ipv6} onChange={(e) => set({ Ipv6: e.target.checked })} /> Allow IPv6 for dual-stack subnets</label>
          {cfg.VpcConfig?.VpcId && <div className="muted small mt-s">VPC <code>{cfg.VpcConfig.VpcId}</code></div>}
          {cfg.FileSystemConfigs?.length > 0 && (
            <div className="small mt-s">EFS: {cfg.FileSystemConfigs.map((f) => <div key={f.Arn}><code>{arnTail(f.Arn)}</code> → <code>{f.LocalMountPath}</code></div>)}</div>
          )}
        </div>
      </div>
      <div className="row-gap mt-s fn-save-bar">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || updating}>{busy ? <Spinner /> : `Save${dirty ? ` (${dirty} change${dirty === 1 ? '' : 's'})` : ''}`}</button>
        <button className="btn" onClick={() => setV(fromCfg(cfg))} disabled={!dirty}>Reset</button>
        {updating && <span className="muted small"><Spinner /> Update in progress…</span>}
      </div>
      {addingLayer && (
        <LayerPicker
          runtime={cfg.Runtime}
          arch={(cfg.Architectures || ['x86_64'])[0]}
          onClose={() => setAddingLayer(false)}
          onAdd={(arn) => {
            const base = arn.split(':').slice(0, -1).join(':');
            set({ Layers: [...v.Layers.filter((x) => x.split(':').slice(0, -1).join(':') !== base), arn] });
            setAddingLayer(false);
          }}
        />
      )}
    </>
  );
}

// --- Environment -------------------------------------------------------------------------------------
export function EnvTab({ name, cfg, refresh }) {
  const toast = useToast();
  const orig = cfg.Environment?.Variables || {};
  const [rows, setRows] = useState(() => envToRows(orig));
  const [hidden, setHidden] = useState(true);
  const [paste, setPaste] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(cfg.Environment?.Error ? `${cfg.Environment.Error.ErrorCode}: ${cfg.Environment.Error.Message}` : null);

  useEffect(() => setRows(envToRows(cfg.Environment?.Variables || {})), [cfg]);

  let next = null;
  let invalid = null;
  try {
    next = envFromRows(rows);
  } catch (e) {
    invalid = e.message;
  }
  const dirty = next && JSON.stringify(next) !== JSON.stringify(orig);

  const save = async () => {
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      await lambda('UpdateFunctionConfiguration', { FunctionName: name, Environment: { Variables: next } });
      toast('Environment variables saved');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const merge = (added) => {
    const map = new Map(rows.map((r) => [r.key, r]));
    for (const r of added) map.set(r.key, r);
    setRows([...map.values()]);
  };
  const toDotEnv = () => Object.entries(next || orig).map(([k, val]) => `${k}=${/[\s#"']/.test(val) ? JSON.stringify(val) : val}`).join('\n');

  return (
    <div className="card">
      <div className="card-head">
        <h3>Environment variables <span className="muted">({rows.filter((r) => r.key).length})</span></h3>
        <div className="row-gap">
          <button className="btn btn-xs" onClick={() => setHidden(!hidden)}>{hidden ? 'Show values' : 'Hide values'}</button>
          <button className="btn btn-xs" onClick={() => setPaste('')}>Import .env</button>
          <button className="btn btn-xs" onClick={() => download(`${name}.env`, toDotEnv(), 'text/plain')}>Export .env</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className={hidden ? 'env-hidden' : ''}>
        <KeyValueRows rows={rows} onChange={setRows} keyLabel="Key" valueLabel="Value" />
      </div>
      {invalid && <div className="text-bad small mt-s">{invalid}</div>}
      <div className="muted small mt-s">Values are visible to anyone who can read the function configuration. Keep secrets in Secrets Manager or Parameter Store. Total size limit: 4 KB.</div>
      <div className="row-gap mt-s">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || Boolean(invalid)}>{busy ? <Spinner /> : 'Save'}</button>
        <button className="btn" onClick={() => setRows(envToRows(orig))} disabled={!dirty}>Reset</button>
      </div>
      {paste !== null && (
        <Modal title="Import .env" onClose={() => setPaste(null)} footer={<><button className="btn" onClick={() => setPaste(null)}>Cancel</button><button className="btn btn-primary" onClick={() => { merge(parseDotEnv(paste)); setPaste(null); }}>Merge</button></>}>
          <div className="muted small">KEY=VALUE per line. Existing keys are overwritten; nothing is saved until you click Save.</div>
          <textarea className="mono" rows={12} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label=".env content" />
        </Modal>
      )}
    </div>
  );
}

// --- Concurrency & asynchronous invocation ---------------------------------------------------------------
export function ConcurrencyTab({ name, fn, refresh, qualifier, aliases, versionNames }) {
  const toast = useToast();
  const reserved = fn.Concurrency?.ReservedConcurrentExecutions;
  const [value, setValue] = useState(reserved ?? '');
  const [prov, setProv] = useState(null);
  const [newProv, setNewProv] = useState({ q: '', n: '1' });
  const [asyncCfg, setAsyncCfg] = useState(undefined);
  const [form, setForm] = useState({ retries: '2', age: '21600', onSuccess: '', onFailure: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadProv = useCallback(() => listAll('ListProvisionedConcurrencyConfigs', { FunctionName: name, MaxItems: 50 }, 'ProvisionedConcurrencyConfigs').then(setProv).catch((e) => setProv({ error: errorText(e) })), [name]);
  const loadAsync = useCallback(async () => {
    try {
      const c = await lambda('GetFunctionEventInvokeConfig', { FunctionName: name, ...(qualifier ? { Qualifier: qualifier } : {}) });
      setAsyncCfg(c);
      setForm({ retries: String(c.MaximumRetryAttempts ?? 2), age: String(c.MaximumEventAgeInSeconds ?? 21600), onSuccess: c.DestinationConfig?.OnSuccess?.Destination || '', onFailure: c.DestinationConfig?.OnFailure?.Destination || '' });
    } catch (e) {
      if (e.status === 404 || e.name === 'ResourceNotFoundException') {
        setAsyncCfg(null);
        setForm({ retries: '2', age: '21600', onSuccess: '', onFailure: '' });
      } else setError(errorText(e));
    }
  }, [name, qualifier]);
  useEffect(() => {
    loadProv();
    loadAsync();
  }, [loadProv, loadAsync]);
  useEffect(() => setValue(reserved ?? ''), [reserved]);

  const act = async (fnc, msg) => {
    setBusy(true);
    setError(null);
    try {
      await fnc();
      if (msg) toast(msg);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const saveReserved = () =>
    act(async () => {
      if (value === '') await lambda('DeleteFunctionConcurrency', { FunctionName: name });
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error('Reserved concurrency must be a whole number ≥ 0');
        await lambda('PutFunctionConcurrency', { FunctionName: name, ReservedConcurrentExecutions: n });
      }
      await refresh();
    }, value === '' ? 'Reserved concurrency removed' : 'Reserved concurrency saved');
  const throttle = () => {
    if (!window.confirm(`Throttle ${name}? Reserved concurrency becomes 0 and every invocation fails until you remove it.`)) return;
    act(async () => {
      await lambda('PutFunctionConcurrency', { FunctionName: name, ReservedConcurrentExecutions: 0 });
      await refresh();
    }, 'Function throttled');
  };
  const addProv = () =>
    act(async () => {
      if (!newProv.q) throw new Error('Choose an alias or version');
      await lambda('PutProvisionedConcurrencyConfig', { FunctionName: name, Qualifier: newProv.q, ProvisionedConcurrentExecutions: Number(newProv.n) });
      await loadProv();
    }, 'Provisioned concurrency is being allocated');
  const delProv = (q) => window.confirm(`Remove provisioned concurrency from ${q}?`) && act(async () => { await lambda('DeleteProvisionedConcurrencyConfig', { FunctionName: name, Qualifier: q }); await loadProv(); }, 'Removed');
  const saveAsync = () =>
    act(async () => {
      const r = Number(form.retries);
      const a = Number(form.age);
      if (!(r >= 0 && r <= 2)) throw new Error('Retry attempts must be 0, 1 or 2');
      if (!(a >= 60 && a <= 21600)) throw new Error('Maximum event age must be between 60 and 21600 seconds');
      const DestinationConfig = {
        OnSuccess: form.onSuccess.trim() ? { Destination: form.onSuccess.trim() } : {},
        OnFailure: form.onFailure.trim() ? { Destination: form.onFailure.trim() } : {},
      };
      await lambda('PutFunctionEventInvokeConfig', { FunctionName: name, ...(qualifier ? { Qualifier: qualifier } : {}), MaximumRetryAttempts: r, MaximumEventAgeInSeconds: a, DestinationConfig });
      await loadAsync();
    }, 'Asynchronous invocation settings saved');
  const resetAsync = () => act(async () => { await lambda('DeleteFunctionEventInvokeConfig', { FunctionName: name, ...(qualifier ? { Qualifier: qualifier } : {}) }); await loadAsync(); }, 'Reset to defaults');
  const qualifiers = [...aliases.map((a) => a.Name), ...versionNames.filter((v) => v !== '$LATEST')];

  return (
    <>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid-2 cards">
        <div className="card">
          <div className="card-head"><h3>Reserved concurrency</h3>{reserved === 0 && <span className="badge badge-bad">Throttled</span>}</div>
          <div className="muted small">Guarantees and caps how many instances can run at once. Empty = use the unreserved account pool.</div>
          <div className="row-gap mt-s">
            <input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Unreserved" aria-label="Reserved concurrency" />
            <button className="btn btn-primary" onClick={saveReserved} disabled={busy}>Save</button>
            <button className="btn btn-danger" onClick={throttle} disabled={busy || reserved === 0}>Throttle</button>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Provisioned concurrency</h3><button className="btn btn-xs" onClick={loadProv}>↻</button></div>
          <div className="muted small">Keeps instances initialized to remove cold starts (billed while allocated). Needs an alias or a published version.</div>
          {prov?.error && <div className="text-bad small mt-s">{prov.error}</div>}
          {prov === null ? <Spinner /> : prov.length > 0 && (
            <table className="grid grid-plain mt-s">
              <thead><tr><th>Qualifier</th><th>Requested</th><th>Available</th><th>Status</th><th /></tr></thead>
              <tbody>
                {prov.map((p) => {
                  const q = p.FunctionArn.split(':').pop();
                  return (
                    <tr key={p.FunctionArn}>
                      <td>{q}</td>
                      <td>{p.RequestedProvisionedConcurrentExecutions}</td>
                      <td>{p.AvailableProvisionedConcurrentExecutions ?? '—'}</td>
                      <td><span className={`badge${p.Status === 'READY' ? ' badge-ok' : p.Status === 'FAILED' ? ' badge-bad' : ''}`} title={p.StatusReason}>{p.Status}</span></td>
                      <td><button className="btn btn-xs" onClick={() => delProv(q)}>Remove</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="row-gap mt-s">
            <Select value={newProv.q} onChange={(q) => setNewProv({ ...newProv, q })} options={[['', qualifiers.length ? '— alias / version —' : '— publish a version first —'], ...qualifiers]} aria-label="Provisioned qualifier" />
            <input type="number" min={1} value={newProv.n} onChange={(e) => setNewProv({ ...newProv, n: e.target.value })} aria-label="Provisioned count" />
            <button className="btn" onClick={addProv} disabled={busy || !newProv.q}>Add</button>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Asynchronous invocation{qualifier ? ` (${qualifier})` : ''}</h3>
          {asyncCfg === null && <span className="muted small">Defaults: 2 retries, 6 hours</span>}
        </div>
        <div className="muted small">Applies to events from S3, SNS, EventBridge and <code>InvocationType=Event</code>. Destinations receive a record of each success or failure.</div>
        {asyncCfg === undefined ? <Spinner /> : (
          <>
            <div className="grid-2 mt-s">
              <Field label="Retry attempts" hint="0 – 2"><input type="number" min={0} max={2} value={form.retries} onChange={(e) => setForm({ ...form, retries: e.target.value })} aria-label="Retry attempts" /></Field>
              <Field label="Maximum event age (s)" hint="60 – 21600 (6 hours)"><input type="number" min={60} max={21600} value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} aria-label="Maximum event age" /></Field>
              <Field label="On success destination" hint="SQS, SNS, Lambda or EventBridge ARN"><input value={form.onSuccess} onChange={(e) => setForm({ ...form, onSuccess: e.target.value })} aria-label="On success destination" /></Field>
              <Field label="On failure destination" hint="SQS, SNS, Lambda, EventBridge or S3 ARN"><input value={form.onFailure} onChange={(e) => setForm({ ...form, onFailure: e.target.value })} aria-label="On failure destination" /></Field>
            </div>
            <div className="row-gap">
              <button className="btn btn-primary" onClick={saveAsync} disabled={busy}>Save</button>
              {asyncCfg && <button className="btn" onClick={resetAsync} disabled={busy}>Reset to defaults</button>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// --- Tags ------------------------------------------------------------------------------------------------
export function TagsTab({ cfg }) {
  const toast = useToast();
  const arn = cfg.FunctionArn;
  const [orig, setOrig] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = (await lambda('ListTags', { Resource: arn })).Tags || {};
      setOrig(t);
      setRows(envToRows(t));
    } catch (e) {
      setError(errorText(e));
      setOrig({});
    }
  }, [arn]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
      const { set, remove } = tagDiff(orig, next);
      if (remove.length) await lambda('UntagResource', { Resource: arn, TagKeys: remove });
      if (Object.keys(set).length) await lambda('TagResource', { Resource: arn, Tags: set });
      toast('Tags saved');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (!orig) return <Spinner />;
  return (
    <div className="card">
      <div className="card-head"><h3>Tags</h3></div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <KeyValueRows rows={rows} onChange={setRows} />
      <button className="btn btn-primary mt-s" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save tags'}</button>
    </div>
  );
}
