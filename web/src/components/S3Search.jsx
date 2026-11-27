import React, { useEffect, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { fmtBytes, listPage, s3ObjectPath } from '../lib/s3.js';
import { ErrorBox, Field, Modal, Spinner } from './ui.jsx';

const MATCHES_PER_BATCH = 100;

export default function S3Search({ bucket, prefix, onClose }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const sequence = useRef(0);

  useEffect(() => () => { sequence.current += 1; }, []);

  const search = async (query, previous) => {
    const id = ++sequence.current;
    const term = query.toLowerCase();
    let items = previous?.items || [];
    const start = items.length;
    let checked = previous?.checked || 0;
    let next = previous?.next || null;
    setResult({ query, items, checked, loading: true });
    let error;
    try {
      do {
        const page = await listPage(bucket, prefix, next, { delimiter: false });
        if (id !== sequence.current) return;
        const matches = page.items.filter((item) => item.type === 'file' && item.key.slice(prefix.length).toLowerCase().includes(term));
        items = items.concat(matches);
        checked += page.items.length;
        next = page.next;
        setResult({ query, items, checked, loading: true });
      } while (next && items.length - start < MATCHES_PER_BATCH);
    } catch (e) {
      error = errorText(e);
    }
    if (id === sequence.current) setResult({ query, items, checked, next, error, loading: false });
  };

  return (
    <Modal title="Search files" size="lg" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) search(input.trim()); }}>
        <Field label="Name or path" hint={`Includes subfolders in s3://${bucket}/${prefix}`}>
          <input autoFocus type="search" value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={!input.trim() || (result?.loading && result.query === input.trim())}>Search</button>
      </form>
      <ErrorBox error={result?.error} />
      {result && (
        <div className="mt">
          {result.items.length > 0 && (
            <div className="grid-wrap s3-search-results">
              <table className="grid">
                <thead><tr><th>Path</th><th>Size</th></tr></thead>
                <tbody>
                  {result.items.map((item) => (
                    <tr key={item.key}>
                      <td title={item.key}><a href={`#${encodeURI(s3ObjectPath(bucket, item.key))}`}>{item.key.slice(prefix.length)}</a></td>
                      <td>{fmtBytes(item.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="s3-status" role="status">
            {result.loading && <><Spinner /> Searching for “{result.query}”…</>}
            {!result.loading && !result.error && !result.items.length && <span>No files match “{result.query}”.</span>}
            {result.items.length > 0 && <span>{result.items.length} match{result.items.length === 1 ? '' : 'es'}{result.loading || result.next ? ' so far' : ''}</span>}
            {result.checked > 0 && <span>{result.checked.toLocaleString()} keys checked</span>}
            {result.next && <button className="btn btn-xs push-right" onClick={() => search(result.query, result)}>{result.error ? 'Retry' : 'Load more results'}</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}
