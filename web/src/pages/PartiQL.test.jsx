import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import PartiQL from './PartiQL.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

const editor = () => screen.getByPlaceholderText(/SELECT \* FROM/);
const run = () => fireEvent.click(screen.getByRole('button', { name: /Run/ }));
const setup = (handlers = {}, ctx = {}) => ({ api: mockBackend(handlers), ...renderWithApp(<PartiQL />, ctx) });

describe('<PartiQL>', () => {
  it('runs a single statement, paginates and records history', async () => {
    const { api } = setup({
      ExecuteStatement: (b) => (b.NextToken ? { Items: [{ id: { N: '2' } }] } : { Items: [{ id: { N: '1' } }], NextToken: 'tok' }),
    });
    expect(editor().placeholder).toContain('"Shop"');
    fireEvent.change(editor(), { target: { value: 'SELECT * FROM "Shop"' } });
    fireEvent.click(screen.getByLabelText('Strongly consistent'));
    run();
    expect(await screen.findByText(/ExecuteStatement · 3 ms · 1 items/)).toBeInTheDocument();
    expect(api.calls('ExecuteStatement')[0]).toEqual({ Statement: 'SELECT * FROM "Shop"', ConsistentRead: true });
    fireEvent.click(screen.getByText('Load more'));
    expect(await screen.findByText(/2 items/)).toBeInTheDocument();
    expect(api.calls('ExecuteStatement')[1].NextToken).toBe('tok');
    expect(screen.getAllByText('SELECT * FROM "Shop"', { selector: 'code' })).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ddbs.partiql.history'))).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ddbs.partiql.draft'))).toBe('SELECT * FROM "Shop"');
  });

  it('runs with Cmd/Ctrl+Enter and uses the fallback table name', async () => {
    const { api } = setup({ ExecuteStatement: { Items: [] } }, { tables: [] });
    expect(editor().placeholder).toContain('"MyTable"');
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.calls('ExecuteStatement')).toHaveLength(2));
  });

  it('validates statements per mode', async () => {
    setup();
    run();
    expect(await screen.findByText('Enter a statement')).toBeInTheDocument();
    fireEvent.change(editor(), { target: { value: "SELECT 'a;b' FROM t; SELECT 2;" } });
    run();
    expect(await screen.findByText(/Multiple statements found/)).toBeInTheDocument();
  });

  it('runs batch and transaction modes, splitting on semicolons outside quotes', async () => {
    const { api } = setup({ BatchExecuteStatement: { Responses: [{}, {}] }, ExecuteTransaction: { Responses: [] } });
    fireEvent.change(editor(), { target: { value: `INSERT INTO "T" VALUE {'pk': 'a;b'}; UPDATE "T" SET x = "y;z" WHERE pk = 'a';` } });
    fireEvent.click(screen.getByText('Batch'));
    fireEvent.click(screen.getByLabelText('Strongly consistent'));
    run();
    await waitFor(() => expect(api.calls('BatchExecuteStatement')).toHaveLength(1));
    expect(api.calls('BatchExecuteStatement')[0].Statements).toEqual([
      { Statement: `INSERT INTO "T" VALUE {'pk': 'a;b'}`, ConsistentRead: true },
      { Statement: `UPDATE "T" SET x = "y;z" WHERE pk = 'a'`, ConsistentRead: true },
    ]);
    expect(await screen.findByText(/"Responses"/)).toBeInTheDocument(); // raw view when no items

    fireEvent.click(screen.getByText('Transaction'));
    expect(screen.queryByLabelText('Strongly consistent')).toBeNull();
    run();
    await waitFor(() => expect(api.calls('ExecuteTransaction')).toHaveLength(1));
    expect(api.calls('ExecuteTransaction')[0].TransactStatements).toHaveLength(2);
  });

  it('shows errors, result views, exports and code generation', async () => {
    let fail = true;
    setup({ ExecuteStatement: () => { if (fail) throw awsError('ValidationException', 'Statement wasn\'t well formed'); return { Items: [{ id: { N: '1' }, name: { S: 'x' } }] }; } });
    fireEvent.change(editor(), { target: { value: 'SELEC' } });
    run();
    expect(await screen.findByText("ValidationException: Statement wasn't well formed")).toBeInTheDocument();
    fail = false;
    run();
    await screen.findByText(/1 items/);
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByText(/"name": "x"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw response' }));
    expect(screen.getByText(/"Items"/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('CSV'));
    fireEvent.click(screen.getByText('JSON', { selector: 'button.btn' }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByDisplayValue('Generate code…'), { target: { value: 'python' } });
    expect(screen.getByText(/client.execute_statement/)).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Generate code…'), { target: { value: '' } });
    fireEvent.click(screen.getAllByText('×')[0]);
    expect(screen.queryByText(/client.execute_statement/)).toBeNull();
  });

  it('restores statements from history and clears it', async () => {
    localStorage.setItem('ddbs.partiql.history', JSON.stringify([{ text: 'SELECT * FROM "A"', mode: 'batch', at: 1 }, { text: 'x'.repeat(130), mode: 'single', at: 2 }]));
    setup();
    expect(screen.getByText(`${'x'.repeat(120)}…`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('SELECT * FROM "A"'));
    expect(editor()).toHaveValue('SELECT * FROM "A"');
    expect(screen.getByText('Batch')).toHaveClass('active');
    fireEvent.click(screen.getByText('Clear history'));
    expect(screen.getByText('Executed statements appear here.')).toBeInTheDocument();
  });

  it('dedupes history entries', async () => {
    setup({ ExecuteStatement: { Items: [] } });
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } });
    run();
    await screen.findByText(/0 items/);
    run();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('ddbs.partiql.history'))).toHaveLength(1));
  });
});
