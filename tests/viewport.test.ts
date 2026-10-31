import { describe, expect, it } from 'vitest';
import { fieldFontSize } from '../src/viewport';

describe('fieldFontSize', () => {
  it('garde 16 px quand la page n’est pas réduite', () => {
    expect(fieldFontSize(800, 800, true)).toBe(16);
    expect(fieldFontSize(412, 412, true)).toBe(16);
  });
  it('compense la réduction du mode ordinateur sur écran tactile', () => {
    expect(fieldFontSize(700, 980, true)).toBe(23);
  });
  it('ne change rien sans pointeur tactile', () => {
    expect(fieldFontSize(700, 980, false)).toBe(16);
  });
});
