import { createContext, useContext, useEffect, useState } from 'react';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function useHashRoute() {
  const read = () => decodeURI(window.location.hash.replace(/^#/, '')) || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => setRoute(read());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return route;
}

export const navigate = (path) => {
  window.location.hash = encodeURI(path);
};

// Connection info used for code generation (region / endpoint).
export function connInfo(conn, profiles, endpoints) {
  if (!conn) return {};
  if (conn.kind === 'endpoint') {
    const e = endpoints.find((x) => x.id === conn.id);
    return { region: e?.region, endpoint: e?.endpoint, label: e?.name };
  }
  if (conn.kind === 'profile') {
    const p = profiles.find((x) => x.name === conn.profile);
    return { region: conn.region || p?.region || 'us-east-1', label: conn.profile };
  }
  return { region: conn.region || 'us-east-1', label: 'Default chain' };
}
