// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useCoordinates } from './useCoordinates';

describe('useCoordinates', () => {
  it('keeps the old value and tells the caller why when coordinates are refused', () => {
    const { result } = renderHook(() => useCoordinates({ lat: 10, lng: 20 }));

    act(() => result.current.setCoordinates({ lat: 95, lng: 0 }));

    expect(result.current.coordinates).toEqual({ lat: 10, lng: 20 });
    expect(result.current.error).toMatchObject({ code: 'geo.invalid_coordinates' });
  });

  it('clears the error once a valid change is accepted', () => {
    const { result } = renderHook(() => useCoordinates());

    act(() => result.current.setCoordinates({ lat: 95, lng: 0 }));
    expect(result.current.error).not.toBeNull();

    act(() => result.current.setCoordinates({ lat: 1, lng: 2 }));

    expect(result.current.error).toBeNull();
    expect(result.current.coordinates).toEqual({ lat: 1, lng: 2 });
  });

  it('refuses a latitude update that is out of range instead of dropping it silently', () => {
    const { result } = renderHook(() => useCoordinates({ lat: 10, lng: 20 }));

    act(() => result.current.updateLatitude(Number.NaN));

    expect(result.current.coordinates).toEqual({ lat: 10, lng: 20 });
    expect(result.current.error).not.toBeNull();
  });
});
