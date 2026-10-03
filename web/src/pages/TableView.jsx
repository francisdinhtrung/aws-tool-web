import React, { useCallback, useEffect, useState } from 'react';
import { ddb, errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Tabs, Spinner, ErrorBox, Field, Select, useToast, Progress, FileButton, readFileText, download, Empty } from '../components/ui.jsx';
import { KeyAttrInput } from '../components/TableDefEditor.jsx';
import ItemExplorer from './ItemExplorer.jsx';
import Visualizer from '../components/Visualizer.jsx';
import { describeTable, clearDescCache, scanAll, batchWrite, putRequests, deleteRequests, waitForActive } from '../lib/ops.js';
import { keysOf, tableKeyNames, indexesOf, descToDef, pickKey, itemToPlain, itemsToCsv, csvToItems, parseJsonItems } from '../lib/dynamo.js';

const fmtBytes = (b) => {
  if (b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function KV({ rows }) {
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

function Overview({ desc, extra, onRefresh, onDeleted }) {
  const { reloadTables } = useApp();
  const toast = useToast();
  const k = keysOf(desc);
  const del = async () => {
    const typed = window.prompt(`Type the table name "${desc.TableName}" to permanently delete it and all its data.`);
    if (typed !== desc.TableName) return;
    try {
      await ddb('DeleteTable', { TableName: desc.TableName });
      toast(`Deleting ${desc.TableName}`);
      reloadTables();
      onDeleted();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="grid-2 cards">
      <div className="card">
        <div className="card-head">
          <h3>General information</h3>
          <button className="btn btn-sm" onClick={onRefresh}>↻ Refresh</button>
        </div>
        <KV
          rows={[
            ['Status', <span className={`badge ${desc.TableStatus === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}`}>{desc.TableStatus}</span>],
            ['Partition key', `${k.pk} (${k.pkType})`],
            ['Sort key', k.sk ? `${k.sk} (${k.skType})` : '—'],
            ['Item count (approx.)', desc.ItemCount?.toLocaleString()],
            ['Table size (approx.)', fmtBytes(desc.TableSizeBytes)],
            ['Capacity mode', desc.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? 'On-demand' : 'Provisioned'],
            desc.BillingModeSummary?.BillingMode !== 'PAY_PER_REQUEST' && ['Provisioned RCU / WCU', `${desc.ProvisionedThroughput?.ReadCapacityUnits} / ${desc.ProvisionedThroughput?.WriteCapacityUnits}`],
            ['Table class', desc.TableClassSummary?.TableClass || 'STANDARD'],
            ['Created', desc.CreationDateTime ? new Date(desc.CreationDateTime).toLocaleString() : '—'],
            ['ARN', <code className="small">{desc.TableArn}</code>],
          ]}
        />
      </div>
      <div className="card">
        <h3>Features</h3>
        <KV
          rows={[
            ['Indexes', `${desc.GlobalSecondaryIndexes?.length || 0} GSI · ${desc.LocalSecondaryIndexes?.length || 0} LSI`],
            ['Time to Live', extra.ttl ? `${extra.ttl.TimeToLiveStatus}${extra.ttl.AttributeName ? ` (${extra.ttl.AttributeName})` : ''}` : '—'],
            ['Streams', desc.StreamSpecification?.StreamEnabled ? `Enabled (${desc.StreamSpecification.StreamViewType})` : 'Disabled'],
            desc.LatestStreamArn && ['Stream ARN', <code className="small">{desc.LatestStreamArn}</code>],
            ['Point-in-time recovery', extra.pitr?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus || '—'],
            ['Deletion protection', desc.DeletionProtectionEnabled ? 'Enabled' : 'Disabled'],
            ['Encryption', desc.SSEDescription ? `${desc.SSEDescription.SSEType || 'KMS'} (${desc.SSEDescription.Status})` : 'AWS owned key'],
            ['Global table replicas', desc.Replicas?.length ? desc.Replicas.map((r) => r.RegionName).join(', ') : 'None'],
          ]}
        />
        <div className="danger-zone">
          <button className="btn btn-danger" onClick={del}>Delete table</button>
        </div>
      </div>
    </div>
  );
}

function Indexes({ desc, onRefresh }) {
  const toast = useToast();
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const provisioned = desc.BillingModeSummary?.BillingMode !== 'PAY_PER_REQUEST';

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const ka = adding.KeyAttributes;
      const attrs = new Map((desc.AttributeDefinitions || []).map((a) => [a.AttributeName, a.AttributeType]));
      const ks = [{ AttributeName: ka.PartitionKey.AttributeName, KeyType: 'HASH' }];
      attrs.set(ka.PartitionKey.AttributeName, ka.PartitionKey.AttributeType);
      if (ka.SortKey?.AttributeName) {
        ks.push({ AttributeName: ka.SortKey.AttributeName, KeyType: 'RANGE' });
        attrs.set(ka.SortKey.AttributeName, ka.SortKey.AttributeType);
      }
      const projection = { ProjectionType: adding.ProjectionType };
      if (adding.ProjectionType === 'INCLUDE') projection.NonKeyAttributes = adding.include.split(',').map((s) => s.trim()).filter(Boolean);
      await ddb('UpdateTable', {
        TableName: desc.TableName,
        AttributeDefinitions: [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: adding.IndexName,
              KeySchema: ks,
              Projection: projection,
              ...(provisioned ? { ProvisionedThroughput: { ReadCapacityUnits: Number(adding.rcu), WriteCapacityUnits: Number(adding.wcu) } } : {}),
            },
          },
        ],
      });
      toast('Index creation started');
      setAdding(null);
      onRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name) => {
    if (!window.confirm(`Delete index ${name}?`)) return;
    try {
      await ddb('UpdateTable', { TableName: desc.TableName, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }] });
      toast('Index deletion started');
      onRefresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const list = indexesOf(desc);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Secondary indexes</h3>
        <div className="row-gap">
          <button className="btn btn-sm" onClick={onRefresh}>↻ Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding({ IndexName: '', KeyAttributes: { PartitionKey: { AttributeName: '', AttributeType: 'S' } }, ProjectionType: 'ALL', include: '', rcu: 5, wcu: 5 })}>+ Create GSI</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {adding && (
        <div className="card card-sub">
          <div className="grid-3">
            <Field label="Index name"><input value={adding.IndexName} onChange={(e) => setAdding({ ...adding, IndexName: e.target.value })} /></Field>
            <KeyAttrInput label="Partition key" value={adding.KeyAttributes.PartitionKey} onChange={(v) => setAdding({ ...adding, KeyAttributes: { ...adding.KeyAttributes, PartitionKey: v || { AttributeName: '', AttributeType: 'S' } } })} />
            <KeyAttrInput label="Sort key" optional value={adding.KeyAttributes.SortKey} onChange={(v) => setAdding({ ...adding, KeyAttributes: { ...adding.KeyAttributes, SortKey: v } })} />
          </div>
          <div className="grid-3">
            <Field label="Projection"><Select value={adding.ProjectionType} onChange={(v) => setAdding({ ...adding, ProjectionType: v })} options={['ALL', 'KEYS_ONLY', 'INCLUDE']} /></Field>
            {adding.ProjectionType === 'INCLUDE' && <Field label="Included attributes"><input value={adding.include} onChange={(e) => setAdding({ ...adding, include: e.target.value })} /></Field>}
            {provisioned && (
              <>
                <Field label="RCU"><input type="number" value={adding.rcu} onChange={(e) => setAdding({ ...adding, rcu: e.target.value })} /></Field>
                <Field label="WCU"><input type="number" value={adding.wcu} onChange={(e) => setAdding({ ...adding, wcu: e.target.value })} /></Field>
              </>
            )}
          </div>
          <div className="row-gap">
            <button className="btn btn-primary btn-sm" onClick={create} disabled={busy}>{busy ? <Spinner /> : 'Create index'}</button>
            <button className="btn btn-sm" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}
      {!list.length ? (
        <Empty>No secondary indexes</Empty>
      ) : (
        <table className="grid grid-plain">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Partition key</th><th>Sort key</th><th>Projection</th><th>Status</th><th>Items</th><th>Size</th><th /></tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const k = keysOf(desc, i.IndexName);
              return (
                <tr key={i.IndexName}>
                  <td><strong>{i.IndexName}</strong></td>
                  <td>{i.kind}</td>
                  <td>{k.pk} ({k.pkType})</td>
                  <td>{k.sk ? `${k.sk} (${k.skType})` : '—'}</td>
                  <td>{i.Projection?.ProjectionType}{i.Projection?.NonKeyAttributes ? `: ${i.Projection.NonKeyAttributes.join(', ')}` : ''}</td>
                  <td>{i.IndexStatus || 'ACTIVE'}{i.Backfilling ? ' (backfilling)' : ''}</td>
                  <td>{i.ItemCount?.toLocaleString() ?? '—'}</td>
                  <td>{fmtBytes(i.IndexSizeBytes)}</td>
                  <td>{i.kind === 'GSI' && <button className="btn btn-xs btn-danger" onClick={() => remove(i.IndexName)}>Delete</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Settings({ desc, extra, onRefresh }) {
  const toast = useToast();
  const provisioned = desc.BillingModeSummary?.BillingMode !== 'PAY_PER_REQUEST';
  const [billing, setBilling] = useState({ mode: provisioned ? 'PROVISIONED' : 'PAY_PER_REQUEST', rcu: desc.ProvisionedThroughput?.ReadCapacityUnits || 5, wcu: desc.ProvisionedThroughput?.WriteCapacityUnits || 5 });
  const [ttlAttr, setTtlAttr] = useState(extra.ttl?.AttributeName || 'ttl');
  const [streamType, setStreamType] = useState(desc.StreamSpecification?.StreamViewType || 'NEW_AND_OLD_IMAGES');
  const [tags, setTags] = useState(null);
  const [newTag, setNewTag] = useState({ Key: '', Value: '' });
  const [backups, setBackups] = useState(null);

  const act = async (label, fn) => {
    try {
      await fn();
      toast(label);
      onRefresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const loadTags = useCallback(async () => {
    try {
      const out = await ddb('ListTagsOfResource', { ResourceArn: desc.TableArn });
      setTags(out.Tags || []);
    } catch (e) {
      setTags({ error: errorText(e) });
    }
  }, [desc.TableArn]);
  const loadBackups = useCallback(async () => {
    try {
      const out = await ddb('ListBackups', { TableName: desc.TableName });
      setBackups(out.BackupSummaries || []);
    } catch (e) {
      setBackups({ error: errorText(e) });
    }
  }, [desc.TableName]);
  useEffect(() => {
    loadTags();
    loadBackups();
  }, [loadTags, loadBackups]);

  const gsis = desc.GlobalSecondaryIndexes || [];
  const ttlOn = extra.ttl?.TimeToLiveStatus === 'ENABLED';
  const pitrOn = extra.pitr?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED';

  return (
    <div className="grid-2 cards">
      <div className="card">
        <h3>Capacity</h3>
        <div className="grid-3">
          <Field label="Mode"><Select value={billing.mode} onChange={(mode) => setBilling({ ...billing, mode })} options={[['PAY_PER_REQUEST', 'On-demand'], ['PROVISIONED', 'Provisioned']]} /></Field>
          {billing.mode === 'PROVISIONED' && (
            <>
              <Field label="RCU"><input type="number" min="1" value={billing.rcu} onChange={(e) => setBilling({ ...billing, rcu: e.target.value })} /></Field>
              <Field label="WCU"><input type="number" min="1" value={billing.wcu} onChange={(e) => setBilling({ ...billing, wcu: e.target.value })} /></Field>
            </>
          )}
        </div>
        <button
          className="btn btn-sm"
          onClick={() =>
            act('Capacity updated', () => {
              const tp = { ReadCapacityUnits: Number(billing.rcu), WriteCapacityUnits: Number(billing.wcu) };
              const input = { TableName: desc.TableName, BillingMode: billing.mode };
              if (billing.mode === 'PROVISIONED') {
                input.ProvisionedThroughput = tp;
                if (!provisioned && gsis.length) input.GlobalSecondaryIndexUpdates = gsis.map((g) => ({ Update: { IndexName: g.IndexName, ProvisionedThroughput: tp } }));
              }
              return ddb('UpdateTable', input);
            })
          }
        >
          Apply capacity
        </button>
      </div>

      <div className="card">
        <h3>Time to Live (TTL)</h3>
        <p className="muted small">Status: {extra.ttl?.TimeToLiveStatus || 'unknown'}. Items whose TTL attribute (epoch seconds) is in the past are deleted automatically.</p>
        <div className="row-gap">
          <input value={ttlAttr} onChange={(e) => setTtlAttr(e.target.value)} disabled={ttlOn} placeholder="TTL attribute" />
          <button
            className="btn btn-sm"
            onClick={() => act(ttlOn ? 'TTL disabled' : 'TTL enabled', () => ddb('UpdateTimeToLive', { TableName: desc.TableName, TimeToLiveSpecification: { Enabled: !ttlOn, AttributeName: ttlOn ? extra.ttl.AttributeName : ttlAttr } }))}
          >
            {ttlOn ? 'Disable TTL' : 'Enable TTL'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>DynamoDB Streams</h3>
        <div className="row-gap">
          {!desc.StreamSpecification?.StreamEnabled && <Select value={streamType} onChange={setStreamType} options={['KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES']} />}
          <button
            className="btn btn-sm"
            onClick={() =>
              act('Stream updated', () =>
                ddb('UpdateTable', {
                  TableName: desc.TableName,
                  StreamSpecification: desc.StreamSpecification?.StreamEnabled ? { StreamEnabled: false } : { StreamEnabled: true, StreamViewType: streamType },
                }),
              )
            }
          >
            {desc.StreamSpecification?.StreamEnabled ? `Disable stream (${desc.StreamSpecification.StreamViewType})` : 'Enable stream'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Protection & recovery</h3>
        <div className="row-gap wrap">
          <button
            className="btn btn-sm"
            onClick={() => act('Point-in-time recovery updated', () => ddb('UpdateContinuousBackups', { TableName: desc.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: !pitrOn } }))}
          >
            {pitrOn ? 'Disable PITR' : 'Enable PITR'}
          </button>
          <button className="btn btn-sm" onClick={() => act('Deletion protection updated', () => ddb('UpdateTable', { TableName: desc.TableName, DeletionProtectionEnabled: !desc.DeletionProtectionEnabled }))}>
            {desc.DeletionProtectionEnabled ? 'Disable deletion protection' : 'Enable deletion protection'}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              const next = desc.TableClassSummary?.TableClass === 'STANDARD_INFREQUENT_ACCESS' ? 'STANDARD' : 'STANDARD_INFREQUENT_ACCESS';
              if (window.confirm(`Change table class to ${next}?`)) act('Table class updated', () => ddb('UpdateTable', { TableName: desc.TableName, TableClass: next }));
            }}
          >
            Switch table class
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Tags</h3>
        {tags?.error ? (
          <div className="muted small">{tags.error}</div>
        ) : (
          <>
            <table className="grid grid-plain">
              <tbody>
                {(tags || []).map((t) => (
                  <tr key={t.Key}>
                    <td><strong>{t.Key}</strong></td>
                    <td>{t.Value}</td>
                    <td>
                      <button className="btn btn-xs btn-danger" onClick={() => act('Tag removed', () => ddb('UntagResource', { ResourceArn: desc.TableArn, TagKeys: [t.Key] }).then(loadTags))}>Remove</button>
                    </td>
                  </tr>
                ))}
                {tags && !tags.length && <tr><td className="muted">No tags</td></tr>}
              </tbody>
            </table>
            <div className="row-gap">
              <input placeholder="key" value={newTag.Key} onChange={(e) => setNewTag({ ...newTag, Key: e.target.value })} />
              <input placeholder="value" value={newTag.Value} onChange={(e) => setNewTag({ ...newTag, Value: e.target.value })} />
              <button
                className="btn btn-sm"
                disabled={!newTag.Key}
                onClick={() =>
                  act('Tag added', () =>
                    ddb('TagResource', { ResourceArn: desc.TableArn, Tags: [newTag] }).then(() => {
                      setNewTag({ Key: '', Value: '' });
                      return loadTags();
                    }),
                  )
                }
              >
                Add tag
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>On-demand backups</h3>
          <button
            className="btn btn-sm"
            onClick={() => {
              const name = window.prompt('Backup name', `${desc.TableName}-${new Date().toISOString().slice(0, 10)}`);
              if (name) act('Backup started', () => ddb('CreateBackup', { TableName: desc.TableName, BackupName: name }).then(loadBackups));
            }}
          >
            + Create backup
          </button>
        </div>
        {backups?.error ? (
          <div className="muted small">{backups.error}</div>
        ) : (
          <table className="grid grid-plain">
            <tbody>
              {(backups || []).map((b) => (
                <tr key={b.BackupArn}>
                  <td><strong>{b.BackupName}</strong><div className="muted small">{new Date(b.BackupCreationDateTime).toLocaleString()} · {b.BackupStatus} · {fmtBytes(b.BackupSizeBytes)}</div></td>
                  <td className="row-actions">
                    <button
                      className="btn btn-xs"
                      onClick={() => {
                        const target = window.prompt('Restore into new table name', `${desc.TableName}-restored`);
                        if (target) act('Restore started', () => ddb('RestoreTableFromBackup', { TargetTableName: target, BackupArn: b.BackupArn }));
                      }}
                    >
                      Restore
                    </button>
                    <button className="btn btn-xs btn-danger" onClick={() => window.confirm('Delete backup?') && act('Backup deleted', () => ddb('DeleteBackup', { BackupArn: b.BackupArn }).then(loadBackups))}>Delete</button>
                  </td>
                </tr>
              ))}
              {backups && !backups.length && <tr><td className="muted">No backups</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function VisualizerTab({ desc }) {
  const [items, setItems] = useState(null);
  const [limit, setLimit] = useState(500);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await ddb('Scan', { TableName: desc.TableName, Limit: Math.min(1000, limit - out.length), ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) });
        out.push(...(r.Items || []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && out.length < limit);
      setItems(out);
    } catch (e) {
      setError(errorText(e));
    }
  }, [desc.TableName, limit]);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const def = descToDef(desc);
  return (
    <div className="card">
      <div className="row-gap mb">
        <span className="muted small">Sample size</span>
        <Select value={String(limit)} onChange={(v) => setLimit(Number(v))} options={['100', '500', '1000', '5000']} />
        <button className="btn btn-sm" onClick={load}>Reload</button>
      </div>
      <ErrorBox error={error} />
      {!items ? (!error && <Spinner />) : (
        <Visualizer pk={def.KeyAttributes.PartitionKey.AttributeName} sk={def.KeyAttributes.SortKey?.AttributeName} gsis={def.GlobalSecondaryIndexes} items={items} />
      )}
    </div>
  );
}

function ImportExport({ desc }) {
  const toast = useToast();
  const keyNames = tableKeyNames(desc);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // parsed import
  const [opts, setOpts] = useState({ inferNumbers: true, inferJson: true });
  const [abort, setAbort] = useState(null);

  const exportAll = async (fmt) => {
    const ac = new AbortController();
    setAbort(ac);
    setError(null);
    setProgress({ label: 'Scanning…', value: 0 });
    try {
      const items = await scanAll({ TableName: desc.TableName }, (n) => setProgress({ label: `Scanned ${n} items…`, value: n }), ac.signal);
      const base = `${desc.TableName}-${new Date().toISOString().slice(0, 10)}`;
      if (fmt === 'csv') download(`${base}.csv`, itemsToCsv(items, keyNames), 'text/csv');
      else if (fmt === 'json') download(`${base}.json`, JSON.stringify(items.map(itemToPlain), null, 2));
      else if (fmt === 'jsonl') download(`${base}.ddb.jsonl`, items.map((Item) => JSON.stringify({ Item })).join('\n'), 'application/x-ndjson');
      else download(`${base}.ddb.json`, JSON.stringify(items, null, 2));
      toast(`Exported ${items.length} items`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      setAbort(null);
    }
  };

  const onFile = async (file) => {
    setError(null);
    try {
      const text = await readFileText(file);
      const items = /\.csv$/i.test(file.name) ? csvToItems(text, opts) : parseJsonItems(text);
      const missing = items.findIndex((it) => keyNames.some((k) => !it[k]));
      if (missing >= 0) throw new Error(`Item #${missing + 1} is missing key attribute(s) ${keyNames.join(', ')}`);
      setPending({ name: file.name, items });
    } catch (e) {
      setError(`Could not parse ${file.name}: ${e.message}`);
    }
  };

  const runImport = async () => {
    const ac = new AbortController();
    setAbort(ac);
    setError(null);
    try {
      const n = await batchWrite(desc.TableName, putRequests(pending.items), (value, max) => setProgress({ value, max }), ac.signal);
      toast(`Imported ${n} items`);
      setPending(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      setAbort(null);
    }
  };

  const truncate = async () => {
    const typed = window.prompt(`This deletes ALL items in "${desc.TableName}" (the table stays). Type the table name to confirm.`);
    if (typed !== desc.TableName) return;
    const ac = new AbortController();
    setAbort(ac);
    try {
      const items = await scanAll({ TableName: desc.TableName, ProjectionExpression: keyNames.map((_, i) => `#k${i}`).join(', '), ExpressionAttributeNames: Object.fromEntries(keyNames.map((k, i) => [`#k${i}`, k])) }, (n) => setProgress({ label: `Collecting keys… ${n}`, value: n }), ac.signal);
      const n = await batchWrite(desc.TableName, deleteRequests(items.map((it) => pickKey(it, keyNames))), (value, max) => setProgress({ value, max }), ac.signal);
      toast(`Deleted ${n} items`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      setAbort(null);
    }
  };

  return (
    <div className="grid-2 cards">
      <div className="card">
        <h3>Export table</h3>
        <p className="muted small">Scans the whole table (consumes read capacity) and downloads the result.</p>
        <div className="row-gap wrap">
          <button className="btn btn-sm" onClick={() => exportAll('csv')} disabled={!!progress}>CSV</button>
          <button className="btn btn-sm" onClick={() => exportAll('json')} disabled={!!progress}>JSON (plain)</button>
          <button className="btn btn-sm" onClick={() => exportAll('ddb')} disabled={!!progress}>DynamoDB JSON</button>
          <button className="btn btn-sm" onClick={() => exportAll('jsonl')} disabled={!!progress}>DynamoDB JSON lines (S3 export format)</button>
        </div>
      </div>
      <div className="card">
        <h3>Import data</h3>
        <p className="muted small">
          CSV (header row; optional type hints like <code>price (N)</code>, <code>tags (SS)</code>), JSON array (plain or DynamoDB JSON), or JSON lines. Existing items with the same key are overwritten.
        </p>
        <div className="row-gap wrap">
          <label className="check"><input type="checkbox" checked={opts.inferNumbers} onChange={(e) => setOpts({ ...opts, inferNumbers: e.target.checked })} /> CSV: numeric text → Number</label>
          <label className="check"><input type="checkbox" checked={opts.inferJson} onChange={(e) => setOpts({ ...opts, inferJson: e.target.checked })} /> CSV: JSON text → Map/List</label>
        </div>
        <FileButton accept=".csv,.json,.jsonl,.txt" onFile={onFile} className="btn btn-sm">Choose file…</FileButton>
        {pending && (
          <div className="alert alert-info mt">
            <div>
              {pending.name}: <strong>{pending.items.length}</strong> items ready to import into {desc.TableName}.
            </div>
            <div className="row-gap mt">
              <button className="btn btn-primary btn-sm" onClick={runImport} disabled={!!progress}>Import</button>
              <button className="btn btn-sm" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {(progress || error) && (
        <div className="card span-2">
          {progress && (
            <div className="row-gap">
              <Progress value={progress.value} max={progress.max} label={progress.label} />
              {abort && <button className="btn btn-sm" onClick={() => abort.abort()}>Cancel</button>}
            </div>
          )}
          <ErrorBox error={error} onClose={() => setError(null)} />
        </div>
      )}
      <div className="card span-2">
        <h3>Danger zone</h3>
        <button className="btn btn-danger btn-sm" onClick={truncate} disabled={!!progress}>Delete all items…</button>
      </div>
    </div>
  );
}

export default function TableView({ name }) {
  const [desc, setDesc] = useState(null);
  const [extra, setExtra] = useState({});
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('items');

  const load = useCallback(
    async (force = true) => {
      setError(null);
      try {
        const d = await describeTable(name, { force });
        setDesc(d);
        const [ttl, pitr] = await Promise.all([
          ddb('DescribeTimeToLive', { TableName: name }).then((r) => r.TimeToLiveDescription).catch(() => null),
          ddb('DescribeContinuousBackups', { TableName: name }).then((r) => r.ContinuousBackupsDescription).catch(() => null),
        ]);
        setExtra({ ttl, pitr });
        return d;
      } catch (e) {
        setError(errorText(e));
        return null;
      }
    },
    [name],
  );

  useEffect(() => {
    load(true).then((d) => {
      if (d && d.TableStatus !== 'ACTIVE') waitForActive(name).then(() => load(true)).catch(() => {});
    });
  }, [load, name]);

  if (error) return <div className="page"><h2>{name}</h2><ErrorBox error={error} /></div>;
  if (!desc) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h2>{desc.TableName}</h2>
        <span className={`badge ${desc.TableStatus === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}`}>{desc.TableStatus}</span>
        <span className="muted small">
          {keysOf(desc).pk}
          {keysOf(desc).sk ? ` / ${keysOf(desc).sk}` : ''} · ~{desc.ItemCount?.toLocaleString()} items
        </span>
      </div>
      <Tabs
        tabs={[['items', 'Explore items'], ['overview', 'Overview'], ['indexes', 'Indexes'], ['settings', 'Settings'], ['viz', 'Visualizer'], ['io', 'Import / Export']]}
        value={tab}
        onChange={setTab}
      />
      <div className="tab-body">
        {tab === 'items' && <ItemExplorer desc={desc} />}
        {tab === 'overview' && <Overview desc={desc} extra={extra} onRefresh={() => load(true)} onDeleted={() => { clearDescCache(name); navigate('/'); }} />}
        {tab === 'indexes' && <Indexes desc={desc} onRefresh={() => load(true)} />}
        {tab === 'settings' && <Settings desc={desc} extra={extra} onRefresh={() => load(true)} />}
        {tab === 'viz' && <VisualizerTab desc={desc} />}
        {tab === 'io' && <ImportExport desc={desc} />}
      </div>
    </div>
  );
}
