import { describe, it, expect } from 'vitest';
import {
  parseDuration, durationLabel, resolveRange, fmtTime, toInputValue, fromInputValue, parseJsonMessage, detectLevel, enrichEvent, jsonSummary,
  patternTerms, splitHighlights, histogram, insightsTable, chartSpec, rangeFromParams, rangeToParams, logsGroupPath, eventsToCsv, retentionLabel, timeAgo,
} from './logs.js';

describe('time ranges', () => {
  it('parses and labels durations', () => {
    expect(parseDuration('15m')).toBe(900000);
    expect(parseDuration(' 2 H ')).toBe(7200000);
    expect(parseDuration('1w')).toBe(604800000);
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(durationLabel('1h')).toBe('Last hour');
    expect(durationLabel('15m')).toBe('Last 15 minutes');
  });

  it('resolves relative and absolute ranges', () => {
    expect(resolveRange({ rel: '1h' }, 10_000_000)).toEqual({ startTime: 10_000_000 - 3_600_000, endTime: 10_000_000 });
    expect(resolveRange({ start: 5, end: 9 })).toEqual({ startTime: 5, endTime: 9 });
  });

  it('formats UTC times and round-trips datetime-local values', () => {
    const t = Date.UTC(2024, 4, 1, 13, 4, 5, 123);
    expect(fmtTime(t, true)).toBe('2024-05-01 13:04:05.123');
    expect(fmtTime(t, true, true)).toBe('2024-05-01 13:04:05');
    expect(toInputValue(t, true)).toBe('2024-05-01T13:04:05');
    expect(fromInputValue('2024-05-01T13:04', true)).toBe(Date.UTC(2024, 4, 1, 13, 4));
    expect(fromInputValue('', true)).toBeNull();
    expect(fmtTime(undefined)).toBe('—');
  });

  it('reads and writes URL params', () => {
    expect(rangeFromParams(new URLSearchParams('range=3h'))).toEqual({ rel: '3h' });
    expect(rangeFromParams(new URLSearchParams('start=10&end=20'))).toEqual({ start: 10, end: 20 });
    expect(rangeFromParams(new URLSearchParams('start=20&end=10'))).toEqual({ rel: '15m' });
    expect(rangeToParams({ start: 1, end: 2 })).toEqual({ start: '1', end: '2' });
    expect(logsGroupPath('/aws/lambda/x', { range: '1h' })).toBe('/logs/group/%2Faws%2Flambda%2Fx?range=1h');
  });

  it('formats helpers', () => {
    expect(retentionLabel(undefined)).toBe('Never expire');
    expect(retentionLabel(365)).toBe('1y');
    expect(retentionLabel(14)).toBe('14d');
    expect(timeAgo(1000, 61000)).toBe('1m ago');
  });
});

describe('messages', () => {
  it('extracts JSON after a prefix', () => {
    expect(parseJsonMessage('2024-01-01T00:00:00Z\tabc\tINFO\t{"a":1}')).toEqual({ prefix: '2024-01-01T00:00:00Z\tabc\tINFO', json: { a: 1 } });
    expect(parseJsonMessage('{"a":[1]}')).toEqual({ prefix: '', json: { a: [1] } });
    expect(parseJsonMessage('no json {here')).toBeNull();
    expect(parseJsonMessage('plain')).toBeNull();
  });

  it('detects levels from JSON fields, words and Lambda lines', () => {
    expect(detectLevel('{"level":"warning"}')).toBe('warn');
    expect(detectLevel('{"level":50}')).toBe('error');
    expect(detectLevel('[ERROR] boom')).toBe('error');
    expect(detectLevel('2024 x DEBUG y')).toBe('debug');
    expect(detectLevel('REPORT RequestId: 1 Duration: 3 ms')).toBe('system');
    expect(detectLevel('Unhandled Exception in handler')).toBe('error');
    expect(detectLevel('hello')).toBe('');
  });

  it('summarises JSON and enriches events', () => {
    expect(jsonSummary({ level: 'info', msg: 'hi', n: 1, o: { a: 1 } })).toBe('hi  n=1  o={"a":1}');
    const e = enrichEvent({ eventId: 'e1', timestamp: 1, message: '{"level":"error","message":"bad"}\n' });
    expect(e).toMatchObject({ id: 'e1', level: 'error', summary: 'bad', message: '{"level":"error","message":"bad"}' });
    expect(enrichEvent({ timestamp: 1, message: 'x' }).id).toContain(':1:');
  });

  it('extracts highlight terms from simple patterns only', () => {
    expect(patternTerms('ERROR -Timeout "two words" ?WARN')).toEqual(['ERROR', 'two words', 'WARN']);
    expect(patternTerms('{ $.level = "error" }')).toEqual([]);
    expect(splitHighlights('An error and ERROR', ['error'])).toEqual([
      { text: 'An ', hit: false }, { text: 'error', hit: true }, { text: ' and ', hit: false }, { text: 'ERROR', hit: true },
    ]);
    expect(splitHighlights('x', [])).toEqual([{ text: 'x', hit: false }]);
  });

  it('builds a histogram and CSV', () => {
    const ev = [{ timestamp: 0, level: 'error' }, { timestamp: 5, level: 'warn' }, { timestamp: 9, level: '' }, { timestamp: 50 }];
    const h = histogram(ev, 0, 10, 2);
    expect(h.map((b) => [b.total, b.error, b.warn])).toEqual([[1, 1, 0], [2, 0, 1]]);
    expect(eventsToCsv([{ timestamp: 0, logStreamName: 's', message: 'a,"b"' }], true)).toBe('timestamp,logStreamName,message\n1970-01-01 00:00:00.000,s,"a,""b"""');
  });
});

describe('insights', () => {
  it('turns results into a table without @ptr', () => {
    const t = insightsTable([[{ field: '@timestamp', value: 't1' }, { field: '@ptr', value: 'p' }], [{ field: 'n', value: '2' }]]);
    expect(t.columns).toEqual(['@timestamp', 'n']);
    expect(t.rows[0]['@ptr']).toBe('p');
  });

  it('detects time-series results', () => {
    const rows = [{ 'bin(5m)': '2024-05-01 00:05:00.000', c: '3' }, { 'bin(5m)': '2024-05-01 00:00:00.000', c: '1' }];
    const spec = chartSpec(['bin(5m)', 'c'], rows);
    expect(spec.series).toEqual(['c']);
    expect(spec.points.map((p) => p.v[0])).toEqual([1, 3]);
    expect(chartSpec(['@message'], [{ '@message': 'x' }])).toBeNull();
    expect(chartSpec(['bin(1h)', 'label'], [{ 'bin(1h)': '2024-05-01 00:00:00.000', label: 'abc' }])).toBeNull();
  });
});
