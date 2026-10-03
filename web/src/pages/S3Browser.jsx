import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Spinner, ErrorBox, Empty, useToast, copyText } from '../components/ui.jsx';
import { useTransfers } from '../components/Transfers.jsx';
import S3Details from '../components/S3Details.jsx';
import {
  CreateBucketModal, DeleteBucketModal, BucketPropsModal, NewFolderModal, NewFileModal, TransferModal, DeleteModal, ShareModal,
} from '../components/S3Modals.jsx';
import {
  s3, listPage, parseS3Route, s3Path, parentPrefix, fmtBytes, fmtDate, fileIcon, typeLabel, copySource, expandSelection,
  deleteKeys, deletePrefix, downloadObject, pool, filesFromDrop, uploadBlob,
} from '../lib/s3.js';

export default function S3Browser({ arg = '' }) {
  const { conn } = useApp();
  const { bucket, prefix } = parseS3Route(arg);
  if (!conn) return <S3Welcome />;
  if (!bucket) return <BucketList />;
  return <ObjectBrowser key={bucket} bucket={bucket} prefix={prefix} />;
}

function S3Welcome() {
  return (
    <div className="page">
      <div className="hero">
        <h1>🪣 S3 Browser</h1>
        <p className="muted">Browse and manage Amazon S3 (or any S3-compatible storage) like a file manager.</p>
      </div>
      <div className="card">
        <h3>Get started</h3>
        <ol className="steps">
          <li>Open <a href="#/connections">Connections</a> to add an AWS profile, or a custom endpoint for MinIO / LocalStack.</li>
          <li>Pick the connection in the top bar (and a region for AWS profiles).</li>
          <li>Choose a bucket on the left, then upload, download, preview and organise objects.</li>
        </ol>
      </div>
    </div>
  );
}

// --- Bucket list -------------------------------------------------------------------------
function BucketList() {
  const { buckets, bucketInfo, bucketsState, reloadBuckets, info } = useApp();
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null);
  const shown = (bucketInfo || []).filter((b) => b.Name.toLowerCase().includes(filter.toLowerCase()));
  const hasRegion = (bucketInfo || []).some((b) => b.BucketRegion);
  return (
    <div className="page">
      <div className="page-head">
        <h2>🪣 Buckets <span className="muted count">({filter ? `${shown.length} of ${buckets.length}` : buckets.length})</span></h2>
        <span className="muted ellipsis">{info.label}{info.endpoint ? ` · ${info.endpoint}` : ''}</span>
        <div className="push-right row-gap">
          <input placeholder="Filter buckets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" onClick={reloadBuckets}>↻ Refresh</button>
          <button className="btn btn-primary" onClick={() => setModal({ type: 'create' })}>＋ Create bucket</button>
        </div>
      </div>
      <ErrorBox error={bucketsState.error} />
      {bucketsState.loading && <Spinner />}
      {!bucketsState.loading && !bucketsState.error && !buckets.length && <Empty>No buckets. Create one to get started.</Empty>}
      {shown.length > 0 && (
        <div className="grid-wrap bucket-wrap">
          <table className="grid bucket-table">
            <thead>
              <tr>
                <th className="col-name">Name</th>
                {hasRegion && <th className="col-region">AWS Region</th>}
                <th className="col-created">Created</th>
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.Name} onDoubleClick={() => navigate(s3Path(b.Name))}>
                  <td className="col-name" title={b.Name}><a href={`#${s3Path(b.Name)}`}>🪣 {b.Name}</a></td>
                  {hasRegion && <td className="col-region">{b.BucketRegion || '—'}</td>}
                  <td className="col-created">{fmtDate(b.CreationDate)}</td>
                  <td className="row-actions col-act">
                    <button className="btn btn-xs" onClick={() => setModal({ type: 'props', bucket: b.Name })}>Properties</button>
                    <button className="btn btn-xs btn-danger" onClick={() => setModal({ type: 'delete', bucket: b.Name })}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal?.type === 'create' && (
        <CreateBucketModal
          onClose={() => setModal(null)}
          onCreated={(name) => {
            setModal(null);
            reloadBuckets();
            navigate(s3Path(name));
          }}
        />
      )}
      {modal?.type === 'props' && <BucketPropsModal bucket={modal.bucket} onClose={() => setModal(null)} />}
      {modal?.type === 'delete' && (
        <DeleteBucketModal
          bucket={modal.bucket}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            reloadBuckets();
          }}
        />
      )}
    </div>
  );
}

