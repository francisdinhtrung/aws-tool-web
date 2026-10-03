import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Modal, Field, Select, Spinner, ErrorBox } from './ui.jsx';
import { KeyValueRows } from './SqsModals.jsx';
import {
  lambda, lambdaIam, zipFiles, RUNTIMES, starterCode, FUNCTION_NAME_RE, configErrors, envFromRows,
  ESM_SOURCES, buildMappingInput, sourceService, PERMISSION_PRESETS,
} from '../lib/lambda.js';

export const BASIC_EXECUTION_POLICY = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const TRUST_POLICY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] });

export const readFileBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const trustsLambda = (role) => {
  try {
    const doc = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument || ''));
    return JSON.stringify(doc).includes('lambda.amazonaws.com');
  } catch {
    return true; // unknown: keep it in the list
  }
};

/** Roles that Lambda can assume (trust policy mentions lambda.amazonaws.com). */
export function useLambdaRoles() {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const all = [];
      let Marker;
      try {
        do {
          const out = await lambdaIam('ListRoles', { MaxItems: 1000, ...(Marker ? { Marker } : {}) });
          all.push(...(out.Roles || []));
          Marker = out.IsTruncated ? out.Marker : undefined;
        } while (Marker && all.length < 5000);
        if (live) setRoles(all.filter(trustsLambda).sort((a, b) => a.RoleName.localeCompare(b.RoleName)));
      } catch (e) {
        if (live) {
          setRoles([]);
          setError(errorText(e));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return { roles, error };
}

/** Creates "<fn>-role-xxxxx" with the basic execution policy (CloudWatch Logs), like the console. */
export async function createExecutionRole(fnName) {
  const RoleName = `${fnName}-role-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
  const out = await lambdaIam('CreateRole', { RoleName, AssumeRolePolicyDocument: TRUST_POLICY, Path: '/service-role/', Description: `Execution role for Lambda function ${fnName}` });
  await lambdaIam('AttachRolePolicy', { RoleName, PolicyArn: BASIC_EXECUTION_POLICY });
  return out.Role.Arn;
}

/** A new IAM role takes a few seconds before Lambda can assume it: retry CreateFunction meanwhile. */
export async function createWithRetry(input, { tries = 8, delay = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await lambda('CreateFunction', input);
    } catch (e) {
      if (i >= tries - 1 || !/cannot be assumed|role defined for the function/i.test(e.message || '')) throw e;
      await sleep(delay);
    }
  }
}

const SOURCES = [
  ['scratch', 'Author from scratch'],
  ['zip', 'Upload .zip'],
  ['s3', 'From S3'],
  ['image', 'Container image'],
];

export function CreateFunctionModal({ onClose, onCreated }) {
  const { conn } = useApp();
  const local = conn?.kind === 'endpoint';
  const [source, setSource] = useState('scratch');
  const [f, setF] = useState({ name: '', runtime: 'nodejs22.x', arch: 'x86_64', handler: '', memory: '128', timeout: '3', description: '' });
  const [zip, setZip] = useState(null);
  const [s3, setS3] = useState({ bucket: '', key: '' });
  const [imageUri, setImageUri] = useState('');
  const [roleMode, setRoleMode] = useState(local ? 'arn' : 'new');
  const [roleArn, setRoleArn] = useState(local ? 'arn:aws:iam::000000000000:role/lambda-role' : '');
  const [env, setEnv] = useState([]);
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const { roles, error: rolesError } = useLambdaRoles();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const starter = starterCode(f.runtime);
  const handler = f.handler || starter?.handler || '';
  const nameErr = f.name && !FUNCTION_NAME_RE.test(f.name) ? 'Up to 64 letters, digits, hyphens and underscores' : '';
  const errs = configErrors({ MemorySize: f.memory, Timeout: f.timeout });

  const create = async () => {
    setError(null);
    try {
      if (!FUNCTION_NAME_RE.test(f.name)) throw new Error('Function name is required (letters, digits, - and _ only)');
      if (Object.keys(errs).length) throw new Error(Object.values(errs)[0]);
      if (source === 'scratch' && !starter) throw new Error(`${f.runtime} needs a compiled package: choose "Upload .zip" or "From S3"`);
      if (source === 'zip' && !zip) throw new Error('Choose a .zip file');
      if (source === 'zip' && zip.size > 50 * 1024 * 1024) throw new Error('Direct uploads are limited to 50 MB; upload the zip to S3 and use "From S3"');
      if (source === 's3' && (!s3.bucket.trim() || !s3.key.trim())) throw new Error('S3 bucket and key are required');
      if (source === 'image' && !imageUri.trim()) throw new Error('Image URI is required');
      if (roleMode !== 'new' && !roleArn) throw new Error('Choose an execution role');
      const Variables = envFromRows(env);

      setBusy('Preparing code…');
      let Code;
      if (source === 'scratch') Code = { ZipFile: await zipFiles(starter.files) };
      else if (source === 'zip') Code = { ZipFile: await readFileBase64(zip) };
      else if (source === 's3') Code = { S3Bucket: s3.bucket.trim(), S3Key: s3.key.trim() };
      else Code = { ImageUri: imageUri.trim() };

      let Role = roleArn;
      if (roleMode === 'new') {
        setBusy('Creating execution role…');
        Role = await createExecutionRole(f.name);
      }
      setBusy('Creating function…');
      const tagMap = Object.fromEntries(tags.filter((t) => t.key.trim()).map((t) => [t.key.trim(), t.value]));
      const input = {
        FunctionName: f.name,
        Role,
        Code,
        Architectures: [f.arch],
        MemorySize: Number(f.memory),
        Timeout: Number(f.timeout),
        ...(f.description ? { Description: f.description } : {}),
        ...(Object.keys(Variables).length ? { Environment: { Variables } } : {}),
        ...(Object.keys(tagMap).length ? { Tags: tagMap } : {}),
      };
      if (source === 'image') input.PackageType = 'Image';
      else Object.assign(input, { Runtime: f.runtime, Handler: handler });
      await createWithRetry(input);
      onCreated(f.name);
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  };

  return (
    <Modal
      title="Create function"
      size="lg"
      onClose={onClose}
      footer={
        <>
          {busy && <span className="muted small push-right">{busy}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={create} disabled={Boolean(busy) || !f.name}>{busy ? <Spinner /> : 'Create function'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="seg" role="radiogroup" aria-label="Code source">
        {SOURCES.map(([id, label]) => (
          <button key={id} className={source === id ? 'active' : ''} aria-pressed={source === id} onClick={() => setSource(id)}>{label}</button>
        ))}
      </div>
      <Field label="Function name" hint={nameErr ? <span className="text-bad">{nameErr}</span> : 'Up to 64 characters: letters, digits, - and _.'}>
        <input value={f.name} onChange={(e) => set({ name: e.target.value.trim() })} aria-label="Function name" autoFocus />
      </Field>
      {source !== 'image' && (
        <div className="grid-2">
          <Field label="Runtime">
            <Select value={f.runtime} onChange={(runtime) => set({ runtime, handler: '' })} options={RUNTIMES} aria-label="Runtime" />
          </Field>
          <Field label="Handler" hint={source === 'scratch' ? 'Set by the starter code.' : 'file.function, e.g. index.handler'}>
            <input value={handler} onChange={(e) => set({ handler: e.target.value })} aria-label="Handler" placeholder="index.handler" />
          </Field>
        </div>
      )}
      {source === 'scratch' && (
        <div className="muted small">
          {starter ? <>Starts with <code>{Object.keys(starter.files).join(', ')}</code>; edit it in the Code tab afterwards.</> : <span className="text-bad">{f.runtime} has no inline editor; upload a built package instead.</span>}
        </div>
      )}
      {source === 'zip' && (
        <Field label="Deployment package (.zip)" hint="Up to 50 MB. Larger packages go through S3.">
          <input type="file" accept=".zip,application/zip" onChange={(e) => setZip(e.target.files[0] || null)} aria-label="Zip file" />
        </Field>
      )}
      {source === 's3' && (
        <div className="grid-2">
          <Field label="S3 bucket"><input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} aria-label="S3 bucket" /></Field>
          <Field label="S3 key"><input value={s3.key} onChange={(e) => setS3({ ...s3, key: e.target.value })} aria-label="S3 key" placeholder="builds/function.zip" /></Field>
        </div>
      )}
      {source === 'image' && (
        <Field label="Image URI" hint="ECR image in the same region, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/app:latest">
          <input value={imageUri} onChange={(e) => setImageUri(e.target.value)} aria-label="Image URI" />
        </Field>
      )}
      <div className="grid-3">
        <Field label="Architecture">
          <Select value={f.arch} onChange={(arch) => set({ arch })} options={[['x86_64', 'x86_64'], ['arm64', 'arm64 (Graviton)']]} aria-label="Architecture" />
        </Field>
        <Field label="Memory (MB)" hint={errs.MemorySize ? <span className="text-bad">{errs.MemorySize}</span> : '128 – 10240'}>
          <input type="number" min={128} max={10240} value={f.memory} onChange={(e) => set({ memory: e.target.value })} aria-label="Memory" />
        </Field>
        <Field label="Timeout (s)" hint={errs.Timeout ? <span className="text-bad">{errs.Timeout}</span> : '1 – 900'}>
          <input type="number" min={1} max={900} value={f.timeout} onChange={(e) => set({ timeout: e.target.value })} aria-label="Timeout" />
        </Field>
      </div>
      <Field label="Description"><input value={f.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></Field>

      <h4>Execution role</h4>
      <div className="seg" role="radiogroup" aria-label="Execution role">
        {!local && <button className={roleMode === 'new' ? 'active' : ''} aria-pressed={roleMode === 'new'} onClick={() => setRoleMode('new')}>Create a new role</button>}
        <button className={roleMode === 'existing' ? 'active' : ''} aria-pressed={roleMode === 'existing'} onClick={() => setRoleMode('existing')}>Use an existing role</button>
        <button className={roleMode === 'arn' ? 'active' : ''} aria-pressed={roleMode === 'arn'} onClick={() => setRoleMode('arn')}>Enter role ARN</button>
      </div>
      {roleMode === 'new' && <div className="muted small mt-s">Creates <code>{f.name || '<name>'}-role-xxxxxx</code> with <code>AWSLambdaBasicExecutionRole</code> (write logs to CloudWatch). Needs <code>iam:CreateRole</code> and <code>iam:AttachRolePolicy</code>.</div>}
      {roleMode === 'existing' && (
        <Field label="Role" hint={rolesError ? <span className="text-bad">{rolesError}</span> : 'Roles whose trust policy allows lambda.amazonaws.com.'}>
          {roles === null ? <Spinner /> : <Select value={roleArn} onChange={setRoleArn} options={[['', roles.length ? '— select a role —' : '— no role found —'], ...roles.map((r) => [r.Arn, r.RoleName])]} aria-label="Role" />}
        </Field>
      )}
      {roleMode === 'arn' && (
        <Field label="Role ARN"><input value={roleArn} onChange={(e) => setRoleArn(e.target.value)} aria-label="Role ARN" placeholder="arn:aws:iam::123456789012:role/my-role" /></Field>
      )}

      <h4>Environment variables</h4>
      <KeyValueRows rows={env} onChange={setEnv} />
      <h4>Tags</h4>
      <KeyValueRows rows={tags} onChange={setTags} />
    </Modal>
  );
}

// --- Triggers (event source mappings) -----------------------------------------------------------------
export function MappingModal({ fn, mapping, onClose, onSaved }) {
  const editing = Boolean(mapping);
  const [f, setF] = useState(() =>
    mapping
      ? {
          EventSourceArn: mapping.EventSourceArn,
          BatchSize: mapping.BatchSize ?? '',
          MaximumBatchingWindowInSeconds: mapping.MaximumBatchingWindowInSeconds ?? '',
          Enabled: mapping.State !== 'Disabled' && mapping.State !== 'Disabling',
          ReportBatchItemFailures: (mapping.FunctionResponseTypes || []).includes('ReportBatchItemFailures'),
          FilterPattern: (mapping.FilterCriteria?.Filters || []).map((x) => x.Pattern).join('\n'),
          MaximumConcurrency: mapping.ScalingConfig?.MaximumConcurrency ?? '',
        }
      : { EventSourceArn: '', BatchSize: '', MaximumBatchingWindowInSeconds: '', StartingPosition: 'LATEST', Enabled: true, ReportBatchItemFailures: false, FilterPattern: '', MaximumConcurrency: '' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const svc = sourceService(f.EventSourceArn);
  const stream = svc === 'kinesis' || svc === 'dynamodb' || svc === 'kafka';

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const input = buildMappingInput(fn, f);
      if (editing) {
        const { EventSourceArn, StartingPosition, ...rest } = input; // eslint-disable-line no-unused-vars
        if (!rest.FilterCriteria) rest.FilterCriteria = { Filters: [] };
        if (!rest.FunctionResponseTypes) rest.FunctionResponseTypes = [];
        await lambda('UpdateEventSourceMapping', { UUID: mapping.UUID, ...rest });
      } else await lambda('CreateEventSourceMapping', input);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit trigger' : 'Add trigger'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : editing ? 'Save' : 'Add trigger'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="muted small">
        Polling triggers (event source mappings): Lambda reads the queue or stream and invokes the function with batches. The execution role needs read access to the source
        (e.g. <code>AWSLambdaSQSQueueExecutionRole</code>). Push triggers (API Gateway, S3, SNS, EventBridge) are configured on the source and only need a permission in the Permissions tab.
      </div>
      {!editing && (
        <div className="row-gap wrap mt-s">
          {ESM_SOURCES.map(([id, label, ph]) => (
            <button key={id} className={`btn btn-xs${svc === id ? ' btn-primary' : ''}`} onClick={() => set({ EventSourceArn: ph })}>{label}</button>
          ))}
        </div>
      )}
      <Field label="Event source ARN">
        <input value={f.EventSourceArn} onChange={(e) => set({ EventSourceArn: e.target.value })} disabled={editing} aria-label="Event source ARN" placeholder="arn:aws:sqs:us-east-1:123456789012:queue" />
      </Field>
      <div className="grid-3">
        <Field label="Batch size" hint={svc === 'sqs' ? '1 – 10000 (default 10)' : '1 – 10000 (default 100)'}>
          <input type="number" min={1} max={10000} value={f.BatchSize} onChange={(e) => set({ BatchSize: e.target.value })} aria-label="Batch size" />
        </Field>
        <Field label="Batch window (s)" hint="0 – 300: wait to fill a batch">
          <input type="number" min={0} max={300} value={f.MaximumBatchingWindowInSeconds} onChange={(e) => set({ MaximumBatchingWindowInSeconds: e.target.value })} aria-label="Batch window" />
        </Field>
        {stream && !editing && (
          <Field label="Starting position">
            <Select value={f.StartingPosition} onChange={(StartingPosition) => set({ StartingPosition })} options={['LATEST', 'TRIM_HORIZON']} aria-label="Starting position" />
          </Field>
        )}
        {svc === 'sqs' && (
          <Field label="Maximum concurrency" hint="2 – 1000, empty = no limit">
            <input type="number" min={2} max={1000} value={f.MaximumConcurrency} onChange={(e) => set({ MaximumConcurrency: e.target.value })} aria-label="Maximum concurrency" />
          </Field>
        )}
      </div>
      <Field label="Filter patterns (optional)" hint='One JSON pattern per line, e.g. {"body": {"type": ["order"]}}. Events that match no pattern are dropped.'>
        <textarea className="mono" rows={3} value={f.FilterPattern} onChange={(e) => set({ FilterPattern: e.target.value })} aria-label="Filter patterns" />
      </Field>
      <div className="row-gap wrap">
        <label className="check"><input type="checkbox" checked={f.Enabled} onChange={(e) => set({ Enabled: e.target.checked })} /> Enabled</label>
        <label className="check"><input type="checkbox" checked={f.ReportBatchItemFailures} onChange={(e) => set({ ReportBatchItemFailures: e.target.checked })} /> Report batch item failures</label>
      </div>
    </Modal>
  );
}

// --- Resource-based policy ---------------------------------------------------------------------------
export function PermissionModal({ fn, qualifier, onClose, onSaved }) {
  const [preset, setPreset] = useState(PERMISSION_PRESETS[0][0]);
  const [f, setF] = useState({ principal: PERMISSION_PRESETS[0][0], sourceArn: '', sourceAccount: '', action: 'lambda:InvokeFunction', sid: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const ph = PERMISSION_PRESETS.find((p) => p[0] === preset)?.[2];

  const save = async () => {
    setError(null);
    if (!f.principal.trim()) return setError('Principal is required');
    setBusy(true);
    try {
      await lambda('AddPermission', {
        FunctionName: fn,
        StatementId: f.sid.trim() || `studio-${Date.now()}`,
        Action: f.action,
        Principal: f.principal.trim(),
        ...(f.sourceArn.trim() ? { SourceArn: f.sourceArn.trim() } : {}),
        ...(f.sourceAccount.trim() ? { SourceAccount: f.sourceAccount.trim() } : {}),
        ...(qualifier ? { Qualifier: qualifier } : {}),
      });
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add permission"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Add permission'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Allow">
        <Select
          value={preset}
          onChange={(v) => {
            setPreset(v);
            set({ principal: v, sourceArn: '' });
          }}
          options={PERMISSION_PRESETS.map(([p, label]) => [p, label])}
          aria-label="Preset"
        />
      </Field>
      <Field label="Principal" hint="A service (sns.amazonaws.com), an account ID or an IAM ARN.">
        <input value={f.principal} onChange={(e) => set({ principal: e.target.value })} aria-label="Principal" />
      </Field>
      <Field label="Source ARN (recommended)" hint="Restricts the permission to one resource, so other accounts' resources cannot invoke the function.">
        <input value={f.sourceArn} onChange={(e) => set({ sourceArn: e.target.value })} placeholder={ph} aria-label="Source ARN" />
      </Field>
      <div className="grid-2">
        <Field label="Source account (optional)"><input value={f.sourceAccount} onChange={(e) => set({ sourceAccount: e.target.value })} aria-label="Source account" /></Field>
        <Field label="Action">
          <Select value={f.action} onChange={(action) => set({ action })} options={['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl', 'lambda:GetFunction', 'lambda:*']} aria-label="Action" />
        </Field>
      </div>
      <Field label="Statement ID (optional)"><input value={f.sid} onChange={(e) => set({ sid: e.target.value })} aria-label="Statement ID" /></Field>
      {qualifier && <div className="muted small">Applies to <code>{fn}:{qualifier}</code>.</div>}
    </Modal>
  );
}

// --- Aliases -------------------------------------------------------------------------------------------
export function AliasModal({ fn, alias, versions, onClose, onSaved }) {
  const editing = Boolean(alias);
  const weights = alias?.RoutingConfig?.AdditionalVersionWeights || {};
  const [extraVersion, extraWeight] = Object.entries(weights)[0] || ['', ''];
  const [f, setF] = useState({
    Name: alias?.Name || '',
    FunctionVersion: alias?.FunctionVersion || versions.filter((v) => v !== '$LATEST').at(-1) || '$LATEST',
    Description: alias?.Description || '',
    extraVersion,
    extraWeight: extraWeight ? String(Math.round(extraWeight * 100)) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));

  const save = async () => {
    setError(null);
    if (!/^(?!^[0-9]+$)[a-zA-Z0-9-_]{1,128}$/.test(f.Name)) return setError('Alias name: letters, digits, - and _, not only digits');
    let RoutingConfig = { AdditionalVersionWeights: {} };
    if (f.extraVersion) {
      const w = Number(f.extraWeight);
      if (!(w > 0 && w < 100)) return setError('Weight must be between 1 and 99 %');
      if (f.extraVersion === f.FunctionVersion) return setError('The weighted version must differ from the main version');
      RoutingConfig = { AdditionalVersionWeights: { [f.extraVersion]: w / 100 } };
    }
    setBusy(true);
    try {
      const input = { FunctionName: fn, Name: f.Name, FunctionVersion: f.FunctionVersion, Description: f.Description, RoutingConfig };
      await lambda(editing ? 'UpdateAlias' : 'CreateAlias', input);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const published = versions.filter((v) => v !== '$LATEST');

  return (
    <Modal
      title={editing ? `Edit alias ${alias.Name}` : 'Create alias'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name"><input value={f.Name} onChange={(e) => set({ Name: e.target.value })} disabled={editing} aria-label="Alias name" placeholder="live" /></Field>
      <Field label="Version"><Select value={f.FunctionVersion} onChange={(FunctionVersion) => set({ FunctionVersion })} options={versions} aria-label="Version" /></Field>
      <Field label="Description"><input value={f.Description} onChange={(e) => set({ Description: e.target.value })} aria-label="Alias description" /></Field>
      <h4>Weighted routing (canary)</h4>
      <div className="grid-2">
        <Field label="Additional version" hint="Published versions only.">
          <Select value={f.extraVersion} onChange={(extraVersion) => set({ extraVersion })} options={[['', '— none —'], ...published.filter((v) => v !== f.FunctionVersion)]} aria-label="Additional version" />
        </Field>
        {f.extraVersion && (
          <Field label="Weight (%)" hint="Share of invocations sent to the additional version.">
            <input type="number" min={1} max={99} value={f.extraWeight} onChange={(e) => set({ extraWeight: e.target.value })} aria-label="Weight" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
