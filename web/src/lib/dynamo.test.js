import { describe, it, expect } from 'vitest';
import {
  avType, isAttributeValue, isDdbJsonItem, toPlain, fromPlain, itemToPlain, itemFromPlain, normalizeItem, displayValue,
  stableKey, pickKey, columnsOf, toAV, ExprCtx, condExpr, buildCondition, buildUpdate, buildProjection, keysOf, tableKeyNames,
  indexesOf, createTableInput, descToDef, inferNonKeyAttributes, cloudFormation, genCode, itemsToCsv, parseCsv, csvToItems,
  parseJsonItems, chunk, REGIONS, COND_OPS, UPDATE_ACTIONS,
} from './dynamo.js';
import { SHOP_DESC } from '../test/utils.jsx';

const ALL_TYPES = {
  s: { S: 'x' }, n: { N: '1.5' }, b: { B: 'aGk=' }, t: { BOOL: true }, z: { NULL: true },
  m: { M: { a: { S: 'b' } } }, l: { L: [{ N: '1' }, { S: 'two' }] }, ss: { SS: ['a', 'b'] }, ns: { NS: ['1', '2'] }, bs: { BS: ['YQ=='] },
};

describe('attribute value basics', () => {
  it('avType / isAttributeValue / isDdbJsonItem', () => {
    expect(avType({ S: 'x' })).toBe('S');
    expect(avType(null)).toBeUndefined();
    expect(avType('x')).toBeUndefined();
    expect(isAttributeValue({ N: '1' })).toBe(true);
    expect(isAttributeValue({ N: '1', S: 'x' })).toBe(false);
    expect(isAttributeValue({ X: 1 })).toBe(false);
    expect(isAttributeValue([])).toBe(false);
    expect(isAttributeValue(null)).toBe(false);
    expect(isDdbJsonItem(ALL_TYPES)).toBe(true);
    expect(isDdbJsonItem({ a: 1 })).toBe(false);
    expect(isDdbJsonItem({})).toBe(false);
    expect(isDdbJsonItem(undefined)).toBe(false);
  });

  it('toPlain converts every type', () => {
    expect(itemToPlain(ALL_TYPES)).toEqual({
      s: 'x', n: 1.5, b: 'aGk=', t: true, z: null, m: { a: 'b' }, l: [1, 'two'], ss: ['a', 'b'], ns: [1, 2], bs: ['YQ=='],
    });
    expect(toPlain({ X: 1 })).toBeUndefined();
    expect(itemToPlain(undefined)).toEqual({});
  });

  it('keeps numbers that would lose precision as strings', () => {
    expect(toPlain({ N: '12345678901234567890' })).toBe('12345678901234567890');
    expect(toPlain({ N: '0.1234567890123456789' })).toBe('0.1234567890123456789');
    expect(toPlain({ N: '-42' })).toBe(-42);
    expect(toPlain({ N: '1E+5' })).toBe(100000);
  });

  it('fromPlain infers types', () => {
    expect(itemFromPlain({ a: 'x', b: 2, c: false, d: null, e: undefined, f: [1], g: { h: 'i' }, j: 10n })).toEqual({
      a: { S: 'x' }, b: { N: '2' }, c: { BOOL: false }, d: { NULL: true }, e: { NULL: true }, f: { L: [{ N: '1' }] }, g: { M: { h: { S: 'i' } } }, j: { S: '10' },
    });
    expect(itemFromPlain(undefined)).toEqual({});
  });

  it('normalizeItem accepts both formats', () => {
    expect(normalizeItem({ a: { S: 'x' } })).toEqual({ a: { S: 'x' } });
    expect(normalizeItem({ a: 'x' })).toEqual({ a: { S: 'x' } });
  });

  it('displayValue renders and truncates', () => {
    expect(displayValue({ S: 'abc' })).toBe('abc');
    expect(displayValue({ N: '7' })).toBe('7');
    expect(displayValue({ BOOL: false })).toBe('false');
    expect(displayValue({ NULL: true })).toBe('null');
    expect(displayValue({ B: 'aGk=' })).toBe('<binary 2B>');
    expect(displayValue({ B: 'aGVsbG8=' })).toBe('<binary 5B>');
    expect(displayValue({ B: 'aGVs' })).toBe('<binary 3B>');
    expect(displayValue({ M: { a: { N: '1' } } })).toBe('{"a":1}');
    expect(displayValue({ S: 'abcdef' }, 3)).toBe('abc…');
  });

  it('stableKey / pickKey / columnsOf', () => {
    const it1 = { pk: { S: 'a' }, sk: { S: 'b' }, x: { N: '1' } };
    expect(stableKey(it1, ['pk', 'sk'])).toBe('[{"S":"a"},{"S":"b"}]');
    expect(stableKey(undefined, ['pk'])).toBe('[null]');
    expect(pickKey(it1, ['pk', 'sk', 'missing'])).toEqual({ pk: { S: 'a' }, sk: { S: 'b' } });
    expect(columnsOf([it1, { pk: { S: 'c' }, a: { S: '' } }], ['pk', 'sk'])).toEqual(['pk', 'sk', 'a', 'x']);
    expect(columnsOf([{ a: { S: '' } }], ['pk'])).toEqual(['a']);
    expect(columnsOf([], ['pk', 'sk'])).toEqual(['pk', 'sk']);
  });
});

