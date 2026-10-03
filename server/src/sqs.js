import express from 'express';
import * as SQS from '@aws-sdk/client-sqs';
import { HttpError } from './profiles.js';

// SQS API surface exposed to the UI. DeleteQueue / PurgeQueue are confirmed in the UI.
export const SQS_COMMANDS = new Set([
  'ListQueues', 'GetQueueUrl', 'GetQueueAttributes', 'SetQueueAttributes', 'CreateQueue', 'DeleteQueue', 'PurgeQueue',
  'SendMessage', 'SendMessageBatch', 'ReceiveMessage', 'DeleteMessage', 'DeleteMessageBatch',
  'ChangeMessageVisibility', 'ChangeMessageVisibilityBatch',
  'ListQueueTags', 'TagQueue', 'UntagQueue', 'ListDeadLetterSourceQueues',
  'StartMessageMoveTask', 'ListMessageMoveTasks', 'CancelMessageMoveTask',
]);

export function sqsClientConfig(base, r) {
  const cfg = { ...base };
  delete cfg.endpoint;
  if (r.kind === 'endpoint') {
    cfg.endpoint = r.sqsEndpoint || r.endpoint;
    // Queue URLs from LocalStack / ElasticMQ often use a host name only reachable from the emulator itself.
    cfg.useQueueUrlAsEndpoint = false;
  }
  return cfg;
}

// Message attribute binary values travel as base64 strings in JSON.
export function reviveSqsInput(node) {
  if (Array.isArray(node)) return node.map(reviveSqsInput);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'BinaryValue' && typeof v === 'string') out[k] = Buffer.from(v, 'base64');
      else if (k === 'BinaryListValues' && Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? Buffer.from(x, 'base64') : x));
      else out[k] = reviveSqsInput(v);
    }
    return out;
  }
  return node;
}

/** SQS routes. Same contract as s3Routes / logsRoutes. */
export function sqsRoutes({ resolve, config, serialize }) {
  const clients = new Map();
  const router = express.Router();

  const clientFor = (r) => {
    if (!clients.has(r.key)) clients.set(r.key, new SQS.SQSClient(sqsClientConfig(config(r), r)));
    return clients.get(r.key);
  };

  router.post('/op/:op', async (req, res) => {
    const op = req.params.op;
    if (!SQS_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await resolve(req.get('x-conn'));
    const started = Date.now();
    let out;
    try {
      out = await clientFor(r).send(new SQS[`${op}Command`](reviveSqsInput(req.body || {})));
    } catch (e) {
      // Emulators answer unknown actions with an HTML page, which the SDK reports as a deserialization error.
      if (e.name === 'SyntaxError' && /Deserialization error/.test(e.message)) {
        throw new HttpError(501, 'NotSupported', `${op} is not supported by this endpoint (it did not return an SQS response)`);
      }
      throw e;
    }
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json(serialize(out));
  });

  return {
    router,
    listQueues: (r) => clientFor(r).send(new SQS.ListQueuesCommand({ MaxResults: 1000 })),
    clear: () => clients.clear(),
  };
}
