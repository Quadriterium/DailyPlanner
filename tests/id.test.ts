import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newId } from '../src/id';

afterEach(() => vi.unstubAllGlobals());

describe('Identifiants client sur HTTPS et HTTP local', () => {
  it('utilise randomUUID lorsqu’il est disponible', () => {
    const expected = crypto.randomUUID();
    const randomUUID = vi.fn(() => expected);
    vi.stubGlobal('crypto', { randomUUID });
    expect(newId()).toBe(expected);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('génère des UUID v4 uniques sans randomUUID sur une origine HTTP', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const identifiers = Array.from({ length: 100 }, () => newId());
    expect(new Set(identifiers).size).toBe(100);
    for (const id of identifiers) {
      expect(z.uuidv4().safeParse(id).success).toBe(true);
    }
  });

  it('positionne correctement les bits de version et de variante', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) });
    expect(newId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
