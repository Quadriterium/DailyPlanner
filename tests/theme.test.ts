import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { defaultThemePreference, parseThemePreference, resolveTheme, themeColors, themeStorageKey, type Theme, type ThemePreference } from '../src/theme';

const at = (time: string) => new Date(`2026-10-31T${time}:00`);
const schedule = (darkFrom: string, lightFrom: string): ThemePreference => ({ mode: 'schedule', darkFrom, lightFrom });
const bootScript = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

/** Exécute public/theme.js comme le navigateur avant le premier affichage. */
function boot(stored: string | null | Error, now: Date, systemDark: boolean) {
  const keys: string[] = [];
  const meta: Record<string, string> = {};
  const root = { dataset: {} as Record<string, string> };
  runInNewContext(bootScript, {
    localStorage: {
      getItem(key: string) { keys.push(key); if (stored instanceof Error) throw stored; return stored; },
    },
    matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark }),
    Date: function FakeDate() { return now; },
    document: {
      documentElement: root,
      querySelector: (selector: string) => selector === 'meta[name="theme-color"]'
        ? { setAttribute: (name: string, value: string) => { meta[name] = value; } } : null,
    },
  });
  return { theme: root.dataset.theme, color: meta.content, keys };
}

describe('Thème clair ou sombre', () => {
  it('ignore les préférences illisibles ou invalides', () => {
    expect(parseThemePreference(null)).toEqual(defaultThemePreference);
    expect(parseThemePreference('dark')).toEqual(defaultThemePreference);
    expect(parseThemePreference({ mode: 'night', darkFrom: '24:00', lightFrom: 7 })).toEqual(defaultThemePreference);
    expect(parseThemePreference({ mode: 'schedule', darkFrom: '21:30', lightFrom: '6:00' }))
      .toEqual({ mode: 'schedule', darkFrom: '21:30', lightFrom: '07:00' });
  });

  it('applique un choix fixe ou le réglage du système', () => {
    expect(resolveTheme({ ...defaultThemePreference, mode: 'dark' }, at('12:00'), false)).toBe('dark');
    expect(resolveTheme(defaultThemePreference, at('23:00'), true)).toBe('light');
    expect(resolveTheme({ ...defaultThemePreference, mode: 'system' }, at('12:00'), true)).toBe('dark');
    expect(resolveTheme({ ...defaultThemePreference, mode: 'system' }, at('23:00'), false)).toBe('light');
  });

  it('suit l’heure de l’appareil, y compris quand la plage sombre passe minuit', () => {
    const night = schedule('20:00', '07:00');
    expect(['19:59', '20:00', '23:59', '00:00', '06:59', '07:00'].map(time => resolveTheme(night, at(time), false)))
      .toEqual(['light', 'dark', 'dark', 'dark', 'dark', 'light']);
    const afternoon = schedule('13:00', '15:30');
    expect(['12:59', '13:00', '15:29', '15:30'].map(time => resolveTheme(afternoon, at(time), true)))
      .toEqual(['light', 'dark', 'dark', 'light']);
    expect(resolveTheme(schedule('20:00', '20:00'), at('21:00'), true)).toBe('light');
  });

  it('choisit le même thème dès le chargement, avant React', () => {
    const stored = [
      null, 'pas du json', 'null', '"dark"', '[]',
      JSON.stringify({ mode: 'dark' }), JSON.stringify({ mode: 'light' }), JSON.stringify({ mode: 'system' }),
      JSON.stringify({ mode: 'schedule', darkFrom: '24:00', lightFrom: 7 }),
      ...[['20:00', '07:00'], ['13:00', '15:30'], ['08:15', '08:15'], ['00:00', '23:59']]
        .map(([darkFrom, lightFrom]) => JSON.stringify({ mode: 'schedule', darkFrom, lightFrom })),
    ];
    for (const raw of stored) {
      for (const time of ['00:00', '06:59', '07:00', '08:15', '13:00', '15:29', '15:30', '19:59', '20:00', '23:59']) {
        for (const systemDark of [false, true]) {
          let expected: Theme = 'light';
          try { expected = resolveTheme(parseThemePreference(JSON.parse(raw ?? 'null')), at(time), systemDark); } catch { /* même repli que le script */ }
          expect({ raw, time, systemDark, ...boot(raw, at(time), systemDark) })
            .toEqual({ raw, time, systemDark, theme: expected, color: themeColors[expected], keys: [themeStorageKey] });
        }
      }
    }
    expect(boot(new Error('Stockage bloqué'), at('23:00'), true)).toMatchObject({ theme: 'light', color: themeColors.light });
  });
});