describe('toAV', () => {
  it.each([
    ['S', 'x', { S: 'x' }],
    [undefined, 'x', { S: 'x' }],
    ['N', ' 12 ', { N: '12' }],
    ['BOOL', 'true', { BOOL: true }],
    ['BOOL', true, { BOOL: true }],
    ['BOOL', 'false', { BOOL: false }],
    ['NULL', '', { NULL: true }],
    ['B', ' aGk= ', { B: 'aGk=' }],
    ['SS', 'a, b ,,c', { SS: ['a', 'b', 'c'] }],
    ['SS', '["a", 1]', { SS: ['a', '1'] }],
    ['NS', '1,2', { NS: ['1', '2'] }],
    ['BS', '["YQ=="]', { BS: ['YQ=='] }],
    ['PLAIN', '{"a":[1,"x"]}', { M: { a: { L: [{ N: '1' }, { S: 'x' }] } } }],
    ['JSON', '{"SS":["a"]}', { SS: ['a'] }],
  ])('%s %j', (type, value, expected) => {
    expect(toAV(type, value)).toEqual(expected);
  });

  it('defaults value to empty string', () => {
    expect(toAV('S')).toEqual({ S: '' });
  });

  it('validates numbers and DynamoDB JSON', () => {
    expect(() => toAV('N', 'abc')).toThrow(/not a valid number/);
    expect(() => toAV('N', '')).toThrow();
    expect(() => toAV('NS', '1,x')).toThrow(/not a valid number/);
    expect(() => toAV('JSON', '{"a":1}')).toThrow(/DynamoDB JSON/);
    expect(() => toAV('PLAIN', '{bad')).toThrow();
  });
});

