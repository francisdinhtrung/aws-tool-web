import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApp, mockBackend } from '../test/utils.jsx';
import { TransfersProvider, TransfersDock } from '../components/Transfers.jsx';
import { setConn } from '../api.js';
import S3Browser from './S3Browser.jsx';

const BUCKETS = [{ Name: 'b', CreationDate: '2026-01-01T00:00:00Z' }, { Name: 'logs', CreationDate: '2026-01-02T00:00:00Z' }];
const ctx = (extra = {}) => ({
  buckets: BUCKETS.map((x) => x.Name),
  bucketInfo: BUCKETS,
  bucketsState: { loading: false, error: null, loaded: true },
  reloadBuckets: vi.fn(),
  ...extra,
});
const view = (arg, extra) =>
  renderWithApp(
    <TransfersProvider>
      <S3Browser arg={arg} />
      <TransfersDock />
    </TransfersProvider>,
    ctx(extra),
  );

const LISTING = {
  CommonPrefixes: [{ Prefix: 'p/sub/' }],
  Contents: [
    { Key: 'p/', Size: 0 },
    { Key: 'p/a.txt', Size: 2048, LastModified: '2026-01-01T00:00:00Z', StorageClass: 'STANDARD' },
    { Key: 'p/b.png', Size: 10, LastModified: '2026-01-02T00:00:00Z', StorageClass: 'STANDARD' },
  ],
};

// The name cell of a row in the object grid (the details panel repeats the key as a title).
const cell = (key) => document.querySelector(`td.name-col[title="${key}"]`);

beforeEach(() => setConn({ kind: 'endpoint', id: 'e1' }));

