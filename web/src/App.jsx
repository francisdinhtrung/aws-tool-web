import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, setConn as setApiConn, errorText } from './api.js';
import { AppCtx, useHashRoute, navigate, connInfo } from './context.js';
import { ToastProvider, Spinner, useLocalStorage } from './components/ui.jsx';
import { REGIONS } from './lib/dynamo.js';
import { listAllTables, clearDescCache } from './lib/ops.js';
import Connections from './pages/Connections.jsx';
import TableView from './pages/TableView.jsx';
import OperationBuilder from './pages/OperationBuilder.jsx';
import PartiQL from './pages/PartiQL.jsx';
import Modeler from './pages/Modeler.jsx';
import Home from './pages/Home.jsx';
import CreateTableModal from './components/CreateTableModal.jsx';
import S3Browser from './pages/S3Browser.jsx';
import { CreateBucketModal } from './components/S3Modals.jsx';
import { TransfersProvider, TransfersDock } from './components/Transfers.jsx';
import { s3, s3Path } from './lib/s3.js';
import LogsHome from './pages/LogGroups.jsx';
import LogViewer from './pages/LogViewer.jsx';
import LogsInsights from './pages/LogsInsights.jsx';
import { listLogGroups } from './lib/logs.js';
import LogsSidebar from './components/LogsSidebar.jsx';
import SqsHome from './pages/SqsQueues.jsx';
import SqsQueue from './pages/SqsQueue.jsx';
import SqsSidebar from './components/SqsSidebar.jsx';
import { CreateQueueModal } from './components/SqsModals.jsx';
import { listAllQueues, sqsPath } from './lib/sqs.js';
import LambdaHome from './pages/LambdaFunctions.jsx';
import LambdaFunction from './pages/LambdaFunction.jsx';
import LambdaLayers from './pages/LambdaLayers.jsx';
import LambdaSidebar from './components/LambdaSidebar.jsx';
import { CreateFunctionModal } from './components/LambdaModals.jsx';
import { listAllFunctions, lambdaPath } from './lib/lambda.js';

// Sections that belong to one service; anything else (home, connections) keeps the last workspace.
const DDB_SECTIONS = new Set(['table', 'ops', 'partiql', 'modeler']);

const WORKSPACES = [
  ['dynamodb', 'DynamoDB', '◆', 'DynamoDB Studio', '/'],
  ['s3', 'S3', '🪣', 'S3 Browser', '/s3'],
  ['logs', 'CloudWatch', '📜', 'CloudWatch Logs', '/logs'],
  ['sqs', 'SQS', '📨', 'SQS Console', '/sqs'],
  ['lambda', 'Lambda', 'λ', 'Lambda Console', '/lambda'],
];

const connValue = (c) => (!c ? '' : c.kind === 'profile' ? `p:${c.profile}` : c.kind === 'endpoint' ? `e:${c.id}` : 'd');

export default function App() {
  return (
    <ToastProvider>
      <TransfersProvider>
        <Shell />
      </TransfersProvider>
    </ToastProvider>
  );
}

