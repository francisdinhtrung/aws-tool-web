import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import LogsInsights from './LogsInsights.jsx';
import { renderWithApp, mockBackend } from '../test/utils.jsx';

const OP = (op) => `POST /api/logs/op/${op}`;
const ctx = {
  logGroups: [{ logGroupName: '/aws/lambda/a' }, { logGroupName: '/aws/lambda/b' }, { logGroupName: '/ecs/web' }],
  logGroupsState: { loaded: true, loading: false, more: false },
  logFavorites: ['/ecs/web'],
  reloadLogGroups: vi.fn(),
};
const setup = (handlers = {}) => ({ api: mockBackend(handlers), ...renderWithApp(<LogsInsights />, ctx) });
const editor = () => screen.getByLabelText('Query');
const row = (o) => Object.entries(o).map(([field, value]) => ({ field, value }));

beforeEach(() => {
  window.location.hash = '#/logs/insights?groups=%2Faws%2Flambda%2Fa&range=3h';
  localStorage.clear();
});

describe('<LogsInsights>', () => {
  it('runs a query, polls until complete and shows rows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      const { api } = setup({
        [OP('GetLogGroupFields')]: { logGroupFields: [{ name: '@message', percent: 100 }] },
        [OP('StartQuery')]: { queryId: 'q1' },
        [OP('GetQueryResults')]: () =>
          ++polls < 2
            ? { status: 'Running', results: [] }
            : {
                status: 'Complete',
                results: [row({ '@timestamp': '2024-05-01 10:00:00.000', '@message': '{"level":"error","msg":"boom"}', '@logStream': 's1', '@ptr': 'p' })],
                statistics: { recordsMatched: 1, recordsScanned: 10, bytesScanned: 2048 },
              },
      });
      expect(screen.getByText('/aws/lambda/a')).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: '@message' }));
      fireEvent.change(editor(), { target: { value: 'fields @timestamp, @message' } });
      fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(await screen.findByText('Complete')).toBeInTheDocument();
      expect(screen.getByText(/1 matched of 10 scanned · 2.0 KB scanned/)).toBeInTheDocument();
      const start = api.calls(OP('StartQuery'))[0];
      expect(start).toMatchObject({ logGroupNames: ['/aws/lambda/a'], queryString: 'fields @timestamp, @message' });
      expect(start.endTime - start.startTime).toBeGreaterThanOrEqual(3 * 3600);
      expect(start.endTime - start.startTime).toBeLessThanOrEqual(3 * 3600 + 1);
      expect(screen.queryByText('@ptr')).toBeNull();
      // UTC timestamps are shown in local time by default; the raw value stays in the title.
      fireEvent.click(screen.getByText('{"level":"error","msg":"boom"}'));
      expect(await screen.findByText('Open stream around this time')).toHaveAttribute('href', expect.stringContaining('/logs/group/%2Faws%2Flambda%2Fa?'));
      expect(screen.getByText('"boom"')).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem('ddbs.logs.insights.history'))[0].q).toBe('fields @timestamp, @message');
      expect(window.location.hash).toContain('q=fields');
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates groups and query, and cancels a running query', async () => {
    window.location.hash = '#/logs/insights';
    const { api } = setup({ [OP('StartQuery')]: { queryId: 'q2' }, [OP('GetQueryResults')]: { status: 'Running', results: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }));
    expect(await screen.findByText('Select at least one log group.')).toBeInTheDocument();

    const picker = screen.getByLabelText('Log groups');
    fireEvent.focus(picker);
    expect(screen.getAllByRole('button', { name: /\/ecs\/web/ })[0].textContent).toContain('★'); // favorites first
    fireEvent.change(picker, { target: { value: 'lambda/b' } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(screen.getByText('/aws/lambda/b')).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }));
    expect(await screen.findByText('Enter a query.')).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: 'stats count(*)' } });
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(api.calls(OP('StopQuery'))).toEqual([{ queryId: 'q2' }]));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('charts time-series results and loads templates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({
        [OP('StartQuery')]: { queryId: 'q3' },
        [OP('GetQueryResults')]: {
          status: 'Complete',
          results: [row({ 'bin(5m)': '2024-05-01 10:00:00.000', errors: '2' }), row({ 'bin(5m)': '2024-05-01 10:05:00.000', errors: '5' })],
        },
      });
      fireEvent.click(screen.getByRole('button', { name: /Templates/ }));
      fireEvent.click(screen.getByText('Error count over time'));
      expect(editor().value).toContain('bin(5m)');
      fireEvent.click(screen.getByRole('button', { name: /Run query/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(await screen.findByRole('img', { name: 'Query results chart' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
      expect(screen.getByRole('columnheader', { name: 'errors' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves and deletes named queries', async () => {
    setup();
    vi.spyOn(window, 'prompt').mockReturnValue('My query');
    fireEvent.change(editor(), { target: { value: 'fields @message | limit 5' } });
    fireEvent.click(screen.getByRole('button', { name: '☆ Save' }));
    fireEvent.click(screen.getByRole('button', { name: /Saved \(1\)/ }));
    fireEvent.change(editor(), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('My query'));
    expect(editor().value).toBe('fields @message | limit 5');
    fireEvent.click(screen.getByRole('button', { name: /Saved \(1\)/ }));
    fireEvent.click(screen.getByTitle('Delete'));
    expect(screen.getByRole('button', { name: /Saved \(0\)/ })).toBeInTheDocument();
  });
});
