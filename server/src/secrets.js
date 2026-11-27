import express from 'express';
import * as Secrets from '@aws-sdk/client-secrets-manager';
import { HttpError } from './profiles.js';

const COMMANDS = new Set(['ListSecrets', 'DescribeSecret', 'GetSecretValue', 'CreateSecret', 'UpdateSecret', 'DeleteSecret', 'RestoreSecret']);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function secretsRoutes({ resolve, config, serialize }) {
  const router = express.Router();
  const clients = new Map();

  const clientFor = (r) => {
    if (!clients.has(r.key)) {
      const cfg = config(r);
      if (r.kind === 'endpoint') cfg.endpoint = r.secretsEndpoint || r.endpoint;
      clients.set(r.key, new Secrets.SecretsManagerClient(cfg));
    }
    return clients.get(r.key);
  };

  router.post('/op/:op', async (req, res) => {
    const { op } = req.params;
    if (!COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', 'Secrets Manager operation is not supported');
    const input = { ...req.body };
    if (op === 'DeleteSecret') {
      delete input.ForceDeleteWithoutRecovery;
      input.RecoveryWindowInDays ??= 30;
      if (!Number.isInteger(input.RecoveryWindowInDays) || input.RecoveryWindowInDays < 7 || input.RecoveryWindowInDays > 30) {
        throw new HttpError(400, 'InvalidRecoveryWindow', 'Enter a recovery window from 7 to 30 days.');
      }
    }
    if (op === 'CreateSecret' || op === 'UpdateSecret') {
      if (input.SecretBinary !== undefined) {
        const binary = typeof input.SecretBinary === 'string' ? input.SecretBinary.replace(/\s/g, '') : '';
        if (!binary || !BASE64.test(binary) || input.SecretString !== undefined) {
          throw new HttpError(400, 'InvalidSecretBinary', 'Use a valid Base64 value for a binary secret.');
        }
        input.SecretBinary = Buffer.from(binary, 'base64');
      }
      const value = input.SecretBinary ?? input.SecretString;
      if (value !== undefined && (!value || (typeof value !== 'string' && !Buffer.isBuffer(value)) || Buffer.byteLength(value) > 65536)) {
        throw new HttpError(400, 'InvalidSecretValue', 'Enter a secret value from 1 to 65,536 bytes.');
      }
    }

    const r = await resolve(req.get('x-conn'));
    const out = serialize(await clientFor(r).send(new Secrets[`${op}Command`](input)));
    if (op === 'GetSecretValue') return res.type('json').end(JSON.stringify(out));
    res.json(out);
  });

  return {
    router,
    listSecrets: (r) => clientFor(r).send(new Secrets.ListSecretsCommand({ MaxResults: 100 })),
    clear: () => clients.clear(),
  };
}