describe('expressions', () => {
  it('ExprCtx reuses placeholders and supports document paths', () => {
    const ctx = new ExprCtx();
    expect(ctx.name('a.b[0].c')).toBe('#n0.#n1[0].#n2');
    expect(ctx.name('a')).toBe('#n0');
    expect(ctx.name('list[2][3]')).toBe('#n3[2][3]');
    expect(ctx.value({ S: 'x' })).toBe(':v0');
    expect(ctx.apply({})).toEqual({
      ExpressionAttributeNames: { '#n0': 'a', '#n1': 'b', '#n2': 'c', '#n3': 'list' },
      ExpressionAttributeValues: { ':v0': { S: 'x' } },
    });
    expect(new ExprCtx('p_').name('x')).toBe('#p_n0');
    expect(new ExprCtx().apply({ a: 1 })).toEqual({ a: 1 });
  });

  const cond = (row) => {
    const ctx = new ExprCtx();
    return [condExpr({ attr: 'a', type: 'S', value: 'x', ...row }, ctx), ctx.values];
  };

  it.each([
    [{ op: '=' }, '#n0 = :v0'],
    [{ op: '<>' }, '#n0 <> :v0'],
    [{ op: undefined }, '#n0 = :v0'],
    [{ op: 'exists' }, 'attribute_exists(#n0)'],
    [{ op: 'not_exists' }, 'attribute_not_exists(#n0)'],
    [{ op: 'between', value2: 'y' }, '#n0 BETWEEN :v0 AND :v1'],
    [{ op: 'begins_with' }, 'begins_with(#n0, :v0)'],
    [{ op: 'contains' }, 'contains(#n0, :v0)'],
    [{ op: 'not_contains' }, 'NOT contains(#n0, :v0)'],
    [{ op: 'in', value: 'x, y' }, '#n0 IN (:v0, :v1)'],
    [{ op: 'attribute_type', value: ' SS ' }, 'attribute_type(#n0, :v0)'],
    [{ op: 'size_eq', value: '3' }, 'size(#n0) = :v0'],
    [{ op: 'size_gt', value: '3' }, 'size(#n0) > :v0'],
    [{ op: 'size_lt', value: '3' }, 'size(#n0) < :v0'],
  ])('condExpr %j', (row, expected) => {
    expect(cond(row)[0]).toBe(expected);
  });

  it('condExpr types values', () => {
    expect(cond({ op: 'in', value: 'x, y' })[1]).toEqual({ ':v0': { S: 'x' }, ':v1': { S: 'y' } });
    expect(cond({ op: 'attribute_type', value: ' SS ' })[1]).toEqual({ ':v0': { S: 'SS' } });
    expect(cond({ op: '>', type: 'N', value: '5' })[1]).toEqual({ ':v0': { N: '5' } });
    expect(cond({ op: '=', type: undefined, value: 'q' })[1]).toEqual({ ':v0': { S: 'q' } });
  });

  it('buildCondition joins rows with AND/OR and skips empty attributes', () => {
    const ctx = new ExprCtx();
    expect(buildCondition([{ attr: 'a', op: 'exists' }, { attr: '', op: '=' }, { attr: 'b', op: 'not_exists', join: 'OR' }, { attr: 'c', op: 'exists' }], ctx)).toBe(
      'attribute_exists(#n0) OR attribute_not_exists(#n1) AND attribute_exists(#n2)',
    );
    expect(buildCondition([], ctx)).toBeUndefined();
    expect(buildCondition(undefined, ctx)).toBeUndefined();
  });

  it('buildUpdate groups clauses', () => {
    const ctx = new ExprCtx();
    const expr = buildUpdate(
      [
        { action: 'set', attr: 'a', type: 'S', value: 'x' },
        { action: undefined, attr: 'a2', value: 'y' },
        { action: 'increment', attr: 'n', type: 'N', value: '1' },
        { action: 'decrement', attr: 'n', type: 'N', value: '2' },
        { action: 'append', attr: 'l', type: 'PLAIN', value: '[1]' },
        { action: 'if_not_exists', attr: 'c', type: 'N', value: '0' },
        { action: 'remove', attr: 'old' },
        { action: 'add', attr: 'tags', type: 'SS', value: 'x' },
        { action: 'delete', attr: 'tags', type: 'SS', value: 'y' },
        { action: 'set', attr: '' },
      ],
      ctx,
    );
    expect(expr).toBe(
      'SET #n0 = :v0, #n1 = :v1, #n2 = #n2 + :v2, #n2 = #n2 - :v3, #n3 = list_append(if_not_exists(#n3, :v4), :v5), #n4 = if_not_exists(#n4, :v6) REMOVE #n5 ADD #n6 :v7 DELETE #n6 :v8',
    );
    expect(ctx.values[':v4']).toEqual({ L: [] });
    expect(buildUpdate([], new ExprCtx())).toBeUndefined();
    expect(buildUpdate(undefined, new ExprCtx())).toBeUndefined();
  });

  it('buildProjection', () => {
    const ctx = new ExprCtx();
    expect(buildProjection(' a, b.c ,, ', ctx)).toBe('#n0, #n1.#n2');
    expect(buildProjection('', ctx)).toBeUndefined();
    expect(buildProjection(undefined, ctx)).toBeUndefined();
  });

  it('exports operator lists', () => {
    expect(COND_OPS.length).toBeGreaterThan(10);
    expect(UPDATE_ACTIONS.map((a) => a[0])).toContain('remove');
  });
});

