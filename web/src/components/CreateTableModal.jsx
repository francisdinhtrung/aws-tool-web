import React, { useMemo, useState } from 'react';
import { Modal, ErrorBox, Spinner, Tabs, CodeBlock, useToast } from './ui.jsx';
import TableDefEditor, { emptyDef, normalizeDef, validateDef } from './TableDefEditor.jsx';
import { createTableInput, genCode, CODE_LANGS } from '../lib/dynamo.js';
import { ddb, errorText } from '../api.js';
import { useApp } from '../context.js';

export default function CreateTableModal({ onClose, onCreated, initial }) {
  const { info } = useApp();
  const toast = useToast();
  const [def, setDef] = useState(() => initial || emptyDef());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('form');

  const input = useMemo(() => {
    try {
      return createTableInput(normalizeDef(def));
    } catch {
      return null;
    }
  }, [def]);

  const create = async () => {
    const d = normalizeDef(def);
    const err = validateDef(d);
    if (err) return setError(err);
    setBusy(true);
    setError(null);
    try {
      await ddb('CreateTable', createTableInput(d));
      toast(`Table ${d.TableName} is being created`);
      onCreated(d.TableName);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create table"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? <Spinner /> : 'Create table'}</button>
        </>
      }
    >
      <Tabs tabs={[['form', 'Definition'], ...CODE_LANGS]} value={tab} onChange={setTab} small />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {tab === 'form' ? (
        <TableDefEditor def={def} onChange={setDef} live />
      ) : (
        <CodeBlock code={input ? genCode('CreateTable', input, tab, info) : 'Invalid definition'} maxHeight="50vh" />
      )}
    </Modal>
  );
}
