import { describe, it, expect } from 'vitest';
import { parseIni, readEntries, writeEntries, serializeIni } from '../src/ini.js';

const SAMPLE = `# top comment
[default]
region = us-west-2
; inline comment line
output=json

[profile dev.team]   # trailing comment
region = eu-west-1
s3 =
  max_concurrent_requests = 10
role_arn = arn:aws:iam::1:role/x
`;

describe('parseIni', () => {
  it('splits sections and keeps the head section for leading lines', () => {
    const s = parseIni(SAMPLE);
    expect(s.map((x) => x.name)).toEqual([null, 'default', 'profile dev.team']);
    expect(s[0].lines).toEqual(['# top comment']);
  });

  it('keeps dots in section names', () => {
    expect(parseIni('[profile a.b.c]\nx=1').map((s) => s.name)).toEqual([null, 'profile a.b.c']);
  });

  it('handles empty / undefined input and CRLF', () => {
    expect(parseIni('')).toEqual([{ name: null, lines: [''] }]);
    expect(parseIni(undefined)).toEqual([{ name: null, lines: [''] }]);
    expect(readEntries(parseIni('[a]\r\nk = v\r\n')[1])).toEqual({ k: 'v' });
  });
});

describe('readEntries', () => {
  it('reads top-level keys, skipping comments, blanks, nested lines and junk', () => {
    const [, def, dev] = parseIni(SAMPLE + '\n[x]\nnot a pair\n');
    expect(readEntries(def)).toEqual({ region: 'us-west-2', output: 'json' });
    expect(readEntries(dev)).toEqual({ region: 'eu-west-1', s3: '', role_arn: 'arn:aws:iam::1:role/x' });
  });

  it('keeps "=" inside values', () => {
    expect(readEntries(parseIni('[a]\ncredential_process = cmd --x=1')[1])).toEqual({ credential_process: 'cmd --x=1' });
  });
});

describe('writeEntries', () => {
  it('keeps unchanged lines verbatim, updates changed values and appends new keys', () => {
    const [, def] = parseIni(SAMPLE);
    writeEntries(def, { region: 'us-west-2', output: 'yaml', cli_pager: '' });
    expect(def.lines).toEqual(['region = us-west-2', '; inline comment line', 'output = yaml', 'cli_pager = ', '']);
  });

  it('drops removed keys together with their nested block', () => {
    const [, , dev] = parseIni(SAMPLE);
    writeEntries(dev, { region: 'eu-west-1', role_arn: 'arn:aws:iam::1:role/x' });
    expect(dev.lines).toEqual(['region = eu-west-1', 'role_arn = arn:aws:iam::1:role/x', '']);
  });

  it('keeps nested block when its parent key is kept', () => {
    const [, , dev] = parseIni(SAMPLE);
    writeEntries(dev, { s3: '', region: 'x' });
    expect(dev.lines).toEqual(['region = x', 's3 =', '  max_concurrent_requests = 10', '']);
  });
});

describe('serializeIni', () => {
  it('round-trips the sample without changes', () => {
    expect(serializeIni(parseIni(SAMPLE))).toBe(SAMPLE.replace('[profile dev.team]   # trailing comment', '[profile dev.team]'));
  });

  it('inserts a blank line between sections and collapses extra blank lines', () => {
    const text = serializeIni([
      { name: null, lines: [] },
      { name: 'a', lines: ['x = 1'] },
      { name: 'b', lines: ['', '', '', 'y = 2'] },
    ]);
    expect(text).toBe('[a]\nx = 1\n\n[b]\n\ny = 2\n');
  });

  it('returns an empty string for nothing', () => {
    expect(serializeIni([{ name: null, lines: [''] }])).toBe('');
  });
});