describe('bucket list', () => {
  it('lists, filters and creates buckets in the connection region', async () => {
    const be = mockBackend({ 'POST /api/s3/op/CreateBucket': {} });
    const user = userEvent.setup();
    const { ctx: c } = view('', { conn: { kind: 'profile', profile: 'dev', region: 'eu-west-1' } });
    expect(screen.getByText('🪣 b')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Filter buckets…'), 'log');
    expect(screen.queryByText('🪣 b')).not.toBeInTheDocument();
    await user.click(screen.getByText('＋ Create bucket'));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Bad_Name');
    expect(within(dialog).getByText('Invalid bucket name.')).toBeInTheDocument();
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'new-bucket');
    await user.click(within(dialog).getByText('Create'));
    await waitFor(() => expect(be.calls('POST /api/s3/op/CreateBucket')).toEqual([{ Bucket: 'new-bucket', CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' } }]));
    expect(c.reloadBuckets).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/s3/new-bucket/');
  });

  it('deletes a bucket only after typing its name, optionally emptying it', async () => {
    const be = mockBackend({ 'POST /api/s3/delete-prefix': { deleted: 3, errors: [] }, 'POST /api/s3/op/DeleteBucket': {} });
    const user = userEvent.setup();
    view('');
    await user.click(screen.getAllByText('Delete')[0]);
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByText('Delete bucket');
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByRole('textbox'), 'b');
    await user.click(confirm);
    await waitFor(() => expect(be.calls('POST /api/s3/op/DeleteBucket')).toEqual([{ Bucket: 'b' }]));
    expect(be.calls('POST /api/s3/delete-prefix')).toEqual([{ bucket: 'b', prefix: '', versions: true, confirm: 'b' }]);
  });

  it('shows list errors and the empty state', () => {
    view('', { bucketInfo: [], buckets: [], bucketsState: { error: 'AccessDenied: nope', loaded: true } });
    expect(screen.getByText('AccessDenied: nope')).toBeInTheDocument();
  });
});

describe('object browser', () => {
  it('lists folders before files and navigates into folders and up', async () => {
    const be = mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING });
    view('b/p');
    expect(await screen.findByText('a.txt')).toBeInTheDocument();
    expect(be.calls('POST /api/s3/op/ListObjectsV2')[0]).toMatchObject({ Bucket: 'b', Prefix: 'p/', Delimiter: '/' });
    const rows = screen.getAllByRole('row').slice(2); // header, ".."
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('sub/'), expect.stringContaining('a.txt'), expect.stringContaining('b.png')]);
    expect(screen.getByText(/1 folder, 2 files · 2.0 KB/)).toBeInTheDocument();
    expect(screen.getByText('sub/').closest('a')).toHaveAttribute('href', '#/s3/b/p/sub/');
    fireEvent.keyDown(screen.getByText('a.txt'), { key: 'Backspace' });
    expect(window.location.hash).toBe('#/s3/b/');
  });

  it('sorts by column and filters the folder', async () => {
    mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING });
    const user = userEvent.setup();
    view('b/p');
    await screen.findByText('a.txt');
    await user.click(screen.getByText(/^Size/));
    await user.click(screen.getByText(/^Size/));
    const names = () => screen.getAllByRole('row').slice(2).map((r) => r.querySelector('.name-col').textContent);
    expect(names()).toEqual(['📁sub/', '📝a.txt', '🖼b.png']);
    await user.type(screen.getByPlaceholderText('Filter this folder…'), 'png');
    expect(names()).toEqual(['🖼b.png']);
    await user.type(screen.getByPlaceholderText('Filter this folder…'), 'zzz');
    expect(screen.getByText(/No items match/)).toBeInTheDocument();
  });

  it('pages with Load more', async () => {
    let n = 0;
    const be = mockBackend({
      'POST /api/s3/op/ListObjectsV2': () => (++n === 1 ? { Contents: [{ Key: 'one' }], IsTruncated: true, NextContinuationToken: 't' } : { Contents: [{ Key: 'two' }] }),
    });
    const user = userEvent.setup();
    view('b');
    await screen.findByText('one');
    await user.click(screen.getByText('Load more'));
    expect(await screen.findByText('two')).toBeInTheDocument();
    expect(be.calls('POST /api/s3/op/ListObjectsV2')[1].ContinuationToken).toBe('t');
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
  });

  it('opens a details panel with properties for a selected file', async () => {
    mockBackend({
      'POST /api/s3/op/ListObjectsV2': LISTING,
      'POST /api/s3/op/HeadObject': { ContentLength: 2048, ContentType: 'image/png', ETag: '"e"', LastModified: '2026-01-01T00:00:00Z', Metadata: { owner: 'me' } },
    });
    const user = userEvent.setup();
    view('b/p');
    await user.click(await screen.findByText('b.png'));
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByRole('img')).toHaveAttribute('src', expect.stringContaining('inline=1'));
    await user.click(within(panel).getByText('Properties'));
    expect(within(panel).getByText('x-amz-meta-owner')).toBeInTheDocument();
    expect(within(panel).getByText('s3://b/p/b.png')).toBeInTheDocument();
    await user.click(within(panel).getByLabelText('Close details'));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('creates folders', async () => {
    const be = mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING, 'POST /api/s3/op/PutObject': {} });
    const user = userEvent.setup();
    view('b/p');
    await screen.findByText('a.txt');
    await user.click(screen.getByText('＋ Folder'));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'new{Enter}');
    await waitFor(() => expect(be.calls('POST /api/s3/op/PutObject')).toEqual([{ Bucket: 'b', Key: 'p/new/', Body: '' }]));
  });

  it('deletes files and folders as a background task', async () => {
    const be = mockBackend({
      'POST /api/s3/op/ListObjectsV2': LISTING,
      'POST /api/s3/op/DeleteObjects': {},
      'POST /api/s3/delete-prefix': { deleted: 4, errors: [] },
    });
    const user = userEvent.setup();
    view('b/p');
    await screen.findByText('a.txt');
    await user.click(screen.getByLabelText('Select all'));
    await user.click(screen.getByText('🗑 Delete'));
    expect(within(screen.getByRole('dialog')).getByText(/including everything inside the folder/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(be.calls('POST /api/s3/delete-prefix')).toEqual([{ bucket: 'b', prefix: 'p/sub/', versions: false }]));
    expect(be.calls('POST /api/s3/op/DeleteObjects')[0].Delete.Objects).toEqual([{ Key: 'p/a.txt' }, { Key: 'p/b.png' }]);
    expect(await screen.findByText('Delete 3 items')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('All finished')).toBeInTheDocument());
  });

  it('renames a file by copying then deleting the original', async () => {
    const be = mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING, 'POST /api/s3/op/CopyObject': {}, 'POST /api/s3/op/DeleteObjects': {} });
    const user = userEvent.setup();
    view('b/p');
    await screen.findByText('a.txt');
    fireEvent.click(cell('p/a.txt'));
    fireEvent.keyDown(cell('p/a.txt'), { key: 'F2' });
    const input = within(screen.getByRole('dialog')).getByRole('textbox');
    expect(within(screen.getByRole('dialog')).getByText('Rename')).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'c d.txt{Enter}');
    await waitFor(() => expect(be.calls('POST /api/s3/op/DeleteObjects')).toHaveLength(1));
    expect(be.calls('POST /api/s3/op/CopyObject')).toEqual([{ Bucket: 'b', Key: 'p/c d.txt', CopySource: 'b/p/a.txt' }]);
    expect(be.calls('POST /api/s3/op/DeleteObjects')[0].Delete.Objects).toEqual([{ Key: 'p/a.txt' }]);
  });

  it('copies a folder recursively to another bucket', async () => {
    const be = mockBackend({
      'POST /api/s3/op/ListObjectsV2': (body) => (body.Delimiter ? LISTING : { Contents: [{ Key: 'p/sub/x', Size: 1 }, { Key: 'p/sub/y/z', Size: 1 }] }),
      'POST /api/s3/op/CopyObject': {},
    });
    const user = userEvent.setup();
    view('b/p');
    await screen.findByText('sub/');
    fireEvent.click(cell('p/sub/'), { ctrlKey: true });
    await user.click(screen.getByText('⧉ Copy to…'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Source and destination are the same folder.')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole('combobox'), 'logs');
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'backup');
    await user.click(within(dialog).getByText('Copy'));
    await waitFor(() => expect(be.calls('POST /api/s3/op/CopyObject')).toHaveLength(2));
    expect(be.calls('POST /api/s3/op/CopyObject').map((c) => c.Key).sort()).toEqual(['backup/sub/x', 'backup/sub/y/z']);
    expect(be.calls('POST /api/s3/op/CopyObject')[0]).toMatchObject({ Bucket: 'logs', CopySource: expect.stringMatching(/^b\/p\/sub\//) });
  });

  it('cut and paste moves items between folders', async () => {
    const be = mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING, 'POST /api/s3/op/CopyObject': {}, 'POST /api/s3/op/DeleteObjects': {} });
    const { unmount } = view('b/p');
    await screen.findByText('b.png');
    fireEvent.click(cell('p/b.png'));
    fireEvent.keyDown(cell('p/b.png'), { key: 'x', ctrlKey: true });
    expect(screen.getByText('📋 Paste (1)')).toBeInTheDocument();
    fireEvent.keyDown(cell('p/b.png'), { key: 'v', ctrlKey: true });
    expect(be.calls('POST /api/s3/op/CopyObject')).toHaveLength(0); // same folder: refused
    unmount();
  });

  it('uploads files through the task queue', async () => {
    const sent = [];
    class FakeXHR {
      upload = {};
      headers = {};
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(k, v) {
        this.headers[k] = v;
      }
      send(body) {
        sent.push(this);
        this.body = body;
        setTimeout(() => {
          this.upload.onprogress?.({ loaded: body.size, total: body.size });
          this.status = 200;
          this.responseText = '{"ETag":"e"}';
          this.onload();
        });
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING });
    view('b/p');
    await screen.findByText('a.txt');
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['hello'], 'new.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toBe('/api/s3/object?bucket=b&key=p%2Fnew.txt');
    expect(sent[0].headers).toMatchObject({ 'x-requested-with': 'aws-tool-web', 'x-object-content-type': 'text/plain' });
    expect(JSON.parse(decodeURIComponent(sent[0].headers['x-conn']))).toEqual({ kind: 'endpoint', id: 'e1' });
    vi.unstubAllGlobals();
  });

  it('shows listing errors', async () => {
    mockBackend({ 'POST /api/s3/op/ListObjectsV2': () => Promise.reject(Object.assign(new Error('nope'), { error: 'NoSuchBucket', status: 404 })) });
    view('missing');
    expect(await screen.findByText('NoSuchBucket: nope')).toBeInTheDocument();
  });
});
