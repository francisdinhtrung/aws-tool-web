let currentConn = null;

export const setConn = (c) => {
  currentConn = c;
};
export const getConn = () => currentConn;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.name = body?.error || 'Error';
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, conn } = {}) {
  const headers = { 'x-requested-with': 'dynamodb-studio' };
  const c = conn === undefined ? currentConn : conn;
  if (c) headers['x-conn'] = encodeURIComponent(JSON.stringify(c));
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new ApiError(res.status, data);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.defineProperty(data, '$elapsed', { value: Number(res.headers.get('x-elapsed-ms') || 0), enumerable: false });
    Object.defineProperty(data, '$region', { value: res.headers.get('x-bucket-region') || undefined, enumerable: false });
  }
  return data;
}

export const ddb = (op, input = {}, conn) => api(`/api/ddb/${op}`, { method: 'POST', body: input, conn });

export function errorText(e) {
  if (!e) return '';
  let s = e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message || String(e);
  const reasons = e.body?.cancellationReasons;
  if (reasons?.length) s += '\n' + reasons.map((r, i) => `  [${i}] ${r.Code}${r.Message ? ` - ${r.Message}` : ''}`).join('\n');
  return s;
}