// --- Object browser ------------------------------------------------------------------------
const COLS = [
  ['name', 'Name'],
  ['size', 'Size'],
  ['type', 'Type'],
  ['modified', 'Last modified'],
  ['storageClass', 'Storage class'],
];

function sortItems(items, { by, dir }) {
  const val = (i) => (by === 'type' ? typeLabel(i) : by === 'modified' ? (i.modified ? new Date(i.modified).getTime() : 0) : i[by] ?? '');
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    return c * dir;
  });
}

function PathBar({ bucket, prefix }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const parts = prefix.split('/').filter(Boolean);
  const go = () => {
    const t = text.trim().replace(/^s3:\/\//, '').replace(/^\/+/, '');
    const i = t.indexOf('/');
    const b = i < 0 ? t : t.slice(0, i);
    let p = i < 0 ? '' : t.slice(i + 1);
    if (p && !p.endsWith('/')) p += '/';
    setEditing(false);
    if (b) navigate(s3Path(b, p));
  };
  if (editing) {
    return (
      <div className="pathbar">
        <span className="muted">s3://</span>
        <input
          autoFocus
          className="path-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className="pathbar"
      title="Click empty space to type a path"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setText(`${bucket}/${prefix}`);
          setEditing(true);
        }
      }}
    >
      <button className="icon-btn" title="Up one level (Backspace)" disabled={!prefix} onClick={() => navigate(s3Path(bucket, parentPrefix(prefix)))}>⬑</button>
      <a href="#/s3" className="crumb muted">S3</a>
      <span className="sep">/</span>
      <a href={`#${s3Path(bucket)}`} className="crumb">🪣 {bucket}</a>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          <span className="sep">/</span>
          <a href={`#${s3Path(bucket, `${parts.slice(0, i + 1).join('/')}/`)}`} className="crumb">{p}</a>
        </React.Fragment>
      ))}
      <button className="icon-btn path-copy" title="Copy S3 URI" onClick={() => copyText(`s3://${bucket}/${prefix}`)}>⧉</button>
    </div>
  );
}

function ContextMenu({ menu, onClose, children }) {
  const ref = useRef();
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const style = { left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 380) };
  return (
    <div ref={ref} className="ctx-menu" style={style} role="menu" onClick={onClose}>
      {children}
    </div>
  );
}
const MenuItem = ({ icon, label, hint, onClick, disabled, danger }) => (
  <button role="menuitem" className={danger ? 'danger' : ''} onClick={onClick} disabled={disabled}>
    <span className="mi-icon">{icon}</span>
    <span>{label}</span>
    {hint && <span className="mi-hint">{hint}</span>}
  </button>
);

