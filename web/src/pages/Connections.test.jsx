import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import Connections from './Connections.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

const PROFILES = [
  { name: 'default', region: 'us-west-2', type: 'static', settings: { region: 'us-west-2', aws_access_key_id: 'AKIAABCDEFGH1234', aws_secret_access_key: '' }, secrets: ['aws_secret_access_key'] },
  { name: 'admin', region: '', type: 'assume-role', settings: { role_arn: 'arn:aws:iam::1:role/Admin', source_profile: 'default', retry_mode: 'standard' }, secrets: [] },
  { name: 'corp', region: 'eu-west-1', type: 'sso', settings: { sso_account_id: '111', sso_role_name: 'Dev' }, secrets: [] },
  { name: 'odd', region: '', type: 'weird', settings: {}, secrets: [] },
];
const ENDPOINTS = [
  { id: 'e1', name: 'Local', endpoint: 'http://localhost:8000', region: 'us-east-1', authMode: 'local' },
  { id: 'e2', name: 'Stack', endpoint: 'http://ls:4566', region: 'us-east-1', authMode: 'keys', accessKeyId: 'AK', hasSecret: true },
  { id: 'e3', name: 'Prof', endpoint: 'http://p', region: 'us-east-1', authMode: 'profile', profile: 'default' },
];
const INFO = { configFile: '/root/.aws/config', credentialsFile: '/root/.aws/credentials', awsDirWritable: true };
const setup = (handlers = {}, ctx = {}) => {
  const api = mockBackend({ 'GET /api/info': INFO, ...handlers });
  const utils = renderWithApp(<Connections />, { profiles: PROFILES, endpoints: ENDPOINTS, conn: { kind: 'profile', profile: 'default' }, ...ctx });
  return { api, ...utils };
};
const row = (name) => screen.getByText(name, { selector: 'strong' }).closest('tr');

