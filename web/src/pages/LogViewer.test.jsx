import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import LogViewer from './LogViewer.jsx';
import { renderWithApp, mockBackend } from '../test/utils.jsx';

const G = '/aws/lambda/orders';
const FILTER = 'POST /api/logs/op/FilterLogEvents';
const ev = (id, timestamp, message, stream = 's1') => ({ eventId: id, timestamp, ingestionTime: timestamp + 5, logStreamName: stream, message });
const ctx = { logGroups: [{ logGroupName: G, retentionInDays: 14, storedBytes: 2048 }], logFavorites: [], toggleLogFavorite: vi.fn(), reloadLogGroups: vi.fn() };
const setup = (handlers = {}, extra = {}) => ({ api: mockBackend(handlers), ...renderWithApp(<LogViewer group={G} />, { ...ctx, ...extra }) });

beforeEach(() => {
  window.location.hash = '#/logs/group/x';
});

describe('<LogViewer>', () => {
  it('searches on load, follows nextToken and shows levels, JSON summary and details', async () => {
    const { api } = setup({
      [FILTER]: (b) =>
        b.nextToken
          ? { events: [ev('2', 2000, '[ERROR] db down')] }
          : { events: [ev('1', 1000, '2024\trid\tINFO\t{"level":"info","msg":"order created","orderId":7}')], nextToken: 'n1' },
    });
    expect(await screen.findByText('[ERROR] db down')).toBeInTheDocument();
    expect(screen.getByText(/^order created\s+orderId=7$/)).toBeInTheDocument();
    const calls = api.calls(FILTER);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ logGroupName: G, limit: 1000 });
    expect(calls[0].endTime - calls[0].startTime).toBe(15 * 60000);
    expect(calls[1].nextToken).toBe('n1');
    expect(screen.getByRole('button', { name: /error 1/i })).toBeInTheDocument();
    expect(document.querySelector('.lv-toolbar').textContent).toMatch(/^2 events/);
    expect(screen.getByText('⏳ 14d')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/^order created\s+orderId=7$/));
    expect(await screen.findByText('Copy JSON')).toBeInTheDocument();
    expect(screen.getByText('"order created"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(/"msg":"order created"/)).toBeInTheDocument();
  });

  it('applies a filter pattern, highlights matches and syncs the URL', async () => {
    const { api } = setup({ [FILTER]: (b) => ({ events: b.filterPattern ? [ev('3', 3, 'Connection refused')] : [] }) });
    expect(await screen.findByText(/No events found/)).toBeInTheDocument();
    const box = screen.getByLabelText('Filter pattern');
    fireEvent.change(box, { target: { value: 'refused' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('refused', { selector: 'mark' })).toBeInTheDocument();
    expect(api.calls(FILTER).at(-1).filterPattern).toBe('refused');
    expect(window.location.hash).toContain('q=refused');
    expect(window.location.hash).toContain('range=15m');
  });

  it('filters loaded events by level and local text', async () => {
    setup({ [FILTER]: { events: [ev('1', 1, '[ERROR] a'), ev('2', 2, '[INFO] b'), ev('3', 3, '[INFO] needle')] } });
    await screen.findByText('[ERROR] a');
    fireEvent.click(screen.getByRole('button', { name: /info 2/i }));
    expect(screen.queryByText('[ERROR] a')).toBeNull();
    fireEvent.change(screen.getByLabelText('Find in results'), { target: { value: 'NEEDLE' } });
    expect(screen.queryByText('[INFO] b')).toBeNull();
    expect(screen.getByText('needle', { selector: 'mark' })).toBeInTheDocument();
  });

  it('loads more pages on demand', async () => {
    const page = (n) => Array.from({ length: 1000 }, (_, i) => ev(`${n}-${i}`, n * 10000 + i, `m${n}-${i}`));
    const { api } = setup({ [FILTER]: (b) => (b.nextToken ? { events: page(2) } : { events: page(1), nextToken: 'more' }) });
    expect(await screen.findByText(/More events match/)).toBeInTheDocument();
    expect(api.calls(FILTER)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/2000/)).toBeInTheDocument();
    expect(screen.queryByText(/More events match/)).toBeNull();
    expect(screen.getByText(/Show 500 more rows/)).toBeInTheDocument();
  });

  it('shows the surrounding lines of an event', async () => {
    const { api } = setup({
      [FILTER]: { events: [ev('t', 5000, 'target line')] },
      'POST /api/logs/op/GetLogEvents': (b) => ({ events: b.startFromHead ? [{ timestamp: 5000, message: 'target line' }, { timestamp: 6000, message: 'after' }] : [{ timestamp: 4000, message: 'before' }] }),
    });
    fireEvent.click(await screen.findByText('target line'));
    fireEvent.click(screen.getByText('Show context'));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('before')).toBeInTheDocument();
    expect(within(dlg).getByText('after')).toBeInTheDocument();
    expect(dlg.querySelectorAll('.ev-target')).toHaveLength(1);
    expect(api.calls('POST /api/logs/op/GetLogEvents')[0]).toMatchObject({ logGroupName: G, logStreamName: 's1', endTime: 5000, limit: 25, startFromHead: false });
  });

  it('filters by selected log streams', async () => {
    const { api } = setup({
      [FILTER]: { events: [] },
      'POST /api/logs/op/DescribeLogStreams': { logStreams: [{ logStreamName: 'a', lastEventTimestamp: Date.now() }, { logStreamName: 'b' }] },
    });
    fireEvent.click(await screen.findByText(/Streams: all/));
    await screen.findByTitle('a');
    fireEvent.click(within(screen.getByTitle('a')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Apply \(1\)/ }));
    await waitFor(() => expect(api.calls(FILTER).at(-1).logStreamNames).toEqual(['a']));
    expect(api.calls('POST /api/logs/op/DescribeLogStreams')[0]).toMatchObject({ orderBy: 'LastEventTime', descending: true });
    expect(screen.getByText(/Streams: 1 selected/)).toBeInTheDocument();
  });

  it('live tail polls for new events', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      const { api } = setup({ [FILTER]: (b) => (b.limit && !b.startTime ? { events: [] } : { events: [ev(`l${++n}`, Date.now(), `tail ${n}`)] }) });
      await screen.findByText(/No events found|tail/);
      fireEvent.click(screen.getByRole('button', { name: /Live tail/ }));
      expect(await screen.findByText(/Live ·/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await waitFor(() => expect(screen.getAllByText(/^tail \d$/).length).toBeGreaterThanOrEqual(2));
      const before = api.calls(FILTER).length;
      fireEvent.click(screen.getByRole('button', { name: /Stop tail/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      // Stopping runs a normal search once, then no more polling.
      expect(api.calls(FILTER).length).toBeLessThanOrEqual(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
