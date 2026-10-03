import express from 'express';
import * as SFN from '@aws-sdk/client-sfn';
import { HttpError } from './profiles.js';

// Step Functions API surface exposed to the UI. Deleting a state machine is confirmed in the UI (the user types the name).
export const SFN_COMMANDS = new Set([
  'ListStateMachines', 'DescribeStateMachine', 'CreateStateMachine', 'UpdateStateMachine', 'DeleteStateMachine',
  'ValidateStateMachineDefinition', 'TestState',
  'ListExecutions', 'DescribeExecution', 'StartExecution', 'StartSyncExecution', 'StopExecution', 'RedriveExecution',
  'GetExecutionHistory', 'DescribeStateMachineForExecution', 'ListMapRuns', 'DescribeMapRun',
  'ListStateMachineVersions', 'PublishStateMachineVersion', 'DeleteStateMachineVersion',
  'ListStateMachineAliases', 'DescribeStateMachineAlias', 'CreateStateMachineAlias', 'UpdateStateMachineAlias', 'DeleteStateMachineAlias',
  'ListActivities', 'DescribeActivity', 'CreateActivity', 'DeleteActivity',
  'ListTagsForResource', 'TagResource', 'UntagResource',
]);

export function sfnClientConfig(base, r) {
  const cfg = { ...base };
  delete cfg.endpoint;
  if (r.kind === 'endpoint') {
    cfg.endpoint = r.sfnEndpoint || r.endpoint;
    // StartSyncExecution / TestState prepend "sync-" to the host name, which a local emulator does not resolve.
    cfg.disableHostPrefix = true;
  }
  return cfg;
}

/** Step Functions routes. Same contract as sqsRoutes / lambdaRoutes. */
export function sfnRoutes({ resolve, config, serialize }) {
  const clients = new Map();
  const router = express.Router();

  const clientFor = (r) => {
    if (!clients.has(r.key)) clients.set(r.key, new SFN.SFNClient(sfnClientConfig(config(r), r)));
    return clients.get(r.key);
  };

  router.post('/op/:op', async (req, res) => {
    const op = req.params.op;
    if (!SFN_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await resolve(req.get('x-conn'));
    const started = Date.now();
    let out;
    try {
      out = await clientFor(r).send(new SFN[`${op}Command`](req.body || {}));
    } catch (e) {
      // Emulators answer unknown actions with an HTML page, which the SDK reports as a deserialization error.
      if (e.name === 'SyntaxError' && /Deserialization error/.test(e.message)) {
        throw new HttpError(501, 'NotSupported', `${op} is not supported by this endpoint (it did not return a Step Functions response)`);
      }
      throw e;
    }
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json(serialize(out));
  });

  return {
    router,
    listStateMachines: (r) => clientFor(r).send(new SFN.ListStateMachinesCommand({ maxResults: 1000 })),
    clear: () => clients.clear(),
  };
}
