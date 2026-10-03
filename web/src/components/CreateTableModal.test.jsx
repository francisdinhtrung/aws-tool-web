import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import CreateTableModal from './CreateTableModal.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

describe('<CreateTableModal>', () => {
  it('validates, shows generated code and creates the table', async () => {
    const backend = mockBackend({ CreateTable: {} });
    const onCreated = vi.fn();
    renderWithApp(<CreateTableModal onClose={() => {}} onCreated={onCreated} />);

    fireEvent.click(screen.getByText('Create table', { selector: 'button' }));
    expect(screen.getByText(/Table name must be/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('MyTable'), { target: { value: 'Orders' } });
    fireEvent.click(screen.getByText('Python (boto3)'));
    expect(screen.getByText(/client.create_table/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Definition'));

    fireEvent.click(screen.getByText('Create table', { selector: 'button' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('Orders'));
    expect(backend.calls('CreateTable')[0]).toMatchObject({ TableName: 'Orders', BillingMode: 'PAY_PER_REQUEST' });
    expect(await screen.findByText('Table Orders is being created')).toBeInTheDocument();
  });

  it('shows AWS errors', async () => {
    mockBackend({ CreateTable: () => { throw awsError('ResourceInUseException', 'Table already exists'); } });
    renderWithApp(<CreateTableModal onClose={() => {}} onCreated={() => {}} initial={{ TableName: 'Dup', KeyAttributes: { PartitionKey: { AttributeName: 'id', AttributeType: 'S' } }, GlobalSecondaryIndexes: [] }} />);
    fireEvent.click(screen.getByText('Create table', { selector: 'button' }));
    expect(await screen.findByText('ResourceInUseException: Table already exists')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('×').at(-1));
    expect(screen.queryByText(/ResourceInUseException/)).toBeNull();
  });

  it('reports an invalid definition in the code tabs', () => {
    renderWithApp(<CreateTableModal onClose={() => {}} onCreated={() => {}} initial={{ TableName: 'X', KeyAttributes: {} }} />);
    fireEvent.click(screen.getByText('AWS CLI'));
    expect(screen.getByText('Invalid definition')).toBeInTheDocument();
  });

  it('closes on cancel', () => {
    const onClose = vi.fn();
    renderWithApp(<CreateTableModal onClose={onClose} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
