import React, { useState } from 'react';
import { errorText } from '../api.js';
import { secrets } from '../lib/secrets.js';
import { ErrorBox, Field, Modal, Select, Spinner } from './ui.jsx';

export function SecretEditor({ secret, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState(secret?.Description || '');
  const [format, setFormat] = useState('text');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const descriptionChanged = description !== (secret?.Description || '');
  const ready = secret ? descriptionChanged || value.length > 0 : /^[a-zA-Z0-9/_+=.@-]+$/.test(name) && value.length > 0;
  const close = () => { if (!busy) onClose(); };

  const save = async (e) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const input = secret ? { SecretId: secret.ARN || secret.Name } : { Name: name };
      if (descriptionChanged) input.Description = description;
      if (value.length) input[format === 'binary' ? 'SecretBinary' : 'SecretString'] = value;
      const result = await secrets(secret ? 'UpdateSecret' : 'CreateSecret', input);
      onSaved({ ARN: result.ARN || secret?.ARN, Name: result.Name || secret?.Name || name, Description: description });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={secret ? 'Edit secret' : 'Create secret'} onClose={close}>
      <form onSubmit={save} autoComplete="off">
        {!secret && (
          <Field label="Name" hint="Letters, numbers, and / _ + = . @ - are allowed.">
            <input autoFocus maxLength={256} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </Field>
        )}
        <Field label="Description">
          <input autoFocus={Boolean(secret)} maxLength={2048} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Value format">
          <Select value={format} onChange={setFormat} disabled={busy} options={[[ 'text', 'Text or JSON' ], [ 'binary', 'Binary (Base64)' ]]} />
        </Field>
        <Field label={secret ? 'New secret value' : 'Secret value'} hint={secret ? 'Leave blank to keep the current value. Saving a new value creates a version.' : undefined}>
          <textarea className="mono" rows={6} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" disabled={busy} />
        </Field>
        <ErrorBox error={error} />
        <div className="row-gap">
          <button type="button" className="btn push-right" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>{busy ? <Spinner /> : secret ? 'Save changes' : 'Create secret'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ScheduleSecretDeletion({ secret, onClose, onScheduled }) {
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const recoveryDays = Number(days);
  const valid = Number.isInteger(recoveryDays) && recoveryDays >= 7 && recoveryDays <= 30;
  const close = () => { if (!busy) onClose(); };

  const schedule = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await secrets('DeleteSecret', { SecretId: secret.ARN || secret.Name, RecoveryWindowInDays: recoveryDays });
      onScheduled(result.DeletionDate);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Schedule deletion" onClose={close} footer={(
      <>
        <button className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" onClick={schedule} disabled={!valid || busy}>{busy ? <Spinner /> : 'Schedule deletion'}</button>
      </>
    )}>
      <p>Schedule deletion for <strong>{secret.Name}</strong>. You can restore the secret during the recovery window.</p>
      <Field label="Recovery window (days)" hint="7 to 30 days">
        <input autoFocus type="number" min={7} max={30} step={1} value={days} onChange={(e) => setDays(e.target.value)} disabled={busy} />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  );
}