function ObjectBrowser({ bucket, prefix }) {
  const { reloadBuckets } = useApp();
  const toast = useToast();
  const { upload, job, version, clip, setClip } = useTransfers();
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [sort, setSort] = useState({ by: 'name', dir: 1 });
  const [filter, setFilter] = useState('');
  const [showDetails, setShowDetails] = useState(true);
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(null);
  const [drag, setDrag] = useState(0);
  const [uploadMenu, setUploadMenu] = useState(false);
  const fileInput = useRef();
  const folderInput = useRef();
  const listRef = useRef();
  const seq = useRef(0);

  const load = useCallback(
    async (token = null, all = false) => {
      const my = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        let t = token;
        let acc = [];
        do {
          const page = await listPage(bucket, prefix, t);
          acc = acc.concat(page.items);
          t = page.next;
        } while (all && t && seq.current === my);
        if (seq.current !== my) return;
        setItems((cur) => (token ? [...cur, ...acc] : acc));
        setNext(t);
      } catch (e) {
        if (seq.current === my) setError(errorText(e));
      }
      if (seq.current === my) setLoading(false);
    },
    [bucket, prefix],
  );

  useEffect(() => {
    setItems([]);
    setSelected(new Set());
    setFilter('');
    load();
  }, [load]);

  // Refresh after background tasks finish (debounced).
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current) return;
    const t = setTimeout(() => load(), 700);
    return () => clearTimeout(t);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return sortItems(f ? items.filter((i) => i.name.toLowerCase().includes(f)) : items, sort);
  }, [items, filter, sort]);
  const sel = shown.filter((i) => selected.has(i.key));
  const selFiles = sel.filter((i) => i.type === 'file');
  const single = sel.length === 1 ? sel[0] : null;
  const detail = showDetails && single?.type === 'file' ? single : null;

  const open = (item) => {
    if (item.type === 'folder') navigate(s3Path(bucket, item.key));
    else {
      setSelected(new Set([item.key]));
      setShowDetails(true);
    }
  };

  const clickRow = (e, item, idx) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      const range = shown.slice(a, b + 1).map((i) => i.key);
      setSelected(new Set(e.metaKey || e.ctrlKey ? [...selected, ...range] : range));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const s = new Set(selected);
      s.has(item.key) ? s.delete(item.key) : s.add(item.key);
      setSelected(s);
    } else setSelected(new Set([item.key]));
    setAnchor(idx);
  };
  const toggle = (item, idx) => {
    const s = new Set(selected);
    s.has(item.key) ? s.delete(item.key) : s.add(item.key);
    setSelected(s);
    setAnchor(idx);
  };
  const allChecked = shown.length > 0 && shown.every((i) => selected.has(i.key));

  // --- actions -----------------------------------------------------------------------
  const startUpload = (list) => {
    if (!list.length) return;
    upload(bucket, list.map(({ file, path }) => ({ file, key: `${prefix}${path}` })));
    toast(`Uploading ${list.length} file${list.length > 1 ? 's' : ''}`);
  };

  const download = async (list = sel) => {
    try {
      let files = list.filter((i) => i.type === 'file');
      if (list.some((i) => i.type === 'folder')) files = await expandSelection(bucket, list, prefix);
      files = files.filter((f) => !f.key.endsWith('/'));
      if (files.length > 10 && !window.confirm(`Download ${files.length} files? The browser may ask to allow multiple downloads.`)) return;
      files.forEach((f, i) => setTimeout(() => downloadObject(bucket, f.key), i * 350));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const transfer = (list, { srcBucket = bucket, base = prefix, destBucket, destPrefix, move, rename }) =>
    job(move ? 'move' : 'copy', `${rename ? 'Rename' : move ? 'Move' : 'Copy'} ${list.length === 1 ? list[0].name : `${list.length} items`} → s3://${destBucket}/${destPrefix}`, async (progress, signal) => {
      const objs = await expandSelection(srcBucket, list, base);
      progress(0, objs.length);
      const copied = [];
      await pool(
        objs,
        4,
        async (o) => {
          await s3('CopyObject', { Bucket: destBucket, Key: `${destPrefix}${o.rel}`, CopySource: copySource(srcBucket, o.key) });
          copied.push(o.key);
          progress(copied.length, objs.length);
        },
        signal,
      );
      if (move) {
        const errs = await deleteKeys(srcBucket, copied);
        if (errs.length) throw new Error(`Copied, but could not delete ${errs.length} originals (${errs[0].Code})`);
      }
      return objs.length;
    })
      .then((n) => toast(`${rename ? 'Renamed' : move ? 'Moved' : 'Copied'} ${n} object${n === 1 ? '' : 's'}`))
      .catch((e) => toast(errorText(e), 'error'));

  const remove = (list) => {
    setModal(null);
    setSelected(new Set());
    job('delete', `Delete ${list.length === 1 ? list[0].key : `${list.length} items`}`, async (progress) => {
      const files = list.filter((i) => i.type === 'file').map((i) => i.key);
      const folders = list.filter((i) => i.type === 'folder');
      let done = 0;
      progress(0, list.length);
      const errs = await deleteKeys(bucket, files);
      done += files.length;
      progress(done, list.length);
      for (const f of folders) {
        const out = await deletePrefix(bucket, f.key);
        errs.push(...out.errors.map((e) => ({ Key: e.key, Code: e.code })));
        progress(++done, list.length);
      }
      if (errs.length) throw new Error(`${errs.length} objects not deleted, e.g. ${errs[0].Key}: ${errs[0].Code}`);
    })
      .then(() => toast('Deleted'))
      .catch((e) => toast(errorText(e), 'error'));
  };

  const paste = () => {
    if (!clip) return;
    if (clip.bucket === bucket && clip.prefix === prefix) return toast('Items are already in this folder', 'error');
    if (clip.bucket === bucket && clip.items.some((i) => i.type === 'folder' && prefix.startsWith(i.key))) return toast('Cannot paste a folder into itself', 'error');
    transfer(clip.items, { srcBucket: clip.bucket, base: clip.prefix, destBucket: bucket, destPrefix: prefix, move: clip.cut });
    if (clip.cut) setClip(null);
  };
  const copyToClip = (cut, list = sel) => {
    if (!list.length) return;
    setClip({ bucket, prefix, items: list, cut });
    toast(`${list.length} item${list.length > 1 ? 's' : ''} ${cut ? 'cut' : 'copied'} — open a folder and paste`);
  };

  const createFile = async (key, text) => {
    setModal(null);
    try {
      await uploadBlob(bucket, key, new Blob([text], { type: 'text/plain' })).promise;
      toast('File created');
      load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || modal) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'a') {
      e.preventDefault();
      setSelected(new Set(shown.map((i) => i.key)));
    } else if (mod && e.key === 'c') copyToClip(false);
    else if (mod && e.key === 'x') copyToClip(true);
    else if (mod && e.key === 'v') paste();
    else if (e.key === 'Delete' || (e.key === 'Backspace' && mod)) sel.length && setModal({ type: 'delete', items: sel });
    else if (e.key === 'Backspace' && prefix) navigate(s3Path(bucket, parentPrefix(prefix)));
    else if (e.key === 'Enter' && single) open(single);
    else if (e.key === 'F2' && single) setModal({ type: 'rename', items: [single] });
    else if (e.key === 'Escape') setSelected(new Set());
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = anchor ?? -1;
      const idx = Math.max(0, Math.min(shown.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      if (shown[idx]) {
        setSelected(new Set([shown[idx].key]));
        setAnchor(idx);
        listRef.current?.querySelectorAll('tbody tr')[idx + (prefix ? 1 : 0)]?.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(0);
    try {
      startUpload(await filesFromDrop(e.dataTransfer));
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  const folders = items.filter((i) => i.type === 'folder').length;
  const files = items.length - folders;
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  const selSize = selFiles.reduce((s, i) => s + (i.size || 0), 0);

  const detailActions = detail && (
    <>
      <button className="btn btn-xs" onClick={() => download([detail])}>⬇ Download</button>
      <button className="btn btn-xs" onClick={() => setModal({ type: 'share', item: detail })}>🔗 Share</button>
      <button className="btn btn-xs" onClick={() => setModal({ type: 'rename', items: [detail] })}>✎ Rename</button>
      <button className="btn btn-xs btn-danger" onClick={() => setModal({ type: 'delete', items: [detail] })}>🗑 Delete</button>
    </>
  );

  return (
    <div className="page s3-page" onKeyDown={onKey}>
      <div className="page-head">
        <h2 className="ellipsis">🪣 {bucket}</h2>
        <div className="push-right row-gap">
          <button className="btn btn-sm" onClick={() => setModal({ type: 'bucket-props' })}>⚙ Bucket properties</button>
          <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: 'bucket-delete' })}>Delete bucket</button>
        </div>
      </div>

      <div className="s3-toolbar">
        <div className="dropdown">
          <button className="btn btn-primary" onClick={() => setUploadMenu(!uploadMenu)} onBlur={() => setTimeout(() => setUploadMenu(false), 150)}>⬆ Upload ▾</button>
          {uploadMenu && (
            <div className="dropdown-menu">
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setUploadMenu(false); fileInput.current.click(); }}>📄 Files…</button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setUploadMenu(false); folderInput.current.click(); }}>📁 Folder…</button>
            </div>
          )}
        </div>
        <input ref={fileInput} type="file" multiple hidden data-testid="file-input" onChange={(e) => { startUpload([...e.target.files].map((file) => ({ file, path: file.name }))); e.target.value = ''; }} />
        <input ref={folderInput} type="file" multiple hidden onChange={(e) => { startUpload([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); e.target.value = ''; }} />
        <button className="btn" onClick={() => setModal({ type: 'folder' })}>＋ Folder</button>
        <button className="btn" onClick={() => setModal({ type: 'file' })}>＋ Text file</button>
        <span className="tb-sep" />
        <button className="btn" disabled={!sel.length} onClick={() => download()}>⬇ Download</button>
        <button className="btn" disabled={!sel.length} onClick={() => setModal({ type: 'copy', items: sel })}>⧉ Copy to…</button>
        <button className="btn" disabled={!sel.length} onClick={() => setModal({ type: 'move', items: sel })}>➜ Move to…</button>
        <button className="btn" disabled={!single} onClick={() => setModal({ type: 'rename', items: [single] })}>✎ Rename</button>
        <button className="btn" disabled={!single || single.type !== 'file'} onClick={() => setModal({ type: 'share', item: single })}>🔗 Share</button>
        <button className="btn btn-danger" disabled={!sel.length} onClick={() => setModal({ type: 'delete', items: sel })}>🗑 Delete</button>
        {clip && <button className="btn" onClick={paste} title={`Paste ${clip.items.length} item(s) from s3://${clip.bucket}/${clip.prefix}`}>📋 Paste ({clip.items.length})</button>}
        <span className="push-right tb-right">
          <input className="s3-filter" placeholder="Filter this folder…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" title="Refresh" onClick={() => load()}>↻</button>
          <button className={`btn${showDetails ? ' active' : ''}`} title="Toggle details panel" onClick={() => setShowDetails(!showDetails)}>◨</button>
        </span>
      </div>

      <PathBar bucket={bucket} prefix={prefix} />
      <ErrorBox error={error} onClose={() => setError(null)} />

      <div className={`s3-layout${detail ? ' with-details' : ''}`}>
        <div
          className={`s3-list${drag ? ' dragging' : ''}`}
          ref={listRef}
          tabIndex={0}
          onDragEnter={(e) => isFileDrag(e) && setDrag((d) => d + 1)}
          onDragLeave={(e) => isFileDrag(e) && setDrag((d) => Math.max(0, d - 1))}
          onDragOver={(e) => isFileDrag(e) && e.preventDefault()}
          onDrop={onDrop}
          onContextMenu={(e) => {
            if (e.target.closest('tbody tr')) return;
            e.preventDefault();
            setSelected(new Set());
            setMenu({ x: e.clientX, y: e.clientY, empty: true });
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget || e.target.classList.contains('grid-wrap')) setSelected(new Set());
          }}
        >
          {drag > 0 && <div className="drop-overlay">Drop files or folders to upload to <strong>s3://{bucket}/{prefix}</strong></div>}
          <div className="grid-wrap s3-grid">
            <table className="grid">
              <thead>
                <tr>
                  <th className="check-col">
                    <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(shown.map((i) => i.key)))} />
                  </th>
                  {COLS.map(([id, label]) => (
                    <th key={id} onClick={() => setSort({ by: id, dir: sort.by === id ? -sort.dir : 1 })} className={id === 'size' ? 'num' : ''}>
                      {label} {sort.by === id && (sort.dir > 0 ? '▲' : '▼')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prefix && (
                  <tr className="up-row" onDoubleClick={() => navigate(s3Path(bucket, parentPrefix(prefix)))}>
                    <td />
                    <td colSpan={COLS.length}><a href={`#${s3Path(bucket, parentPrefix(prefix))}`}>⬑ ..</a></td>
                  </tr>
                )}
                {shown.map((it, idx) => (
                  <tr
                    key={it.key}
                    className={selected.has(it.key) ? 'selected' : ''}
                    onClick={(e) => clickRow(e, it, idx)}
                    onDoubleClick={() => (it.type === 'folder' ? open(it) : download([it]))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected.has(it.key)) {
                        setSelected(new Set([it.key]));
                        setAnchor(idx);
                      }
                      setMenu({ x: e.clientX, y: e.clientY });
                    }}
                  >
                    <td className="check-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${it.name}`} checked={selected.has(it.key)} onChange={() => toggle(it, idx)} />
                    </td>
                    <td className="name-col" title={it.key}>
                      <span className="f-icon">{fileIcon(it)}</span>
                      {it.type === 'folder' ? (
                        <a href={`#${s3Path(bucket, it.key)}`} onClick={(e) => e.stopPropagation()}>{it.name}/</a>
                      ) : (
                        it.name
                      )}
                    </td>
                    <td className="num">{it.type === 'folder' ? '' : fmtBytes(it.size)}</td>
                    <td className="muted">{typeLabel(it)}</td>
                    <td>{it.modified ? fmtDate(it.modified) : ''}</td>
                    <td className="muted small">{it.storageClass || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && !error && !items.length && (
              <div className="empty s3-empty">
                This folder is empty.
                <div className="muted small">Drag & drop files or folders here, or use Upload.</div>
              </div>
            )}
            {!loading && items.length > 0 && !shown.length && <div className="empty s3-empty">No items match “{filter}”.</div>}
          </div>
          <div className="s3-status">
            {loading ? <Spinner /> : null}
            <span>{folders} folder{folders === 1 ? '' : 's'}, {files} file{files === 1 ? '' : 's'} · {fmtBytes(totalSize)}{next ? ' (more not loaded)' : ''}</span>
            {sel.length > 0 && <span className="muted">· {sel.length} selected{selFiles.length ? ` (${fmtBytes(selSize)})` : ''}</span>}
            {next && (
              <span className="push-right row-gap">
                <button className="btn btn-xs" disabled={loading} onClick={() => load(next)}>Load more</button>
                <button className="btn btn-xs" disabled={loading} onClick={() => load(next, true)}>Load all</button>
              </span>
            )}
          </div>
        </div>

        {detail && (
          <S3Details
            key={detail.key}
            bucket={bucket}
            item={detail}
            onClose={() => setShowDetails(false)}
            onChanged={() => load()}
            actions={detailActions}
          />
        )}
      </div>

      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {menu.empty ? (
            <>
              <MenuItem icon="⬆" label="Upload files…" onClick={() => fileInput.current.click()} />
              <MenuItem icon="📁" label="Upload folder…" onClick={() => folderInput.current.click()} />
              <MenuItem icon="＋" label="New folder" onClick={() => setModal({ type: 'folder' })} />
              <MenuItem icon="📝" label="New text file" onClick={() => setModal({ type: 'file' })} />
              <MenuItem icon="📋" label="Paste" hint="Ctrl+V" disabled={!clip} onClick={paste} />
              <MenuItem icon="↻" label="Refresh" onClick={() => load()} />
            </>
          ) : (
            <>
              {single && <MenuItem icon={single.type === 'folder' ? '📂' : '👁'} label={single.type === 'folder' ? 'Open' : 'Preview / properties'} hint="Enter" onClick={() => open(single)} />}
              <MenuItem icon="⬇" label="Download" onClick={() => download()} />
              {single?.type === 'file' && <MenuItem icon="🔗" label="Share / pre-signed URL" onClick={() => setModal({ type: 'share', item: single })} />}
              <MenuItem icon="⧉" label="Copy S3 URI" onClick={() => copyText(sel.map((i) => `s3://${bucket}/${i.key}`).join('\n')).then(() => toast('Copied'))} />
              <div className="mi-sep" />
              <MenuItem icon="⎘" label="Copy" hint="Ctrl+C" onClick={() => copyToClip(false)} />
              <MenuItem icon="✂" label="Cut" hint="Ctrl+X" onClick={() => copyToClip(true)} />
              <MenuItem icon="📋" label="Paste" hint="Ctrl+V" disabled={!clip} onClick={paste} />
              <MenuItem icon="⧉" label="Copy to…" onClick={() => setModal({ type: 'copy', items: sel })} />
              <MenuItem icon="➜" label="Move to…" onClick={() => setModal({ type: 'move', items: sel })} />
              {single && <MenuItem icon="✎" label="Rename" hint="F2" onClick={() => setModal({ type: 'rename', items: [single] })} />}
              <div className="mi-sep" />
              <MenuItem icon="🗑" label="Delete" hint="Del" danger onClick={() => setModal({ type: 'delete', items: sel })} />
            </>
          )}
        </ContextMenu>
      )}

      {modal?.type === 'folder' && (
        <NewFolderModal bucket={bucket} prefix={prefix} onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />
      )}
      {modal?.type === 'file' && <NewFileModal bucket={bucket} prefix={prefix} onClose={() => setModal(null)} onCreate={createFile} />}
      {['copy', 'move', 'rename'].includes(modal?.type) && (
        <TransferModal
          mode={modal.type}
          bucket={bucket}
          prefix={prefix}
          items={modal.items}
          onClose={() => setModal(null)}
          onSubmit={({ destBucket, destPrefix, rename }) => {
            const list = modal.items;
            setModal(null);
            if (rename) {
              setSelected(new Set());
              transfer(list, { base: list[0].key, destBucket, destPrefix, move: true, rename: true });
            } else transfer(list, { destBucket, destPrefix, move: modal.type === 'move' });
          }}
        />
      )}
      {modal?.type === 'delete' && <DeleteModal items={modal.items} onClose={() => setModal(null)} onConfirm={() => remove(modal.items)} />}
      {modal?.type === 'share' && <ShareModal bucket={bucket} item={modal.item} onClose={() => setModal(null)} />}
      {modal?.type === 'bucket-props' && <BucketPropsModal bucket={bucket} onClose={() => setModal(null)} />}
      {modal?.type === 'bucket-delete' && (
        <DeleteBucketModal
          bucket={bucket}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            reloadBuckets();
            navigate('/s3');
          }}
        />
      )}
    </div>
  );
}
