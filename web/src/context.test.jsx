import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { connInfo, navigate, useHashRoute } from './context.js';

describe('connInfo', () => {
  const profiles = [{ name: 'dev', region: 'eu-west-1' }, { name: 'nor', region: '' }];
  const endpoints = [{ id: 'e1', name: 'Local', endpoint: 'http://l:8000', region: 'us-east-1' }];
  it.each([
    [null, {}],
    [{ kind: 'endpoint', id: 'e1' }, { region: 'us-east-1', endpoint: 'http://l:8000', label: 'Local' }],
    [{ kind: 'endpoint', id: 'gone' }, { region: undefined, endpoint: undefined, label: undefined }],
    [{ kind: 'profile', profile: 'dev' }, { region: 'eu-west-1', label: 'dev' }],
    [{ kind: 'profile', profile: 'dev', region: 'ap-south-1' }, { region: 'ap-south-1', label: 'dev' }],
    [{ kind: 'profile', profile: 'nor' }, { region: 'us-east-1', label: 'nor' }],
    [{ kind: 'profile', profile: 'missing' }, { region: 'us-east-1', label: 'missing' }],
    [{ kind: 'default', region: 'sa-east-1' }, { region: 'sa-east-1', label: 'Default chain' }],
    [{ kind: 'default' }, { region: 'us-east-1', label: 'Default chain' }],
  ])('%j', (conn, expected) => {
    expect(connInfo(conn, profiles, endpoints)).toEqual(expected);
  });
});

describe('hash routing', () => {
  it('reads and follows location.hash', () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current).toBe('/');
    act(() => {
      navigate('/table/My Table');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.location.hash).toBe('#/table/My%20Table');
    expect(result.current).toBe('/table/My Table');
  });
});