describe('table descriptions', () => {
  it('keysOf table and indexes', () => {
    expect(keysOf(SHOP_DESC)).toMatchObject({ pk: 'PK', sk: 'SK', pkType: 'S', skType: 'S' });
    expect(keysOf(SHOP_DESC, 'GSI1')).toMatchObject({ pk: 'GSI1PK', sk: null, pkType: 'S' });
    expect(keysOf(SHOP_DESC, 'LSI1')).toMatchObject({ pk: 'PK', sk: 'n', skType: 'N' });
    expect(keysOf(SHOP_DESC, 'missing')).toMatchObject({ pk: null, sk: null });
    expect(keysOf(null)).toEqual({ pk: null, sk: null });
    expect(keysOf({ KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] })).toMatchObject({ pk: 'id', pkType: 'S' });
    expect(tableKeyNames(SHOP_DESC)).toEqual(['PK', 'SK']);
    expect(indexesOf(SHOP_DESC).map((i) => `${i.kind}:${i.IndexName}`)).toEqual(['GSI:GSI1', 'LSI:LSI1']);
    expect(indexesOf(undefined)).toEqual([]);
  });

  it('createTableInput: on-demand with GSI + LSI and options', () => {
    const input = createTableInput({
      TableName: 'T',
      KeyAttributes: { PartitionKey: { AttributeName: 'pk', AttributeType: 'S' }, SortKey: { AttributeName: 'sk' } },
      GlobalSecondaryIndexes: [{ IndexName: 'G', KeyAttributes: { PartitionKey: { AttributeName: 'g', AttributeType: 'N' } }, Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['x'] } }],
      LocalSecondaryIndexes: [{ IndexName: 'L', KeyAttributes: { SortKey: { AttributeName: 'd', AttributeType: 'S' } } }],
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      DeletionProtectionEnabled: true,
      StreamViewType: 'NEW_IMAGE',
    });
    expect(input).toEqual({
      TableName: 'T',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [{ IndexName: 'G', KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }], Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['x'] } }],
      LocalSecondaryIndexes: [{ IndexName: 'L', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'd', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }],
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      DeletionProtectionEnabled: true,
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'g', AttributeType: 'N' },
        { AttributeName: 'd', AttributeType: 'S' },
      ],
    });
  });

  it('createTableInput: provisioned throughput applies to GSIs; INCLUDE without list; legacy LSI SortKey', () => {
    const input = createTableInput({
      TableName: 'T',
      KeyAttributes: { PartitionKey: { AttributeName: 'pk' } },
      BillingMode: 'PROVISIONED',
      ProvisionedCapacitySettings: { ProvisionedThroughput: { ReadCapacityUnits: '7' } },
      GlobalSecondaryIndexes: [{ IndexName: 'G', KeyAttributes: { PartitionKey: { AttributeName: 'g' } }, Projection: { ProjectionType: 'INCLUDE' } }],
      LocalSecondaryIndexes: [{ IndexName: 'L', SortKey: { AttributeName: 'x' } }],
      TableClass: 'STANDARD',
    });
    expect(input.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 5 });
    expect(input.GlobalSecondaryIndexes[0].ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 5 });
    expect(input.GlobalSecondaryIndexes[0].Projection).toEqual({ ProjectionType: 'INCLUDE', NonKeyAttributes: [] });
    expect(input.LocalSecondaryIndexes[0].KeySchema[1]).toEqual({ AttributeName: 'x', KeyType: 'RANGE' });
    expect(input.TableClass).toBeUndefined();
    expect(createTableInput({ TableName: 'T', KeyAttributes: { PartitionKey: { AttributeName: 'p' } }, BillingMode: 'PROVISIONED' }).ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  it('descToDef converts DescribeTable output (on-demand)', () => {
    const def = descToDef(SHOP_DESC);
    expect(def).toMatchObject({
      TableName: 'Shop',
      KeyAttributes: { PartitionKey: { AttributeName: 'PK', AttributeType: 'S' }, SortKey: { AttributeName: 'SK', AttributeType: 'S' } },
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [{ IndexName: 'GSI1', KeyAttributes: { PartitionKey: { AttributeName: 'GSI1PK' } }, Projection: { ProjectionType: 'ALL' } }],
      LocalSecondaryIndexes: [{ IndexName: 'LSI1', Projection: { ProjectionType: 'KEYS_ONLY' } }],
    });
    expect(def.ProvisionedCapacitySettings).toBeUndefined();
    expect(createTableInput(def).AttributeDefinitions).toHaveLength(4);
  });

  it('descToDef handles provisioned tables, INCLUDE projections and missing info', () => {
    const def = descToDef({
      TableName: 'P',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }],
      ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      GlobalSecondaryIndexes: [{ IndexName: 'G', KeySchema: [{ AttributeName: 'x', KeyType: 'HASH' }], Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a'] } }, { IndexName: 'H', KeySchema: [{ AttributeName: 'y', KeyType: 'HASH' }] }],
      LocalSecondaryIndexes: [{ IndexName: 'L', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'z', KeyType: 'RANGE' }] }],
    });
    expect(def.BillingMode).toBe('PROVISIONED');
    expect(def.KeyAttributes.PartitionKey.AttributeType).toBe('N');
    expect(def.KeyAttributes.SortKey).toBeUndefined();
    expect(def.ProvisionedCapacitySettings.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 3, WriteCapacityUnits: 4 });
    expect(def.GlobalSecondaryIndexes[0].Projection).toEqual({ ProjectionType: 'INCLUDE', NonKeyAttributes: ['a'] });
    expect(def.GlobalSecondaryIndexes[1].Projection).toEqual({ ProjectionType: 'ALL' });
    expect(def.GlobalSecondaryIndexes[1].KeyAttributes.PartitionKey.AttributeType).toBe('S');
    expect(def.LocalSecondaryIndexes[0].Projection).toEqual({ ProjectionType: 'ALL' });
    expect(descToDef({ TableName: 'Q', KeySchema: [{ AttributeName: 'k', KeyType: 'HASH' }] }).ProvisionedCapacitySettings.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  it('inferNonKeyAttributes keeps declared attributes and adds new ones from data', () => {
    const attrs = inferNonKeyAttributes({
      KeyAttributes: { PartitionKey: { AttributeName: 'pk' }, SortKey: { AttributeName: 'sk' } },
      NonKeyAttributes: [{ AttributeName: 'name', AttributeType: 'S' }],
      TableData: [{ pk: { S: 'a' }, sk: { S: 'b' }, name: { N: '1' }, total: { N: '2' } }, { pk: { S: 'c' }, tags: { SS: ['x'] } }],
    });
    expect(attrs).toEqual([
      { AttributeName: 'name', AttributeType: 'S' },
      { AttributeName: 'total', AttributeType: 'N' },
      { AttributeName: 'tags', AttributeType: 'SS' },
    ]);
    expect(inferNonKeyAttributes({})).toEqual([]);
  });

  it('cloudFormation produces unique logical ids', () => {
    const cfn = cloudFormation({
      ModelName: 'M',
      DataModel: [
        { TableName: 'my-table', KeyAttributes: { PartitionKey: { AttributeName: 'pk' } } },
        { TableName: 'my_table', KeyAttributes: { PartitionKey: { AttributeName: 'pk' } } },
        { TableName: '---', KeyAttributes: { PartitionKey: { AttributeName: 'pk' } } },
      ],
    });
    expect(Object.keys(cfn.Resources)).toEqual(['Mytable', 'MytableX', 'Table']);
    expect(cfn.Resources.Mytable).toMatchObject({ Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'my-table' } });
    expect(cfn.Description).toMatch(/^M -/);
    expect(cloudFormation({}).Description).toMatch(/^Data model/);
  });
});

