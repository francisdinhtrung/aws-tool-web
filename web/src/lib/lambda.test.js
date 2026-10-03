import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fnNameFromArn, sourceService, sourceLabel, logGroupOf, fmtBytes, fmtMemory, fmtTimeout, fmtMs, parseLastModified, stateOf,
  parseReport, prettyJson, starterCode, runtimeFamily, configErrors, envFromRows, envToRows, parseDotEnv, tagDiff, policyStatements, policyTriggers,
  buildMappingInput, metricPeriod, metricQueries, metricSeries, sortFiles, handlerFile, codeDownloadUrl, lambdaPath, listAllFunctions, EVENT_TEMPLATES, TEMPLATE_LABELS,
} from './lambda.js';
import { setConn } from '../api.js';
import { mockBackend } from '../test/utils.jsx';

afterEach(() => setConn(null));

describe('names and ARNs', () => {
  it('extracts function names and event sources', () => {
    expect(fnNameFromArn('arn:aws:lambda:us-east-1:1:function:orders:live')).toBe('orders');
    expect(fnNameFromArn('orders')).toBe('orders');
    expect(sourceService('arn:aws:sqs:us-east-1:1:q')).toBe('sqs');
    expect(sourceLabel('arn:aws:sqs:us-east-1:1:q')).toBe('q');
    expect(sourceLabel('arn:aws:dynamodb:us-east-1:1:table/Users/stream/2026-01-01T00:00:00.000')).toBe('Users');
    expect(sourceLabel('arn:aws:kinesis:us-east-1:1:stream/clicks')).toBe('clicks');
    expect(logGroupOf({ FunctionName: 'f' })).toBe('/aws/lambda/f');
    expect(logGroupOf({ FunctionName: 'f', LoggingConfig: { LogGroup: '/shared' } })).toBe('/shared');
    expect(lambdaPath('a b')).toBe('/lambda/function/a%20b');
  });

  it('builds the code download URL with the connection', () => {
    setConn({ kind: 'profile', profile: 'dev' });
    const u = new URL(codeDownloadUrl('fn', '3'), 'http://x');
    expect(u.pathname).toBe('/api/lambda/code/download');
    expect(u.searchParams.get('qualifier')).toBe('3');
    expect(JSON.parse(decodeURIComponent(u.searchParams.get('conn')))).toEqual({ kind: 'profile', profile: 'dev' });
  });
});

