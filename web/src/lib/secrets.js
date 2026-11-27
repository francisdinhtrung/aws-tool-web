import { api } from '../api.js';

export const secrets = (op, body = {}, signal) => api(`/api/secrets/op/${op}`, { method: 'POST', body, signal });
