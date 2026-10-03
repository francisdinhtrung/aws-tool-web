import express from 'express';
import * as CWL from '@aws-sdk/client-cloudwatch-logs';
import { HttpError } from './profiles.js';

// Read-mostly CloudWatch Logs API surface exposed to the UI.
export const LOGS_COMMANDS = new Set([
  'DescribeLogGroups', 'DescribeLogStreams', 'FilterLogEvents', 'GetLogEvents', 'GetLogGroupFields',
  'StartQuery', 'GetQueryResults', 'StopQuery', 'DescribeQueries',
  'DescribeQueryDefinitions', 'PutQueryDefinition', 'DeleteQueryDefinition',
  'PutRetentionPolicy', 'DeleteRetentionPolicy', 'ListTagsForResource',
  'DescribeMetricFilters', 'DescribeSubscriptionFilters',
]);

export function logsClientConfig(base, r) {
  const cfg = { ...base };
  delete cfg.endpoint;
  if (r.kind === 'endpoint') cfg.endpoint = r.logsEndpoint || r.endpoint;
  return cfg;
}

/**
 * CloudWatch Logs routes. Same contract as s3Routes: `resolve(raw)` turns the x-conn header into a connection,
 * `config(r)` builds the base SDK config, `serialize(out)` makes SDK output JSON safe.
 */
export function logsRoutes({ resolve, config, serialize }) {
  const clients = new Map();
  const router = express.Router();

  const clientFor = (r) => {
    if (!clients.has(r.key)) clients.set(r.key, new CWL.CloudWatchLogsClient(logsClientConfig(config(r), r)));
    return clients.get(r.key);
  };

  router.post('/op/:op', async (req, res) => {
    const op = req.params.op;
    if (!LOGS_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await resolve(req.get('x-conn'));
    const started = Date.now();
    const out = await clientFor(r).send(new CWL[`${op}Command`](req.body || {}));
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json(serialize(out));
  });

  return {
    router,
    listGroups: (r) => clientFor(r).send(new CWL.DescribeLogGroupsCommand({ limit: 50 })),
    clear: () => clients.clear(),
  };
}