function Shell() {
  const route = useHashRoute();
  const [conn, setConnState] = useLocalStorage('ddbs.conn', null);
  const [profiles, setProfiles] = useState([]);
  const [endpoints, setEndpoints] = useState([]);
  const [tables, setTables] = useState([]);
  const [tablesState, setTablesState] = useState({ loading: false, error: null });
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [bucketInfo, setBucketInfo] = useState([]);
  const [bucketsState, setBucketsState] = useState({ loading: false, error: null, loaded: false });
  const [theme, setTheme] = useLocalStorage('ddbs.theme', 'auto');
  const [savedWorkspace, setSavedWorkspace] = useLocalStorage('ddbs.workspace', 'dynamodb');
  const [logGroups, setLogGroups] = useState([]);
  const [logGroupsState, setLogGroupsState] = useState({ loading: false, error: null, loaded: false, more: false });
  const [logFavorites, setLogFavorites] = useLocalStorage('ddbs.logs.favorites', []);
  const [queues, setQueues] = useState([]);
  const [queuesState, setQueuesState] = useState({ loading: false, error: null, loaded: false, more: false });
  const [functions, setFunctions] = useState([]);
  const [functionsState, setFunctionsState] = useState({ loading: false, error: null, loaded: false, more: false });

  const [section, arg] = (() => {
    const parts = route.split('?')[0].split('/').filter(Boolean);
    return [parts[0] || '', parts.slice(1).join('/')];
  })();
  const isS3 = section === 's3';
  const isLogs = section === 'logs';
  const isSqs = section === 'sqs';
  const isLambda = section === 'lambda';
  const workspace = isS3 ? 's3' : isLogs ? 'logs' : isSqs ? 'sqs' : isLambda ? 'lambda' : DDB_SECTIONS.has(section) ? 'dynamodb' : savedWorkspace;
  const s3ws = workspace === 's3';
  const logsws = workspace === 'logs';
  const sqsws = workspace === 'sqs';
  const lambdaws = workspace === 'lambda';
  const ws = WORKSPACES.find((w) => w[0] === workspace) || WORKSPACES[0];

  // Remember the workspace when entering a service-specific page (only on route change, so the switcher can override it).
  useEffect(() => {
    if (section === 's3') setSavedWorkspace('s3');
    else if (section === 'logs') setSavedWorkspace('logs');
    else if (section === 'sqs') setSavedWorkspace('sqs');
    else if (section === 'lambda') setSavedWorkspace('lambda');
    else if (DDB_SECTIONS.has(section)) setSavedWorkspace('dynamodb');
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.setAttribute('data-workspace', workspace);
    document.title = `${ws[3]} · AWS Tool Web`;
  }, [workspace, ws]);

  // S3, CloudWatch, SQS and Lambda have no home page of their own: their home is the bucket / log group / queue / function list.
  useEffect(() => {
    if (!section && (s3ws || logsws || sqsws || lambdaws)) navigate(ws[4]);
  }, [s3ws, logsws, sqsws, lambdaws, section, ws]);

  const switchWorkspace = (w) => {
    setSavedWorkspace(w);
    setFilter('');
    navigate(WORKSPACES.find((x) => x[0] === w)[4]);
  };

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keep api.js in sync synchronously so child effects in the same render use the new connection.
  setApiConn(conn);

  const reloadConnections = useCallback(async () => {
    const [p, e] = await Promise.all([api('/api/profiles').catch(() => []), api('/api/connections').catch(() => [])]);
    setProfiles(p);
    setEndpoints(e);
    return { p, e };
  }, []);

  const reloadTables = useCallback(async () => {
    if (!conn) return setTables([]);
    setTablesState({ loading: true, error: null });
    try {
      setTables(await listAllTables());
      setTablesState({ loading: false, error: null });
    } catch (e) {
      setTables([]);
      setTablesState({ loading: false, error: errorText(e) });
    }
  }, [conn]);

  const reloadBuckets = useCallback(async () => {
    if (!conn) return setBucketInfo([]);
    setBucketsState({ loading: true, error: null, loaded: false });
    try {
      const out = await s3('ListBuckets', {});
      setBucketInfo((out.Buckets || []).sort((a, b) => a.Name.localeCompare(b.Name)));
      setBucketsState({ loading: false, error: null, loaded: true });
    } catch (e) {
      setBucketInfo([]);
      setBucketsState({ loading: false, error: errorText(e), loaded: true });
    }
  }, [conn]);

  const reloadLogGroups = useCallback(async () => {
    if (!conn) return setLogGroups([]);
    setLogGroupsState({ loading: true, error: null, loaded: false, more: false });
    try {
      const { groups, more } = await listLogGroups({ max: 1000 });
      setLogGroups(groups);
      setLogGroupsState({ loading: false, error: null, loaded: true, more });
    } catch (e) {
      setLogGroups([]);
      setLogGroupsState({ loading: false, error: errorText(e), loaded: true, more: false });
    }
  }, [conn]);

  const reloadQueues = useCallback(async () => {
    if (!conn) return setQueues([]);
    setQueuesState({ loading: true, error: null, loaded: false, more: false });
    try {
      const { urls, more } = await listAllQueues();
      setQueues(urls);
      setQueuesState({ loading: false, error: null, loaded: true, more });
    } catch (e) {
      setQueues([]);
      setQueuesState({ loading: false, error: errorText(e), loaded: true, more: false });
    }
  }, [conn]);

  const reloadFunctions = useCallback(async () => {
    if (!conn) return setFunctions([]);
    setFunctionsState({ loading: true, error: null, loaded: false, more: false });
    try {
      const { functions: list, more } = await listAllFunctions();
      setFunctions(list);
      setFunctionsState({ loading: false, error: null, loaded: true, more });
    } catch (e) {
      setFunctions([]);
      setFunctionsState({ loading: false, error: errorText(e), loaded: true, more: false });
    }
  }, [conn]);

  const toggleLogFavorite = useCallback(
    (name) => setLogFavorites((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name].sort())),
    [setLogFavorites],
  );

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    clearDescCache();
    setStatus(null);
    if (workspace === 'dynamodb') reloadTables();
    if (conn) {
      api('/api/test', { method: 'POST', body: { service: workspace } })
        .then((s) => setStatus({ ok: true, ...s }))
        .catch((e) => setStatus({ ok: false, error: errorText(e) }));
    }
  }, [conn, reloadTables, workspace]);

  const setConn = useCallback((c) => setConnState(c), [setConnState]);

  const onPick = (v) => {
    if (!v) return setConn(null);
    if (v === 'd') return setConn({ kind: 'default', region: conn?.region || 'us-east-1' });
    if (v.startsWith('p:')) {
      const name = v.slice(2);
      const p = profiles.find((x) => x.name === name);
      return setConn({ kind: 'profile', profile: name, region: p?.region || 'us-east-1' });
    }
    setConn({ kind: 'endpoint', id: v.slice(2) });
  };

  const info = useMemo(() => connInfo(conn, profiles, endpoints), [conn, profiles, endpoints]);
  const buckets = useMemo(() => bucketInfo.map((b) => b.Name), [bucketInfo]);
  const ctx = useMemo(
    () => ({
      conn, setConn, profiles, endpoints, reloadConnections, tables, reloadTables, info, buckets, bucketInfo, bucketsState, reloadBuckets, workspace,
      logGroups, logGroupsState, reloadLogGroups, logFavorites, toggleLogFavorite, queues, queuesState, reloadQueues, functions, functionsState, reloadFunctions,
    }),
    [
      conn, setConn, profiles, endpoints, reloadConnections, tables, reloadTables, info, buckets, bucketInfo, bucketsState, reloadBuckets, workspace,
      logGroups, logGroupsState, reloadLogGroups, logFavorites, toggleLogFavorite, queues, queuesState, reloadQueues, functions, functionsState, reloadFunctions,
    ],
  );

  const shown = tables.filter((t) => t.toLowerCase().includes(filter.toLowerCase()));
  const currentBucket = isS3 && arg ? decodeURIComponent(arg.split('/')[0]) : '';
  const shownBuckets = buckets.filter((b) => b.toLowerCase().includes(filter.toLowerCase()));

  // Buckets are listed only in the S3 workspace (DynamoDB-only endpoints have no S3).
  useEffect(() => {
    if (s3ws) reloadBuckets();
    else setBucketsState((s) => (s.loaded ? { loading: false, error: null, loaded: false } : s));
  }, [s3ws, reloadBuckets]);

  useEffect(() => {
    if (logsws) reloadLogGroups();
  }, [logsws, reloadLogGroups]);

  useEffect(() => {
    if (sqsws) reloadQueues();
  }, [sqsws, reloadQueues]);

  useEffect(() => {
    if (lambdaws) reloadFunctions();
  }, [lambdaws, reloadFunctions]);

  const lambdaArg = isLambda ? arg.split('/') : [];
  const currentFunction = lambdaArg[0] === 'function' && lambdaArg[1] ? decodeURIComponent(lambdaArg[1]) : '';

  const sqsArg = isSqs ? arg.split('/') : [];
  const currentQueue = sqsArg[0] === 'queue' && sqsArg[1] ? decodeURIComponent(sqsArg[1]) : '';

  const logArg = isLogs ? arg.split('/') : [];
  const currentLogGroup = logArg[0] === 'group' && logArg[1] ? decodeURIComponent(logArg.slice(1).join('/')) : '';

  let page;
  if (section === 'connections') page = <Connections />;
  else if (isS3) page = <S3Browser key={connValue(conn)} arg={arg} />;
  else if (isLogs && currentLogGroup) page = <LogViewer key={`${connValue(conn)}:${currentLogGroup}`} group={currentLogGroup} />;
  else if (isLogs && logArg[0] === 'insights') page = <LogsInsights key={connValue(conn)} />;
  else if (isLogs) page = <LogsHome key={connValue(conn)} />;
  else if (isSqs && currentQueue && conn) page = <SqsQueue key={`${connValue(conn)}:${currentQueue}`} name={currentQueue} />;
  else if (isSqs) page = <SqsHome key={connValue(conn)} onCreate={() => setCreating('queue')} />;
  else if (isLambda && currentFunction && conn) page = <LambdaFunction key={`${connValue(conn)}:${currentFunction}`} name={currentFunction} />;
  else if (isLambda && lambdaArg[0] === 'layers') page = <LambdaLayers key={connValue(conn)} />;
  else if (isLambda) page = <LambdaHome key={connValue(conn)} onCreate={() => setCreating('function')} />;
  else if (!conn && section !== 'modeler') page = <Home />;
  else if (section === 'table' && arg) page = <TableView key={`${connValue(conn)}:${arg}`} name={decodeURIComponent(arg)} />;
  else if (section === 'ops') page = <OperationBuilder key={connValue(conn)} />;
  else if (section === 'partiql') page = <PartiQL key={connValue(conn)} />;
  else if (section === 'modeler') page = <Modeler id={arg} />;
  else page = <Home />;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href={`#${ws[4]}`}>
            <span className="logo">{ws[2]}</span> {ws[3]}
          </a>
          <div className="seg ws-switch" role="tablist" aria-label="Service">
            {WORKSPACES.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={workspace === id} className={workspace === id ? 'active' : ''} onClick={() => switchWorkspace(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="conn-picker">
            <select value={connValue(conn)} onChange={(e) => onPick(e.target.value)} aria-label="Connection">
              <option value="">— Select connection —</option>
              {profiles.length > 0 && (
                <optgroup label="AWS profiles">
                  {profiles.map((p) => (
                    <option key={p.name} value={`p:${p.name}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {endpoints.length > 0 && (
                <optgroup label="Custom endpoints (DynamoDB Local…)">
                  {endpoints.map((e) => (
                    <option key={e.id} value={`e:${e.id}`}>
                      {e.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Other">
                <option value="d">Default credential chain (env / instance role)</option>
              </optgroup>
            </select>
            {conn && conn.kind !== 'endpoint' && (
              <select value={conn.region || ''} onChange={(e) => setConn({ ...conn, region: e.target.value })} aria-label="Region">
                {[...new Set([conn.region, ...REGIONS].filter(Boolean))].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            )}
            {conn && conn.kind === 'endpoint' && <span className="chip">{info.endpoint}</span>}
            {conn && (
              <span
                className={`status-dot ${status ? (status.ok ? 'ok' : 'bad') : 'wait'}`}
                title={status ? (status.ok ? status.identity?.arn || 'Connected' : status.error) : 'Checking…'}
              />
            )}
            {status?.ok && status.identity && <span className="muted small hide-sm">{status.identity.account}</span>}
          </div>
          <div className="topbar-right">
            <select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme" className="theme-select">
              <option value="auto">Auto theme</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </header>

        <aside className="sidebar">
          {lambdaws ? (
            <LambdaSidebar
              conn={conn}
              functions={functions}
              state={functionsState}
              reload={reloadFunctions}
              current={currentFunction}
              page={isLambda ? (currentFunction ? 'function' : lambdaArg[0] || 'home') : section}
              onCreate={() => setCreating('function')}
            />
          ) : sqsws ? (
            <SqsSidebar
              conn={conn}
              queues={queues}
              state={queuesState}
              reload={reloadQueues}
              current={currentQueue}
              page={isSqs ? (currentQueue ? 'queue' : 'home') : section}
              onCreate={() => setCreating('queue')}
            />
          ) : logsws ? (
            <LogsSidebar
              conn={conn}
              groups={logGroups}
              state={logGroupsState}
              reload={reloadLogGroups}
              favorites={logFavorites}
              current={currentLogGroup}
              page={isLogs ? logArg[0] || 'home' : section}
            />
          ) : s3ws ? (
            <nav className="nav">
              <a href="#/s3" className={isS3 && !currentBucket ? 'active' : ''}>🪣 Buckets</a>
              <a href="#/connections" className={section === 'connections' ? 'active' : ''}>⚙ Connections</a>
            </nav>
          ) : (
            <nav className="nav">
              <a href="#/connections" className={section === 'connections' ? 'active' : ''}>⚙ Connections</a>
              <a href="#/ops" className={section === 'ops' ? 'active' : ''}>⚡ Operation builder</a>
              <a href="#/partiql" className={section === 'partiql' ? 'active' : ''}>⌨ PartiQL editor</a>
              <a href="#/modeler" className={section === 'modeler' ? 'active' : ''}>▦ Data modeler</a>
            </nav>
          )}
          {logsws || sqsws || lambdaws ? null : s3ws ? (
            <>
              <div className="side-head">
                <span>Buckets {conn && <span className="muted">({buckets.length})</span>}</span>
                <span>
                  <button className="icon-btn" title="Refresh" onClick={reloadBuckets} disabled={!conn}>↻</button>
                  <button className="icon-btn" title="Create bucket" onClick={() => setCreating('bucket')} disabled={!conn}>＋</button>
                </span>
              </div>
              {conn && <input className="side-filter" placeholder="Filter buckets…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
              <div className="table-list bucket-list">
                {!conn && <div className="muted small pad">Select a connection to list buckets.</div>}
                {bucketsState.loading && <div className="pad"><Spinner /></div>}
                {bucketsState.error && <div className="side-error">{bucketsState.error}</div>}
                {shownBuckets.map((b) => (
                  <a key={b} href={`#${s3Path(b)}`} className={currentBucket === b ? 'active' : ''} title={b}>
                    {b}
                  </a>
                ))}
                {conn && bucketsState.loaded && !bucketsState.loading && !bucketsState.error && buckets.length === 0 && <div className="muted small pad">No buckets.</div>}
              </div>
            </>
          ) : (
            <>
              <div className="side-head">
                <span>Tables {conn && <span className="muted">({tables.length})</span>}</span>
                <span>
                  <button className="icon-btn" title="Refresh" onClick={reloadTables} disabled={!conn}>↻</button>
                  <button className="icon-btn" title="Create table" onClick={() => setCreating(true)} disabled={!conn}>＋</button>
                </span>
              </div>
              {conn && <input className="side-filter" placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
              <div className="table-list">
                {!conn && <div className="muted small pad">Select a connection to list tables.</div>}
                {tablesState.loading && <div className="pad"><Spinner /></div>}
                {tablesState.error && <div className="side-error">{tablesState.error}</div>}
                {shown.map((t) => (
                  <a key={t} href={`#/table/${encodeURIComponent(t)}`} className={section === 'table' && decodeURIComponent(arg) === t ? 'active' : ''} title={t}>
                    {t}
                  </a>
                ))}
                {conn && !tablesState.loading && !tablesState.error && tables.length === 0 && <div className="muted small pad">No tables.</div>}
              </div>
            </>
          )}
          <div className="credit">Developed by Trung.Vu</div>
        </aside>

        <main className="main">{page}</main>
        <TransfersDock />

        {creating === 'function' && (
          <CreateFunctionModal
            onClose={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              reloadFunctions();
              navigate(lambdaPath(name));
            }}
          />
        )}
        {creating === 'queue' && (
          <CreateQueueModal
            onClose={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              reloadQueues();
              navigate(sqsPath(name));
            }}
          />
        )}
        {creating === 'bucket' && (
          <CreateBucketModal
            onClose={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              reloadBuckets();
              navigate(s3Path(name));
            }}
          />
        )}
        {creating === true && (
          <CreateTableModal
            onClose={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              reloadTables();
              navigate(`/table/${encodeURIComponent(name)}`);
            }}
          />
        )}
      </div>
    </AppCtx.Provider>
  );
}