describe('<Connections>', () => {
  it('lists profiles and endpoints with details', async () => {
    setup();
    expect(await screen.findByText('/root/.aws/config')).toBeInTheDocument();
    expect(within(row('default')).getByText('active')).toBeInTheDocument();
    expect(within(row('default')).getByText(/key AKIA…1234/)).toBeInTheDocument();
    expect(within(row('admin')).getByText(/arn:aws:iam::1:role\/Admin.*via default/)).toBeInTheDocument();
    expect(within(row('corp')).getByText(/account 111 \/ Dev/)).toBeInTheDocument();
    expect(within(row('odd')).getByText('weird')).toBeInTheDocument();
    expect(within(row('Stack')).getByText('access keys')).toBeInTheDocument();
    expect(within(row('Prof')).getByText('profile default')).toBeInTheDocument();
    expect(within(row('Local')).getByText('dummy')).toBeInTheDocument();
  });

  it('shows empty states and a read-only warning', async () => {
    setup({ 'GET /api/info': { ...INFO, awsDirWritable: false } }, { profiles: [], endpoints: [], conn: { kind: 'endpoint', id: 'x' } });
    expect(await screen.findByText(/directory is read-only/)).toBeInTheDocument();
    expect(screen.getByText('+ New profile')).toBeDisabled();
    expect(screen.getByText(/No profiles found/)).toBeInTheDocument();
    expect(screen.getByText('No custom endpoints.')).toBeInTheDocument();
  });

  it('survives /api/info failing', async () => {
    setup({ 'GET /api/info': () => { throw awsError('Error', 'x', 500); } });
    await waitFor(() => expect(screen.queryByText(/Reading/)).toBeNull());
  });

  it('uses and tests connections', async () => {
    const { ctx, api } = setup({
      'POST /api/test': (b) => ({ identity: { arn: 'arn:me' }, tableCount: 3, more: true, region: 'us-west-2' }),
    });
    fireEvent.click(within(row('corp')).getByText('Use'));
    expect(ctx.setConn).toHaveBeenCalledWith({ kind: 'profile', profile: 'corp', region: 'eu-west-1' });
    fireEvent.click(within(row('odd')).getByText('Use'));
    expect(ctx.setConn).toHaveBeenLastCalledWith({ kind: 'profile', profile: 'odd', region: 'us-east-1' });
    fireEvent.click(within(row('Local')).getByText('Use'));
    expect(ctx.setConn).toHaveBeenLastCalledWith({ kind: 'endpoint', id: 'e1' });

    fireEvent.click(within(row('default')).getByText('Test'));
    expect(await within(row('default')).findByText(/✓ arn:me · 3\+ tables in us-west-2/)).toBeInTheDocument();
    expect(JSON.parse(decodeURIComponent(api.log.at(-1).headers['x-conn']))).toEqual({ kind: 'profile', profile: 'default', region: 'us-west-2' });
  });

  it('shows test failures for endpoints', async () => {
    setup({ 'POST /api/test': () => { throw awsError('NetworkingError', 'connect ECONNREFUSED'); } });
    fireEvent.click(within(row('Local')).getByText('Test'));
    expect(await within(row('Local')).findByText(/✗ NetworkingError: connect ECONNREFUSED/)).toBeInTheDocument();
  });

  it('shows test results without identity (endpoint)', async () => {
    setup({ 'POST /api/test': { tableCount: 0, region: 'us-east-1' } });
    fireEvent.click(within(row('Local')).getByText('Test'));
    expect(await within(row('Local')).findByText('✓ 0 tables in us-east-1')).toBeInTheDocument();
  });

  it('creates an access-key profile', async () => {
    const { api, ctx } = setup({ 'POST /api/profiles': { ok: true } });
    fireEvent.click(screen.getByText('+ New profile'));
    const dialog = screen.getByRole('dialog');
    const d = within(dialog);
    expect(d.getByText('Save profile')).toBeDisabled();
    fireEvent.change(d.getByPlaceholderText('my-profile'), { target: { value: 'new' } });
    fireEvent.change(d.getByLabelText('Default region'), { target: { value: 'ap-southeast-1' } });
    fireEvent.change(d.getByLabelText('Output format'), { target: { value: 'json' } });
    fireEvent.change(d.getByLabelText('Access key ID'), { target: { value: 'AKIANEW' } });
    fireEvent.change(d.getByLabelText('Secret access key'), { target: { value: 'sek' } });
    fireEvent.click(d.getByText('+ Add setting'));
    fireEvent.change(d.getByPlaceholderText('key (e.g. retry_mode)'), { target: { value: 'retry_mode' } });
    fireEvent.change(d.getByPlaceholderText('value'), { target: { value: 'adaptive' } });
    fireEvent.click(d.getByText('+ Add setting'));
    fireEvent.click(d.getAllByText('×').at(-1));
    fireEvent.click(d.getByText('Save profile'));
    await waitFor(() => expect(api.calls('POST /api/profiles')).toHaveLength(1));
    expect(api.calls('POST /api/profiles')[0]).toEqual({
      name: 'new',
      settings: { region: 'ap-southeast-1', output: 'json', aws_access_key_id: 'AKIANEW', aws_secret_access_key: 'sek', retry_mode: 'adaptive' },
    });
    expect(ctx.reloadConnections).toHaveBeenCalled();
    expect(await screen.findByText('Profile saved')).toBeInTheDocument();
  });

  it('edits a profile keeping secrets, renames the active profile', async () => {
    const { api, ctx } = setup({ 'PUT /api/profiles/:id': { ok: true } });
    fireEvent.click(within(row('default')).getByText('Edit'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByLabelText('Secret access key')).toHaveAttribute('placeholder', expect.stringMatching(/unchanged/));
    fireEvent.change(d.getByPlaceholderText('my-profile'), { target: { value: 'main' } });
    fireEvent.click(d.getByText('Save profile'));
    await waitFor(() => expect(api.calls('PUT /api/profiles/default')).toHaveLength(1));
    expect(api.calls('PUT /api/profiles/default')[0]).toEqual({ name: 'main', settings: { region: 'us-west-2', aws_access_key_id: 'AKIAABCDEFGH1234', aws_secret_access_key: '' } });
    await waitFor(() => expect(ctx.setConn).toHaveBeenCalledWith({ kind: 'profile', profile: 'main' }));
  });

  it('edits an assume-role profile with source profile and extra settings', async () => {
    const { api } = setup({ 'PUT /api/profiles/:id': { ok: true } });
    fireEvent.click(within(row('admin')).getByText('Edit'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByDisplayValue('retry_mode')).toBeInTheDocument();
    expect(d.getByLabelText('Source profile')).toHaveValue('default');
    fireEvent.change(d.getByLabelText('Source profile'), { target: { value: 'corp' } });
    fireEvent.change(d.getByDisplayValue('standard'), { target: { value: 'legacy' } });
    fireEvent.change(d.getByDisplayValue('retry_mode'), { target: { value: 'retry_mode' } });
    fireEvent.click(d.getByText('Save profile'));
    await waitFor(() => expect(api.log.some((l) => l.key === 'PUT /api/profiles/admin')).toBe(true));
    expect(api.log.find((l) => l.key === 'PUT /api/profiles/admin').body.settings).toEqual({
      role_arn: 'arn:aws:iam::1:role/Admin', source_profile: 'corp', retry_mode: 'legacy',
    });
  });

  it('switches credential type and shows the SSO hint; shows save errors', async () => {
    setup({ 'POST /api/profiles': () => { throw awsError('ProfileExists', 'Profile "x" already exists', 409); } });
    fireEvent.click(screen.getByText('+ New profile'));
    const d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByLabelText('Credential type'), { target: { value: 'sso' } });
    expect(d.getByText(/aws sso login --profile <name>/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText('SSO region'), { target: { value: 'us-east-1' } });
    fireEvent.change(d.getByPlaceholderText('my-profile'), { target: { value: 'x' } });
    expect(d.getByText(/aws sso login --profile x/)).toBeInTheDocument();
    fireEvent.click(d.getByText('Save profile'));
    expect(await d.findByText('ProfileExists: Profile "x" already exists')).toBeInTheDocument();
    fireEvent.click(d.getAllByText('×').at(-1));
    fireEvent.click(d.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes profiles after confirmation and clears the active connection', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api, ctx } = setup({ 'DELETE /api/profiles/:id': { ok: true } });
    fireEvent.click(within(row('default')).getByText('Delete'));
    expect(api.log.some((l) => l.key.startsWith('DELETE'))).toBe(false);
    fireEvent.click(within(row('default')).getByText('Delete'));
    await waitFor(() => expect(ctx.setConn).toHaveBeenCalledWith(null));
    expect(await screen.findByText('Profile deleted')).toBeInTheDocument();
    fireEvent.click(within(row('corp')).getByText('Delete'));
    await waitFor(() => expect(api.log.filter((l) => l.key.startsWith('DELETE'))).toHaveLength(2));
    expect(ctx.setConn).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('reports profile delete errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ 'DELETE /api/profiles/:id': () => { throw awsError('ProfileNotFound', 'gone', 404); } });
    fireEvent.click(within(row('corp')).getByText('Delete'));
    expect(await screen.findByText('ProfileNotFound: gone')).toBeInTheDocument();
  });

  it('creates an endpoint with keys and edits one with a profile', async () => {
    const { api } = setup({ 'POST /api/connections': { id: 'n' }, 'PUT /api/connections/:id': { id: 'e3' } });
    fireEvent.click(screen.getByText('+ New endpoint'));
    let d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByDisplayValue('DynamoDB Local'), { target: { value: 'Mine' } });
    fireEvent.change(d.getByDisplayValue('http://localhost:8000'), { target: { value: 'http://x:1' } });
    fireEvent.change(d.getByDisplayValue('us-east-1'), { target: { value: 'eu-west-1' } });
    fireEvent.change(d.getByDisplayValue('Dummy (DynamoDB Local)'), { target: { value: 'keys' } });
    fireEvent.change(d.getByLabelText('Access key ID'), { target: { value: 'AK' } });
    fireEvent.change(d.getByLabelText('Secret access key'), { target: { value: 'SK' } });
    fireEvent.click(d.getByText('Save'));
    await waitFor(() => expect(api.calls('POST /api/connections')).toHaveLength(1));
    expect(api.calls('POST /api/connections')[0]).toEqual({ name: 'Mine', endpoint: 'http://x:1', region: 'eu-west-1', authMode: 'keys', accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(await screen.findByText('Connection saved')).toBeInTheDocument();

    fireEvent.click(within(row('Prof')).getByText('Edit'));
    d = within(screen.getByRole('dialog'));
    expect(d.getByText('Edit: Prof')).toBeInTheDocument();
    fireEvent.change(d.getByLabelText('Profile'), { target: { value: 'corp' } });
    fireEvent.click(d.getByText('Save'));
    await waitFor(() => expect(api.log.some((l) => l.key === 'PUT /api/connections/e3')).toBe(true));
    expect(api.log.find((l) => l.key === 'PUT /api/connections/e3').body.profile).toBe('corp');
  });

  it('shows the unchanged-secret placeholder and endpoint errors', async () => {
    setup({ 'PUT /api/connections/:id': () => { throw awsError('InvalidEndpoint', 'Endpoint must be an http(s) URL'); } });
    fireEvent.click(within(row('Stack')).getByText('Edit'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByLabelText('Secret access key')).toHaveAttribute('placeholder', '(unchanged)');
    fireEvent.click(d.getByText('Save'));
    expect(await d.findByText('InvalidEndpoint: Endpoint must be an http(s) URL')).toBeInTheDocument();
    fireEvent.click(d.getByText('Cancel'));
  });

  it('deletes endpoints and clears the active one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api, ctx } = setup({ 'DELETE /api/connections/:id': { ok: true } }, { conn: { kind: 'endpoint', id: 'e1' } });
    fireEvent.click(within(row('Local')).getByText('Delete'));
    fireEvent.click(within(row('Local')).getByText('Delete'));
    await waitFor(() => expect(ctx.setConn).toHaveBeenCalledWith(null));
    fireEvent.click(within(row('Stack')).getByText('Delete'));
    await waitFor(() => expect(api.log.filter((l) => l.key.startsWith('DELETE'))).toHaveLength(2));
    expect(ctx.setConn).toHaveBeenCalledTimes(1);
  });
});
