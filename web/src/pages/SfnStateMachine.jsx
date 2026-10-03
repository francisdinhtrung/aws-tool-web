import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Tabs, Spinner, ErrorBox, useToast, copyText, useLocalStorage } from '../components/ui.jsx';
import { Stat } from './LambdaFunction.jsx';
import { confirmDeleteMachine } from './SfnStateMachines.jsx';
import { StartExecutionModal } from '../components/SfnModals.jsx';
import { ExecutionsTab, DefinitionTab, TestStateTab, VersionsTab, ConfigTab, TagsTab } from '../components/SfnTabs.jsx';
import { sfn, listAll, fmtDate, arnName, logGroupName, parseDefinition, allStates } from '../lib/sfn.js';
import { logsGroupPath } from '../lib/logs.js';

const TABS = [
  ['executions', 'Executions'],
  ['definition', 'Definition'],
  ['test', 'Test state'],
  ['versions', 'Versions & aliases'],
  ['config', 'Configuration'],
  ['tags', 'Tags'],
];

export default function SfnStateMachine({ name }) {
  const { machines, machinesState, reloadMachines } = useApp();
  const toast = useToast();
  const [machine, setMachine] = useState(null); // DescribeStateMachine output
  const [error, setError] = useState(null);
  const [tab, setTab] = useLocalStorage('ddbs.sfn.tab', 'executions');
  const [versions, setVersions] = useState([]);
  const [aliases, setAliases] = useState([]);
  const [starting, setStarting] = useState(false);
  const [testState, setTestState] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const arn = machines.find((m) => m.name === name)?.stateMachineArn;

  const refresh = useCallback(async () => {
    if (!arn) return null;
    try {
      const out = await sfn('DescribeStateMachine', { stateMachineArn: arn });
      setMachine(out);
      setError(null);
      return out;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }, [arn]);

  // Versions and aliases only list ARNs: describe each one for its description / routing.
  const reloadVersions = useCallback(async () => {
    if (!arn) return;
    const [v, a] = await Promise.all([
      listAll('ListStateMachineVersions', { stateMachineArn: arn, maxResults: 100 }, 'stateMachineVersions').catch(() => []),
      listAll('ListStateMachineAliases', { stateMachineArn: arn, maxResults: 100 }, 'stateMachineAliases').catch(() => []),
    ]);
    const vs = await Promise.all(v.slice(0, 50).map(async (x) => ({ ...x, ...(await sfn('DescribeStateMachine', { stateMachineArn: x.stateMachineVersionArn }).then((d) => ({ description: d.description })).catch(() => ({}))) })));
    const as = await Promise.all(a.map(async (x) => ({ ...x, name: arnName(x.stateMachineAliasArn), ...(await sfn('DescribeStateMachineAlias', { stateMachineAliasArn: x.stateMachineAliasArn }).catch(() => ({}))) })));
    setVersions([...vs, ...v.slice(50)].sort((x, y) => Number(arnName(y.stateMachineVersionArn)) - Number(arnName(x.stateMachineVersionArn))));
    setAliases(as);
  }, [arn]);

  useEffect(() => {
    refresh();
    reloadVersions();
  }, [refresh, reloadVersions]);

  if (!arn) {
    if (machinesState.loading || !machinesState.loaded) return <div className="page"><Spinner /></div>;
    return <div className="page"><h2 className="lv-title">⛓ {name}</h2><ErrorBox error={machinesState.error || `State machine "${name}" was not found in this region.`} /></div>;
  }
  if (error && !machine) return <div className="page"><h2 className="lv-title">⛓ {name}</h2><ErrorBox error={error} /></div>;
  if (!machine) return <div className="page"><Spinner /></div>;

  const def = parseDefinition(machine.definition);
  const group = logGroupName(machine.loggingConfiguration);
  const targets = [
    [machine.stateMachineArn, `${name} (latest)`],
    ...aliases.map((a) => [a.stateMachineAliasArn, `Alias ${a.name}`]),
    ...versions.map((v) => [v.stateMachineVersionArn, `Version ${arnName(v.stateMachineVersionArn)}`]),
  ];
  const openTest = (state) => {
    setTestState(state);
    setTab('test');
  };

  return (
    <div className="page sqs-page">
      <div className="page-head">
        <h2 className="lv-title" title={machine.stateMachineArn}>⛓ {name}</h2>
        <span className="badge">{machine.type === 'EXPRESS' ? 'Express' : 'Standard'}</span>
        {machine.status && machine.status !== 'ACTIVE' && <span className="badge badge-warn">{machine.status}</span>}
        <div className="push-right row-gap wrap">
          <button className="btn btn-sm btn-primary" onClick={() => setStarting(true)}>▶ Start execution</button>
          {group && <a className="btn btn-sm" href={`#${logsGroupPath(group, { range: '1h' })}`}>📜 Logs</a>}
          <button className="btn btn-sm" title="Copy ARN" onClick={() => copyText(machine.stateMachineArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
          <button className="btn btn-sm" onClick={() => { refresh(); reloadVersions(); setReloadKey((k) => k + 1); }}>↻ Refresh</button>
          <button className="btn btn-sm btn-danger" onClick={async () => { if (await confirmDeleteMachine(machine, toast)) { reloadMachines(); navigate('/sfn'); } }}>Delete</button>
        </div>
      </div>
      {machine.description && <div className="muted small fn-desc">{machine.description}</div>}
      <div className="sqs-stats">
        <Stat label="Type" value={machine.type === 'EXPRESS' ? 'Express' : 'Standard'} strong />
        <Stat label="States" value={def ? allStates(def).size : '—'} />
        <Stat label="Role" value={arnName(machine.roleArn).split('/').pop()} hint={machine.roleArn} />
        <Stat label="Logging" value={machine.loggingConfiguration?.level || 'OFF'} />
        <Stat label="X-Ray" value={machine.tracingConfiguration?.enabled ? 'On' : 'Off'} />
        <Stat label="Versions / aliases" value={`${versions.length} / ${aliases.length}`} />
        <Stat label="Created" value={fmtDate(machine.creationDate)} />
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'executions' && <ExecutionsTab machine={machine} onStart={() => setStarting(true)} reloadKey={reloadKey} />}
      {tab === 'definition' && <DefinitionTab machine={machine} refresh={refresh} onTestState={openTest} />}
      {tab === 'test' && <TestStateTab machine={machine} initialState={testState} />}
      {tab === 'versions' && <VersionsTab machine={machine} versions={versions} aliases={aliases} reloadVersions={reloadVersions} />}
      {tab === 'config' && <ConfigTab machine={machine} refresh={refresh} />}
      {tab === 'tags' && <TagsTab machine={machine} />}
      {starting && <StartExecutionModal machine={machine} targets={targets} onClose={() => setStarting(false)} onStarted={() => setReloadKey((k) => k + 1)} />}
    </div>
  );
}
