import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export function Modal({ title, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal modal-${size}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange, small }) {
  return (
    <div className={`tabs${small ? ' tabs-sm' : ''}`} role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, inline }) {
  return (
    <label className={`field${inline ? ' field-inline' : ''}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, ...rest }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function ErrorBox({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="alert alert-error">
      <pre>{typeof error === 'string' ? error : error.message}</pre>
      {onClose && <button className="icon-btn" onClick={onClose}>×</button>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function CodeBlock({ code, maxHeight }) {
  const toast = useToast();
  return (
    <div className="code-wrap">
      <button className="btn btn-xs copy-btn" onClick={() => copyText(code).then(() => toast('Copied'))}>Copy</button>
      <pre className="code" style={maxHeight ? { maxHeight } : undefined}>{code}</pre>
    </div>
  );
}

export function JsonArea({ value, onChange, rows = 12, placeholder, readOnly }) {
  return (
    <textarea
      className="mono"
      spellCheck={false}
      rows={rows}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Tab' && !readOnly) {
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: en } = el;
          const v = el.value.slice(0, s) + '  ' + el.value.slice(en);
          onChange?.(v);
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }
      }}
    />
  );
}

export function Progress({ value, max, label }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress-wrap">
      <div className="progress">
        <div style={{ width: `${max ? pct : 100}%` }} className={max ? '' : 'indeterminate'} />
      </div>
      <span className="muted small">{label ?? (max ? `${value} / ${max} (${pct}%)` : value)}</span>
    </div>
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function download(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function FileButton({ accept, onFile, children, className = 'btn' }) {
  const ref = useRef();
  return (
    <>
      <button className={className} onClick={() => ref.current.click()}>{children}</button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}

// --- Toasts ---------------------------------------------------------------------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

let uid = 0;
export const nextId = () => `r${++uid}`;

export function useLocalStorage(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : JSON.parse(s);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  }, [key, v]);
  return [v, setV];
}
