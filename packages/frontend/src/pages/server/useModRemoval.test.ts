import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { modsApi } from '../../lib/endpoints';
import type { ModView } from '../../lib/types';
import { dependentsFrom, useModRemoval } from './useModRemoval';

vi.mock('../../lib/endpoints', () => ({ modsApi: { remove: vi.fn() } }));

const mod = { id: 'm1', name: 'Fabric API', fileName: 'fabric-api.jar' } as ModView;
const required = new ApiError(409, 'MOD_REQUIRED_BY_OTHERS', '\"Fabric API\" is required by other mods: Sodium.', { dependents: [{ id: 'm2', name: 'Sodium' }] });
const removeMock = vi.mocked(modsApi.remove);

describe('dependentsFrom', () => {
  it('reads the dependents of MOD_REQUIRED_BY_OTHERS and nothing else', () => {
    expect(dependentsFrom(required)).toEqual([{ id: 'm2', name: 'Sodium' }]);
    expect(dependentsFrom(new ApiError(409, 'SERVER_RUNNING', 'running', { dependents: [{ id: 'x', name: 'y' }] }))).toEqual([]);
    expect(dependentsFrom(new ApiError(409, 'MOD_REQUIRED_BY_OTHERS', 'x', { dependents: 'kaputt' }))).toEqual([]);
    expect(dependentsFrom(new Error('x'))).toEqual([]);
  });
});

describe('MOD_REQUIRED_BY_OTHERS flow', () => {
  beforeEach(() => removeMock.mockReset());

  it('lists the dependents first and removes with force only after a second confirmation', async () => {
    removeMock.mockRejectedValueOnce(required);
    removeMock.mockResolvedValueOnce({ removed: { ...mod }, orphaned: [{ id: 'm3', name: 'Cloth Config' }] } as never);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useModRemoval('srv', onChanged));

    act(() => result.current.open(mod));
    expect(result.current.phase).toBe('confirm');

    await act(() => result.current.confirm());
    expect(removeMock).toHaveBeenNthCalledWith(1, 'srv', 'm1', false);
    expect(result.current.phase).toBe('dependents');
    expect(result.current.dependents).toEqual([{ id: 'm2', name: 'Sodium' }]);
    expect(result.current.target).toBe(mod);
    expect(result.current.error).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();

    await act(() => result.current.confirm());
    expect(removeMock).toHaveBeenNthCalledWith(2, 'srv', 'm1', true);
    expect(result.current.target).toBeNull();
    expect(result.current.result?.orphaned.map((entry) => entry.name)).toEqual(['Cloth Config']);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('removes directly when nothing depends on the mod', async () => {
    removeMock.mockResolvedValueOnce({ removed: { ...mod }, orphaned: [] } as never);
    const { result } = renderHook(() => useModRemoval('srv', vi.fn()));
    act(() => result.current.open(mod));
    await act(() => result.current.confirm());
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith('srv', 'm1', false);
    expect(result.current.result?.orphaned).toEqual([]);
  });

  it('keeps other errors, such as SERVER_RUNNING, visible in the dialog', async () => {
    removeMock.mockRejectedValueOnce(new ApiError(409, 'SERVER_RUNNING', 'The server is running.'));
    const { result } = renderHook(() => useModRemoval('srv', vi.fn()));
    act(() => result.current.open(mod));
    await act(() => result.current.confirm());
    expect(result.current.phase).toBe('confirm');
    expect(result.current.error).toMatchObject({ code: 'SERVER_RUNNING', message: 'The server is running.' });
    expect(result.current.target).toBe(mod);
  });

  it('does not loop when force still fails with the same code', async () => {
    removeMock.mockRejectedValueOnce(required);
    removeMock.mockRejectedValueOnce(required);
    const { result } = renderHook(() => useModRemoval('srv', vi.fn()));
    act(() => result.current.open(mod));
    await act(() => result.current.confirm());
    await act(() => result.current.confirm());
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect((result.current.error as ApiError).code).toBe('MOD_REQUIRED_BY_OTHERS');
  });

  it('resets when another mod is opened', async () => {
    removeMock.mockRejectedValueOnce(required);
    const { result } = renderHook(() => useModRemoval('srv', vi.fn()));
    act(() => result.current.open(mod));
    await act(() => result.current.confirm());
    act(() => result.current.open({ ...mod, id: 'm9' }));
    expect(result.current.phase).toBe('confirm');
    expect(result.current.dependents).toEqual([]);
  });
});