describe('formatting', () => {
  it('formats sizes and durations', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(fmtMemory(2048)).toBe('2 GB');
    expect(fmtMemory(1536)).toBe('1536 MB');
    expect(fmtTimeout(90)).toBe('1 min 30 s');
    expect(fmtTimeout(3)).toBe('3 s');
    expect(fmtMs(3.456)).toBe('3.46 ms');
    expect(fmtMs(1500)).toBe('1.50 s');
    expect(parseLastModified('2026-01-01T00:00:00.000+0000').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('describes function state', () => {
    expect(stateOf({ State: 'Active', LastUpdateStatus: 'Successful' }).kind).toBe('ok');
    expect(stateOf({ State: 'Pending' })).toMatchObject({ label: 'Pending', kind: 'warn' });
    expect(stateOf({ State: 'Active', LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'bad zip' })).toMatchObject({ kind: 'bad', reason: 'bad zip' });
  });
});

describe('invocation output', () => {
  it('parses the REPORT line', () => {
    const log = 'START RequestId: abc Version: $LATEST\nhello\nEND RequestId: abc\nREPORT RequestId: abc\tDuration: 12.34 ms\tBilled Duration: 13 ms\tMemory Size: 128 MB\tMax Memory Used: 70 MB\tInit Duration: 150.5 ms\t\n';
    expect(parseReport(log)).toEqual({ requestId: 'abc', duration: 12.34, billed: 13, memorySize: 128, maxMemory: 70, initDuration: 150.5 });
    expect(parseReport('no report')).toBeNull();
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('plain')).toBe('plain');
  });

  it('ships a template for every label', () => {
    expect(Object.keys(TEMPLATE_LABELS).sort()).toEqual(Object.keys(EVENT_TEMPLATES).sort());
    expect(EVENT_TEMPLATES.sqs.Records[0].eventSource).toBe('aws:sqs');
  });
});

describe('runtimes and validation', () => {
  it('has starter code for interpreted runtimes only', () => {
    expect(starterCode('nodejs22.x')).toMatchObject({ handler: 'index.handler', files: { 'index.mjs': expect.stringContaining('handler') } });
    expect(starterCode('python3.13').handler).toBe('lambda_function.lambda_handler');
    expect(Object.keys(starterCode('provided.al2023').files)).toEqual(['bootstrap']);
    expect(starterCode('java21')).toBeNull();
    expect(runtimeFamily('dotnet8')).toBe('dotnet');
  });

  it('validates memory, timeout and storage', () => {
    expect(configErrors({ MemorySize: '128', Timeout: '900', EphemeralStorage: '512' })).toEqual({});
    expect(Object.keys(configErrors({ MemorySize: '64', Timeout: '901', EphemeralStorage: '20000' }))).toEqual(['MemorySize', 'Timeout', 'EphemeralStorage']);
  });

  it('converts environment rows and rejects invalid ones', () => {
    expect(envFromRows([{ key: 'AB', value: '1' }, { key: '', value: '' }])).toEqual({ AB: '1' });
    expect(() => envFromRows([{ key: 'A', value: '1' }])).toThrow(/Invalid/); // AWS needs 2+ characters
    expect(() => envFromRows([{ key: '1A', value: 'x' }])).toThrow(/Invalid/);
    expect(() => envFromRows([{ key: 'AWS_REGION', value: 'x' }])).toThrow(/reserved/);
    expect(() => envFromRows([{ key: 'AB', value: '1' }, { key: 'AB', value: '2' }])).toThrow(/Duplicate/);
    expect(() => envFromRows([{ key: 'BIG', value: 'x'.repeat(5000) }])).toThrow(/4 KB/);
    expect(envToRows({ A: '1' })).toEqual([{ key: 'A', value: '1' }]);
  });

  it('parses .env files', () => {
    expect(parseDotEnv('# c\nA=1\nexport B="two words"\nbad\nC=\'x=y\'')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: 'x=y' },
    ]);
  });

  it('diffs tags', () => {
    expect(tagDiff({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual({ set: { b: '3', c: '4' }, remove: [] });
    expect(tagDiff({ a: '1' }, {})).toEqual({ set: {}, remove: ['a'] });
  });
});

describe('policies and triggers', () => {
  const policy = JSON.stringify({
    Statement: [
      { Sid: 'apigw', Effect: 'Allow', Principal: { Service: 'apigateway.amazonaws.com' }, Action: 'lambda:InvokeFunction', Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:x' } } },
      { Sid: 'acct', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::222:root' }, Action: ['lambda:InvokeFunction', 'lambda:GetFunction'] },
      { Sid: 'url', Effect: 'Allow', Principal: '*', Action: 'lambda:InvokeFunctionUrl', Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'NONE' } } },
    ],
  });

  it('flattens statements', () => {
    const s = policyStatements(policy);
    expect(s.map((x) => x.principal)).toEqual(['apigateway.amazonaws.com', 'arn:aws:iam::222:root', '*']);
    expect(s[0].sourceArn).toBe('arn:aws:execute-api:x');
    expect(s[1].action).toBe('lambda:InvokeFunction, lambda:GetFunction');
    expect(s[2].urlAuth).toBe('NONE');
    expect(policyStatements('not json')).toEqual([]);
  });

  it('lists push triggers from service principals', () => {
    expect(policyTriggers(policy)).toEqual([{ service: 'apigateway', source: 'arn:aws:execute-api:x', sid: 'apigw' }]);
  });

  it('builds event source mapping input', () => {
    expect(buildMappingInput('f', { EventSourceArn: 'arn:aws:sqs:r:1:q', BatchSize: '10', ReportBatchItemFailures: true, MaximumConcurrency: '5', Enabled: true })).toEqual({
      FunctionName: 'f', EventSourceArn: 'arn:aws:sqs:r:1:q', Enabled: true, BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 5 },
    });
    expect(buildMappingInput('f', { EventSourceArn: 'arn:aws:kinesis:r:1:stream/s', StartingPosition: 'TRIM_HORIZON' }).StartingPosition).toBe('TRIM_HORIZON');
    expect(buildMappingInput('f', { EventSourceArn: 'arn:aws:sqs:r:1:q', FilterPattern: '{"body":{"a":[1]}}\n' }).FilterCriteria).toEqual({ Filters: [{ Pattern: '{"body":{"a":[1]}}' }] });
    expect(() => buildMappingInput('f', { EventSourceArn: '' })).toThrow(/required/);
    expect(() => buildMappingInput('f', { EventSourceArn: 'arn:aws:sqs:r:1:q', FilterPattern: '{bad' })).toThrow(/not valid JSON/);
  });
});

describe('metrics', () => {
  it('picks a period and builds queries', () => {
    expect(metricPeriod(3600e3)).toBe(60);
    expect(metricPeriod(86400e3)).toBe(900);
    expect(metricPeriod(2 * 86400e3)).toBe(3600);
    expect(metricPeriod(7 * 86400e3)).toBe(21600);
    const q = metricQueries('f', 'live', 300);
    expect(q).toHaveLength(6);
    expect(q[0].MetricStat.Metric.Dimensions).toEqual([{ Name: 'FunctionName', Value: 'f' }, { Name: 'Resource', Value: 'f:live' }]);
    expect(q.every((x) => /^[a-z][a-z0-9]*$/.test(x.Id))).toBe(true);
  });

  it('turns results into sorted series', () => {
    expect(metricSeries([{ Id: 'a', Timestamps: ['2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z'], Values: [2, 1] }]).a.map((p) => p.v)).toEqual([1, 2]);
  });
});

describe('code helpers', () => {
  it('sorts folders first and finds the handler file', () => {
    const files = [{ path: 'z.js' }, { path: 'lib/b.js' }, { path: 'a.js' }, { path: 'lib/a/x.js' }];
    expect(sortFiles(files).map((f) => f.path)).toEqual(['lib/a/x.js', 'lib/b.js', 'a.js', 'z.js']);
    expect(handlerFile('src/index.handler', [{ path: 'src/index.mjs' }, { path: 'a.py' }])).toBe('src/index.mjs');
    expect(handlerFile('app.main', [{ path: 'bin', binary: true }, { path: 'README.md' }])).toBe('README.md');
  });

  it('pages through ListFunctions', async () => {
    const api = mockBackend({ 'POST /api/lambda/op/ListFunctions': (b) => (b.Marker ? { Functions: [{ FunctionName: 'a' }] } : { Functions: [{ FunctionName: 'b' }], NextMarker: 'm' }) });
    const out = await listAllFunctions();
    expect(out.functions.map((f) => f.FunctionName)).toEqual(['a', 'b']);
    expect(api.calls('POST /api/lambda/op/ListFunctions')[1]).toEqual({ MaxItems: 50, Marker: 'm' });
    vi.restoreAllMocks();
  });
});
