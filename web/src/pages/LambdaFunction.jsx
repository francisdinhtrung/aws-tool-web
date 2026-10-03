import React, { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Tabs, Spinner, ErrorBox, useToast, copyText, useLocalStorage } from '../components/ui.jsx';
import { confirmDeleteFunction, StateBadge } from './LambdaFunctions.jsx';
import CodeTab from '../components/LambdaCode.jsx';
import TestTab from '../components/LambdaTest.jsx';
import MonitorTab from '../components/LambdaMonitor.jsx';
import { GeneralTab, EnvTab, ConcurrencyTab, TagsTab } from '../components/LambdaConfig.jsx';
import { TriggersTab, PermissionsTab, VersionsTab, UrlTab } from '../components/LambdaAccess.jsx';
import { lambda, listAll, fmtMemory, fmtTimeout, fmtBytes, fmtDate, parseLastModified, logGroupOf, stateOf } from '../lib/lambda.js';
import { logsGroupPath } from '../lib/logs.js';

const TABS = [
  ['code', 'Code'],
  ['test', 'Test'],
  ['monitor', 'Monitor'],
  ['config', 'Configuration'],
  ['env', 'Environment'],
  ['triggers', 'Triggers'],
  ['permissions', 'Permissions'],
  ['versions', 'Versions & aliases'],
  ['url', 'Function URL'],
  ['concurrency', 'Concurrency & async'],
  ['tags', 'Tags'],
];

export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Stat({ label, value, hint, strong }) {
  return (
    <div className="sqs-stat" title={hint}>
      <div className="sqs-stat-label">{label}</div>
      <div className={`sqs-stat-value${strong ? ' strong' : ''}`}>{value}</div>
    </div>
  );
}

export default function LambdaFunction({ name }) {
  const { reloadFunctions } = useApp();
  const toast = useToast();
  const [fn, setFn] = useState(null); // GetFunction output
  const [error, setError] = useState(null);
  const [tab, setTab] = useLocalStorage('ddbs.lambda.tab', 'code');
  const [qualifier, setQualifier] = useState('');
  const [versions, setVersions] = useState([]);
  const [aliases, setAliases] = useState([]);
  const poll = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const out = await lambda('GetFunction', { FunctionName: name });
      setFn(out);
      setError(null);
      return out;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }, [name]);

  const reloadVersions = useCallback(async () => {
    const [v, a] = await Promise.all([
      listAll('ListVersionsByFunction', { FunctionName: name, MaxItems: 50 }, 'Versions').catch(() => []),
      listAll('ListAliases', { FunctionName: name, MaxItems: 50 }, 'Aliases').catch(() => []),
    ]);
    setVersions(v);
    setAliases(a);
  }, [name]);

  // While an update is in progress, keep refreshing until the function is ready again.
  const refreshUntilReady = useCallback(async () => {
    clearTimeout(poll.current);
    const out = await refresh();
    const s = out?.Configuration;
    if (s && (s.State === 'Pending' || s.LastUpdateStatus === 'InProgress')) poll.current = setTimeout(refreshUntilReady, 2000);
  }, [refresh]);

  useEffect(() => {
    refreshUntilReady();
    reloadVersions();
    return () => clearTimeout(poll.current);
  }, [refreshUntilReady, reloadVersions]);

  if (error && !fn) return <div className="page"><h2 className="lv-title">λ {name}</h2><ErrorBox error={error} /></div>;
  if (!fn) return <div className="page"><Spinner /></div>;

  const cfg = fn.Configuration || {};
  const st = stateOf(cfg);
  const versionNames = ['$LATEST', ...versions.map((v) => v.Version).filter((v) => v !== '$LATEST')];
  const ctx = { name, fn, cfg, refresh: refreshUntilReady, qualifier, versions, aliases, reloadVersions, versionNames };

  return (
    <div className="page sqs-page">
      <div className="page-head">
        <h2 className="lv-title" title={cfg.FunctionArn}>λ {name}</h2>
        <StateBadge cfg={cfg} />
        {cfg.PackageType === 'Image' ? <span className="badge">Image</span> : <span className="badge">{cfg.Runtime}</span>}
        <label className="row-gap small">
          <span className="muted">Version</span>
          <select value={qualifier} onChange={(e) => setQualifier(e.target.value)} aria-label="Qualifier">
            <option value="">$LATEST</option>
            {aliases.length > 0 && (
              <optgroup label="Aliases">
                {aliases.map((a) => <option key={a.Name} value={a.Name}>{a.Name} → {a.FunctionVersion}</option>)}
              </optgroup>
            )}
            {versions.filter((v) => v.Version !== '$LATEST').length > 0 && (
              <optgroup label="Versions">
                {versions.filter((v) => v.Version !== '$LATEST').map((v) => <option key={v.Version} value={v.Version}>{v.Version}{v.Description ? ` – ${v.Description}` : ''}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <div className="push-right row-gap wrap">
          <a className="btn btn-sm" href={`#${logsGroupPath(logGroupOf(cfg), { range: '1h' })}`}>📜 Logs</a>
          <button className="btn btn-sm" title="Copy ARN" onClick={() => copyText(cfg.FunctionArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
          <button className="btn btn-sm" onClick={() => { refreshUntilReady(); reloadVersions(); }}>↻ Refresh</button>
          <button className="btn btn-sm btn-danger" onClick={async () => { if (await confirmDeleteFunction(name, toast)) { reloadFunctions(); navigate('/lambda'); } }}>Delete</button>
        </div>
      </div>
      {cfg.Description && <div className="muted small fn-desc">{cfg.Description}</div>}
      {st.reason && <div className={`alert ${st.kind === 'bad' ? 'alert-error' : 'alert-info'} small`}>{st.label}: {st.reason}</div>}
      <div className="sqs-stats">
        <Stat label="Memory" value={fmtMemory(cfg.MemorySize)} strong />
        <Stat label="Timeout" value={fmtTimeout(cfg.Timeout)} />
        <Stat label="Architecture" value={(cfg.Architectures || ['x86_64']).join(', ')} />
        <Stat label="Code size" value={cfg.PackageType === 'Image' ? 'Image' : fmtBytes(cfg.CodeSize)} />
        <Stat label="Reserved concurrency" value={fn.Concurrency?.ReservedConcurrentExecutions ?? 'Unreserved'} />
        <Stat label="Last modified" value={fmtDate(parseLastModified(cfg.LastModified))} />
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'code' && <CodeTab {...ctx} />}
      {tab === 'test' && <TestTab {...ctx} />}
      {tab === 'monitor' && <MonitorTab {...ctx} />}
      {tab === 'config' && <GeneralTab {...ctx} />}
      {tab === 'env' && <EnvTab {...ctx} />}
      {tab === 'triggers' && <TriggersTab {...ctx} />}
      {tab === 'permissions' && <PermissionsTab {...ctx} />}
      {tab === 'versions' && <VersionsTab {...ctx} setQualifier={setQualifier} />}
      {tab === 'url' && <UrlTab {...ctx} />}
      {tab === 'concurrency' && <ConcurrencyTab {...ctx} />}
      {tab === 'tags' && <TagsTab {...ctx} />}
    </div>
  );
}