describe('genCode', () => {
  const input = { TableName: 'T', Key: { pk: { S: "it's" } }, ConsistentRead: true, Off: false, Nothing: null, Limit: 5, Empty: [], Obj: {} };

  it('python (boto3)', () => {
    const code = genCode('GetItem', input, 'python', { region: 'eu-west-1', endpoint: 'http://localhost:8000' });
    expect(code).toContain('client = boto3.client("dynamodb", region_name="eu-west-1", endpoint_url="http://localhost:8000")');
    expect(code).toContain('response = client.get_item(**{');
    expect(code).toContain('"ConsistentRead": True');
    expect(code).toContain('"Off": False');
    expect(code).toContain('"Nothing": None');
    expect(code).toContain('"Limit": 5');
    expect(code).toContain('"Empty": []');
    expect(code).toContain('"Obj": {}');
    expect(genCode('BatchWriteItem', { RequestItems: { T: [{ a: 1 }] } }, 'python')).toContain('client.batch_write_item(**{');
    expect(genCode('X', { a: undefined }, 'python')).toContain('"a": None');
    expect(genCode('X', {}, 'python')).toContain('region_name="us-east-1")');
  });

  it('javascript (SDK v3)', () => {
    const code = genCode('Query', { TableName: 'T' }, 'javascript', { region: 'ap-south-1' });
    expect(code).toContain('import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";');
    expect(code).toContain('new DynamoDBClient({ region: "ap-south-1" })');
    expect(code).toContain('await client.send(new QueryCommand(input));');
    expect(genCode('Query', {}, 'javascript', { endpoint: 'http://x' })).toContain('endpoint: "http://x"');
  });

  it('AWS CLI escapes single quotes', () => {
    const code = genCode('TransactWriteItems', input, 'cli', { region: 'us-east-2', endpoint: 'http://e' });
    expect(code).toMatch(/^aws dynamodb transact-write-items/);
    expect(code).toContain('--region us-east-2');
    expect(code).toContain('--endpoint-url http://e');
    expect(code).toContain(`it'\\''s`);
    expect(genCode('Scan', {}, 'cli')).not.toContain('endpoint-url');
  });
});

