import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import SqsHome from './SqsQueues.jsx';
import SqsQueue from './SqsQueue.jsx';
import { CreateQueueModal } from '../components/SqsModals.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

const BASE = 'http://localhost:4566/000000000000';
const URL = `${BASE}/orders`;
const DLQ = `${BASE}/orders-dlq`;
const op = (name) => `POST /api/sqs/op/${name}`;
const ATTRS = {
  QueueArn: 'arn:aws:sqs:us-east-1:000000000000:orders',
  ApproximateNumberOfMessages: '7',
  ApproximateNumberOfMessagesNotVisible: '1',
  ApproximateNumberOfMessagesDelayed: '0',
  VisibilityTimeout: '30',
  MessageRetentionPeriod: '345600',
  DelaySeconds: '0',
  MaximumMessageSize: '262144',
  ReceiveMessageWaitTimeSeconds: '0',
  SqsManagedSseEnabled: 'true',
  CreatedTimestamp: '1700000000',
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq', maxReceiveCount: 3 }),
};
const ctx = { queues: [DLQ, URL], queuesState: { loaded: true }, reloadQueues: vi.fn() };
const msg = (id, Body, extra = {}) => ({ MessageId: id, ReceiptHandle: `rh-${id}`, Body, Attributes: { SentTimestamp: '1700000000000', ApproximateReceiveCount: '1' }, ...extra });

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('<SqsHome>', () => {
  it('lists queues with counts, DLQ and type', async () => {
    mockBackend({ [op('GetQueueAttributes')]: (b) => ({ Attributes: b.QueueUrl === URL ? ATTRS : { ApproximateNumberOfMessages: '0', QueueArn: 'arn:dlq' } }) });
    renderWithApp(<SqsHome onCreate={vi.fn()} />, ctx);
    const row = (await screen.findByRole('link', { name: 'orders' })).closest('tr');
    await waitFor(() => expect(within(row).getByText('7')).toBeInTheDocument());
    expect(within(row).getByText('DLQ → orders-dlq')).toBeInTheDocument();
    expect(within(row).getByText(/30 seconds/)).toBeInTheDocument();
  });

  it('purges after confirmation', async () => {
    const api = mockBackend({ [op('GetQueueAttributes')]: { Attributes: ATTRS } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApp(<SqsHome onCreate={vi.fn()} />, { ...ctx, queues: [URL] });
    const row = (await screen.findByRole('link', { name: 'orders' })).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Purge' }));
    await waitFor(() => expect(api.calls(op('PurgeQueue'))).toEqual([{ QueueUrl: URL }]));
  });

  it('shows the welcome page without a connection', () => {
    renderWithApp(<SqsHome onCreate={vi.fn()} />, { ...ctx, conn: null });
    expect(screen.getByText('📨 Amazon SQS')).toBeInTheDocument();
  });
});

describe('<SqsQueue>', () => {
  const setup = (handlers = {}) => {
    const api = mockBackend({ [op('GetQueueUrl')]: { QueueUrl: URL }, [op('GetQueueAttributes')]: { Attributes: ATTRS }, ...handlers });
    return { api, ...renderWithApp(<SqsQueue name="orders" />, ctx) };
  };

  it('shows stats and polls, opens, returns and deletes messages', async () => {
    const { api } = setup({
      [op('ReceiveMessage')]: { Messages: [msg('m1', '{"orderId":1}', { MessageAttributes: { tenant: { DataType: 'String', StringValue: 'acme' } } }), msg('m2', 'plain')] },
      [op('DeleteMessageBatch')]: { Successful: [{ Id: '0' }] },
      [op('ChangeMessageVisibilityBatch')]: { Successful: [{ Id: '0' }] },
    });
    expect(await screen.findByText('📨 orders')).toBeInTheDocument();
    expect(screen.getByText('DLQ → orders-dlq')).toBeInTheDocument();
    expect(screen.getByText('SSE-SQS')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Max messages'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Poll for messages' }));
    expect(await screen.findByText('{"orderId":1}')).toBeInTheDocument();
    expect(api.calls(op('ReceiveMessage'))[0]).toMatchObject({ QueueUrl: URL, MaxNumberOfMessages: 2, VisibilityTimeout: 30 });
    expect(screen.getByText(/after 3 receives they move to the DLQ/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('{"orderId":1}'));
    const detail = await screen.findByLabelText('Message details');
    expect(within(detail).getByText(/"orderId": 1/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('tab', { name: 'Attributes (1)' }));
    expect(within(detail).getByText('acme')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select m2'));
    fireEvent.click(screen.getAllByRole('button', { name: '↩ Return to queue' })[0]);
    await waitFor(() => expect(screen.queryByText('plain')).toBeNull());
    expect(api.calls(op('ChangeMessageVisibilityBatch'))[0].Entries).toEqual([{ Id: '0', ReceiptHandle: 'rh-m2', VisibilityTimeout: 0 }]);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('{"orderId":1}')).toBeNull());
    expect(api.calls(op('DeleteMessageBatch'))[0].Entries).toEqual([{ Id: '0', ReceiptHandle: 'rh-m1' }]);
  });

  it('sends a message with attributes and validates the body', async () => {
    const { api } = setup({ [op('SendMessage')]: { MessageId: 'new-1' } });
    await screen.findByText('📨 orders');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Message body is required')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('{"orderId": 42}'), { target: { value: '{"a":1}' } });
    fireEvent.change(screen.getByLabelText('Delivery delay'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add attribute' }));
    fireEvent.change(screen.getByLabelText('Attribute name 1'), { target: { value: 'tenant' } });
    fireEvent.change(screen.getByLabelText('Attribute value 1'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('new-1')).toBeInTheDocument();
    expect(api.calls(op('SendMessage'))[0]).toEqual({
      QueueUrl: URL,
      MessageBody: '{"a":1}',
      DelaySeconds: 10,
      MessageAttributes: { tenant: { DataType: 'String', StringValue: 'acme' } },
    });
  });

  it('saves only changed settings', async () => {
    const { api } = setup();
    await screen.findByText('📨 orders');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Visibility timeout'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls(op('SetQueueAttributes'))).toEqual([{ QueueUrl: URL, Attributes: { VisibilityTimeout: '120' } }]));
  });

  it('shows an error when the queue does not exist', async () => {
    mockBackend({ [op('GetQueueUrl')]: () => { throw awsError('QueueDoesNotExist', 'The specified queue does not exist.'); } });
    renderWithApp(<SqsQueue name="gone" />, ctx);
    expect(await screen.findByText(/QueueDoesNotExist/)).toBeInTheDocument();
  });
});

describe('<CreateQueueModal>', () => {
  it('creates a FIFO queue with a dead-letter queue and tags', async () => {
    const FDLQ = `${BASE}/dlq.fifo`;
    const api = mockBackend({
      [op('GetQueueUrl')]: { QueueUrl: FDLQ },
      [op('GetQueueAttributes')]: { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:dlq.fifo' } },
      [op('CreateQueue')]: { QueueUrl: `${BASE}/events.fifo` },
    });
    const onCreated = vi.fn();
    renderWithApp(<CreateQueueModal onClose={vi.fn()} onCreated={onCreated} />, { ...ctx, queues: [URL, FDLQ] });
    fireEvent.click(screen.getByRole('button', { name: 'FIFO' }));
    fireEvent.change(screen.getByLabelText('Queue name'), { target: { value: 'events' } });
    fireEvent.change(screen.getByLabelText('Dead-letter queue'), { target: { value: 'dlq.fifo' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Key 1'), { target: { value: 'team' } });
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'core' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('events.fifo'));
    const input = api.calls(op('CreateQueue'))[0];
    expect(input).toMatchObject({ QueueName: 'events.fifo', tags: { team: 'core' } });
    expect(input.Attributes).toMatchObject({ FifoQueue: 'true', SqsManagedSseEnabled: 'true', VisibilityTimeout: '30' });
    expect(JSON.parse(input.Attributes.RedrivePolicy)).toEqual({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq.fifo', maxReceiveCount: 5 });
  });

  it('rejects invalid names', () => {
    renderWithApp(<CreateQueueModal onClose={vi.fn()} onCreated={vi.fn()} />, ctx);
    fireEvent.change(screen.getByLabelText('Queue name'), { target: { value: 'bad name' } });
    expect(screen.getByText(/letters, digits/)).toBeInTheDocument();
  });
});
