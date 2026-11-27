import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';
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

function captureUploads({ status = 200, responseText = '{"ETag":"e"}' } = {}) {
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
        this.status = status;
        this.responseText = responseText;
        this.onload();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  return sent;
}

beforeEach(() => setConn({ kind: 'endpoint', id: 'e1' }));
afterEach(() => vi.unstubAllGlobals());

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

describe('pre-signed URLs', () => {
  it('generates and copies a link for an exact S3 URI outside the listed buckets', async () => {
    const url = 'https://example.test/object?X-Amz-Signature=fixture';
    const backend = mockBackend({ 'POST /api/s3/presign': { url } });
    const user = userEvent.setup();
    view('');
    await user.click(screen.getByRole('button', { name: 'Create pre-signed URL' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create pre-signed URL' }));
    const path = dialog.getByRole('textbox', { name: /^S3 URI/ });
    const generate = () => dialog.getByRole('button', { name: 'Generate', exact: true });
    expect(generate()).toBeDisabled();
    fireEvent.change(path, { target: { value: 's3://private-bucket/reports/' } });
    expect(generate()).toBeDisabled();

    fireEvent.change(path, { target: { value: 's3://private-bucket/reports/résumé #?+%2F.pdf' } });
    await user.selectOptions(dialog.getByLabelText('Expires in'), '900');
    await user.click(generate());
    expect(await dialog.findByRole('textbox', { name: 'Pre-signed URL' })).toHaveValue(url);
    expect(backend.calls('POST /api/s3/presign')).toEqual([{ bucket: 'private-bucket', key: 'reports/résumé #?+%2F.pdf', expires: 900 }]);
    expect(backend.calls('POST /api/s3/op/ListObjectsV2')).toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Copy URL' }));
    expect(await navigator.clipboard.readText()).toBe(url);

    await user.selectOptions(dialog.getByLabelText('Expires in'), '3600');
    expect(dialog.queryByRole('textbox', { name: 'Pre-signed URL' })).not.toBeInTheDocument();
  });

  it('prefills the current S3 folder and lets the user complete the file path', async () => {
    const backend = mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING, 'POST /api/s3/presign': { url: 'https://example.test/signed' } });
    const user = userEvent.setup();
    view('b/p');
    await user.click(screen.getByRole('button', { name: 'Create pre-signed URL' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create pre-signed URL' }));
    const path = dialog.getByRole('textbox', { name: /^S3 URI/ });
    expect(path).toHaveValue('s3://b/p/');
    expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    await user.type(path, 'sub/unlisted.txt{Enter}');
    expect(await dialog.findByRole('textbox', { name: 'Pre-signed URL' })).toHaveValue('https://example.test/signed');
    expect(backend.calls('POST /api/s3/presign')).toEqual([{ bucket: 'b', key: 'p/sub/unlisted.txt', expires: 3600 }]);
  });

  it('lists role pages for the selected AWS profile and signs with the chosen role', async () => {
    const profile = { kind: 'profile', profile: 'work-sso', region: 'ap-southeast-1' };
    const firstRole = 'arn:aws:iam::123456789012:role/ReportsRead';
    const chosenRole = 'arn:aws:iam::123456789012:role/team/S3Download';
    const backend = mockBackend({
      'POST /api/lambda/iam/ListRoles': ({ Marker }) => Marker
        ? { Roles: [{ Arn: chosenRole, RoleName: 'S3Download' }], IsTruncated: false }
        : { Roles: [{ Arn: firstRole, RoleName: 'ReportsRead' }], IsTruncated: true, Marker: 'next' },
      'POST /api/s3/presign': { url: 'https://example.test/role-signed', expiresAt: '2026-11-27T10:00:00Z' },
    });
    const user = userEvent.setup();
    view('', { conn: profile });
    await user.click(screen.getByRole('button', { name: 'Create pre-signed URL' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create pre-signed URL' }));
    fireEvent.change(dialog.getByRole('textbox', { name: /^S3 URI/ }), { target: { value: 's3://private-bucket/report.csv' } });
    expect(backend.calls('POST /api/lambda/iam/ListRoles')).toHaveLength(0);
    await user.selectOptions(dialog.getByLabelText('Signing credentials'), 'role');
    await dialog.findByRole('option', { name: 'S3Download' });
    await user.selectOptions(dialog.getByRole('combobox', { name: /^IAM role/ }), chosenRole);
    expect(dialog.getByRole('textbox', { name: /^IAM role ARN/ })).toHaveValue(chosenRole);
    await user.click(dialog.getByRole('button', { name: 'Generate', exact: true }));
    expect(await dialog.findByRole('textbox', { name: 'Pre-signed URL' })).toHaveValue('https://example.test/role-signed');
    expect(dialog.getByText(/^Expires at /)).toBeInTheDocument();
    expect(backend.calls('POST /api/lambda/iam/ListRoles')).toEqual([{ MaxItems: 1000 }, { MaxItems: 1000, Marker: 'next' }]);
    expect(backend.calls('POST /api/s3/presign')).toEqual([{ bucket: 'private-bucket', key: 'report.csv', expires: 3600, roleArn: chosenRole }]);
    const roleRequests = backend.log.filter(({ key }) => key.includes('/iam/ListRoles') || key.includes('/s3/presign'));
    expect(roleRequests.map(({ headers }) => JSON.parse(decodeURIComponent(headers['x-conn'])))).toEqual([profile, profile, profile]);
  });

  it('accepts a pasted role ARN when the AWS profile cannot list roles', async () => {
    const roleArn = 'arn:aws:iam::987654321098:role/SharedFilesRead';
    const backend = mockBackend({
      'POST /api/lambda/iam/ListRoles': () => { throw awsError('AccessDenied', 'Missing iam:ListRoles', 403); },
      'POST /api/s3/presign': { url: 'https://example.test/role-signed' },
    });
    const user = userEvent.setup();
    view('', { conn: { kind: 'profile', profile: 'work-sso', region: 'ap-southeast-1' } });
    await user.click(screen.getByRole('button', { name: 'Create pre-signed URL' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create pre-signed URL' }));
    fireEvent.change(dialog.getByRole('textbox', { name: /^S3 URI/ }), { target: { value: 's3://shared-bucket/report.csv' } });
    await user.selectOptions(dialog.getByLabelText('Signing credentials'), 'role');
    expect(await dialog.findByText(/Could not list IAM roles/)).toHaveTextContent('AccessDenied');
    const generate = dialog.getByRole('button', { name: 'Generate', exact: true });
    expect(generate).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox', { name: /^IAM role ARN/ }), { target: { value: roleArn } });
    fireEvent.change(dialog.getByLabelText('External ID (optional)'), { target: { value: 'shared-external-id' } });
    await user.click(generate);
    expect(await dialog.findByRole('textbox', { name: 'Pre-signed URL' })).toBeInTheDocument();
    expect(backend.calls('POST /api/s3/presign')).toEqual([{
      bucket: 'shared-bucket', key: 'report.csv', expires: 3600, roleArn, externalId: 'shared-external-id',
    }]);
  });
});

describe('upload to S3 path', () => {
  it.each([
    { arg: 'b/p', path: 's3://logs/archive/résumé #+%2F.txt', key: 'archive/résumé #+%2F.txt' },
    { arg: '', path: 's3://logs/archive/', key: 'archive/local.txt' },
  ])('uploads a single file to $path', async ({ arg, path, key }) => {
    const sent = captureUploads();
    const user = userEvent.setup();
    const backend = mockBackend({
      'POST /api/s3/op/ListObjectsV2': LISTING,
      'POST /api/s3/op/HeadObject': () => { throw awsError('NotFound', 'Object not found', 404); },
    });
    view(arg);
    if (arg) {
      await screen.findByText('a.txt');
      await user.click(screen.getByRole('button', { name: '⬆ Upload ▾' }));
    }
    await user.click(screen.getByRole('button', { name: 'Upload to S3 path' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Upload file to S3 path' }));
    const submit = dialog.getByRole('button', { name: 'Upload' });
    const destination = dialog.getByRole('textbox', { name: /^Destination S3 path/ });
    expect(destination).toHaveValue(arg ? 's3://b/p/' : '');
    expect(submit).toBeDisabled();

    const file = new File(['hello'], 'local.txt', { type: 'text/plain' });
    await user.upload(dialog.getByLabelText('File'), file);
    fireEvent.change(destination, { target: { value: 'https://example.com/file' } });
    expect(submit).toBeDisabled();
    fireEvent.change(destination, { target: { value: path } });
    const uri = `s3://logs/${key}`;
    expect(dialog.getByText(uri)).toBeInTheDocument();
    await user.click(submit);

    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(screen.getByText(uri)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PUT', body: file });
    expect(backend.calls('POST /api/s3/op/HeadObject')).toEqual([{ Bucket: 'logs', Key: key }]);
    expect(sent[0].headers['if-none-match']).toBe('*');
    expect(Object.fromEntries(new URLSearchParams(sent[0].url.split('?')[1]))).toEqual({ bucket: 'logs', key });
  });

  async function prepareUpload(headObject, response) {
    const sent = captureUploads(response);
    const user = userEvent.setup();
    mockBackend({ 'POST /api/s3/op/HeadObject': headObject });
    view('');
    await user.click(screen.getByRole('button', { name: 'Upload to S3 path' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Upload file to S3 path' }));
    const file = new File(['hello'], 'local.txt');
    await user.upload(dialog.getByLabelText('File'), file);
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 's3://logs/archive/local.txt' } });
    await user.click(dialog.getByRole('button', { name: 'Upload' }));
    return { sent, user, file };
  }

  it('queues an existing destination only after explicit overwrite confirmation', async () => {
    const { sent, user, file } = await prepareUpload({ ETag: '"existing"' });
    const confirm = () => within(screen.getByRole('dialog', { name: 'Overwrite existing file?' }));
    expect(confirm().getByText('s3://logs/archive/local.txt')).toBeInTheDocument();
    expect(sent).toHaveLength(0);

    await user.click(confirm().getByRole('button', { name: 'Cancel' }));
    const form = within(screen.getByRole('dialog', { name: 'Upload file to S3 path' }));
    expect(form.getByLabelText('File').files[0]).toBe(file);
    expect(sent).toHaveLength(0);

    await user.click(form.getByRole('button', { name: 'Upload' }));
    await user.click(confirm().getByRole('button', { name: 'Overwrite' }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['if-none-match']).toBeUndefined();
  });

  it('shows a lookup error without sending an upload when access is denied', async () => {
    const { sent } = await prepareUpload(() => { throw awsError('AccessDenied', 'Forbidden', 403); });
    expect(await screen.findByText(/Could not check the destination.*AccessDenied/)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('does not upload if the dialog closes during the destination check', async () => {
    let rejectCheck;
    const pending = new Promise((_resolve, reject) => { rejectCheck = reject; });
    const { sent, user } = await prepareUpload(() => pending);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => rejectCheck(awsError('NotFound', 'Object not found', 404)));
    expect(sent).toHaveLength(0);
  });

  it('reports a concurrent creation as a failed task without retrying the upload', async () => {
    const { sent } = await prepareUpload(() => { throw awsError('NotFound', 'Object not found', 404); }, {
      status: 412,
      responseText: '{"error":"PreconditionFailed","message":"Key exists"}',
    });
    expect(await screen.findByText(/The S3 destination changed during upload/)).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['if-none-match']).toBe('*');
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
    const sent = captureUploads();
    mockBackend({ 'POST /api/s3/op/ListObjectsV2': LISTING });
    view('b/p');
    await screen.findByText('a.txt');
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['hello'], 'new.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toBe('/api/s3/object?bucket=b&key=p%2Fnew.txt');
    expect(sent[0].headers).toMatchObject({ 'x-requested-with': 'aws-tool-web', 'x-object-content-type': 'text/plain' });
    expect(JSON.parse(decodeURIComponent(sent[0].headers['x-conn']))).toEqual({ kind: 'endpoint', id: 'e1' });
  });

  it('shows listing errors', async () => {
    mockBackend({ 'POST /api/s3/op/ListObjectsV2': () => Promise.reject(Object.assign(new Error('nope'), { error: 'NoSuchBucket', status: 404 })) });
    view('missing');
    expect(await screen.findByText('NoSuchBucket: nope')).toBeInTheDocument();
  });
});