describe('CSV and JSON import / export', () => {
  it('itemsToCsv writes a header and quotes cells', () => {
    const csv = itemsToCsv(
      [
        { pk: { S: 'a' }, n: { N: '1' }, t: { BOOL: true }, z: { NULL: true }, m: { M: { k: { S: 'v' } } }, b: { B: 'aGk=' } },
        { pk: { S: 'b,"c"\nd' } },
      ],
      ['pk'],
    );
    expect(csv).toBe('pk,b,m,n,t,z\na,aGk=,"{""k"":""v""}",1,true,\n"b,""c""\nd",,,,,');
    expect(itemsToCsv([])).toBe('');
  });

  it('parseCsv handles quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsv('a,b\r\n"x,1","say ""hi"""\n\n"multi\nline",z')).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('csvToItems infers types and honours header hints', () => {
    const items = csvToItems('pk,price,flag,meta,zip (S),tags (SS),cfg (M),list (l),empty,bad\nA,12.5,true,"{""a"":1}",007,"x,y","{""k"":2}","[1]",,{nope');
    expect(items).toEqual([
      {
        pk: { S: 'A' }, price: { N: '12.5' }, flag: { BOOL: true }, meta: { M: { a: { N: '1' } } }, zip: { S: '007' },
        tags: { SS: ['x', 'y'] }, cfg: { M: { k: { N: '2' } } }, list: { L: [{ N: '1' }] }, bad: { S: '{nope' },
      },
    ]);
  });

  it('csvToItems options disable inference', () => {
    expect(csvToItems('a,b\n1,[2]', { inferNumbers: false, inferJson: false })).toEqual([{ a: { S: '1' }, b: { S: '[2]' } }]);
    expect(csvToItems('a,b\n007,false')).toEqual([{ a: { S: '007' }, b: { BOOL: false } }]);
    expect(csvToItems('')).toEqual([]);
    expect(csvToItems(',a\nx,y')).toEqual([{ a: { S: 'y' } }]);
  });

  it('parseJsonItems accepts arrays, objects, DynamoDB responses and JSON lines', () => {
    expect(parseJsonItems('[{"a":1},{"b":{"S":"x"}}]')).toEqual([{ a: { N: '1' } }, { b: { S: 'x' } }]);
    expect(parseJsonItems('{"a":"x"}')).toEqual([{ a: { S: 'x' } }]);
    expect(parseJsonItems('{"Items":[{"a":{"N":"1"}}]}')).toEqual([{ a: { N: '1' } }]);
    expect(parseJsonItems('{"Item":{"a":{"N":"1"}}}')).toEqual([{ a: { N: '1' } }]);
    expect(parseJsonItems('{"Item":{"a":{"S":"1"}}}\n{"Item":{"a":{"S":"2"}}}\n')).toEqual([{ a: { S: '1' } }, { a: { S: '2' } }]);
    expect(parseJsonItems('[{"Item":"not ddb"}]')).toEqual([{ Item: { S: 'not ddb' } }]);
    expect(() => parseJsonItems('{broken')).toThrow();
  });

  it('chunk splits arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 25)).toEqual([]);
  });

  it('REGIONS contains common regions without duplicates', () => {
    expect(REGIONS).toContain('ap-southeast-1');
    expect(new Set(REGIONS).size).toBe(REGIONS.length);
  });
});
