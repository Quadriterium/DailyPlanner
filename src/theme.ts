import { useEffect, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemeMode = Theme | 'schedule' | 'system';
export interface ThemePreference { mode: ThemeMode; darkFrom: string; lightFrom: string }
export type ThemeControl = ReturnType<typeof useTheme>;

// public/theme.js applique le même calcul avant le premier affichage : garder clé, couleurs et règles identiques.
export const themeStorageKey = 'a-table-theme';
export const themeColors: Record<Theme, string> = { light: '#f8f5ee', dark: '#1c1814' };
export const defaultThemePreference: ThemePreference = { mode: 'light', darkFrom: '20:00', lightFrom: '07:00' };
export const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const darkQuery = '(prefers-color-scheme: dark)';

export function parseThemePreference(value: unknown): ThemePreference {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const time = (candidate: unknown, fallback: string) =>
    typeof candidate === 'string' && timePattern.test(candidate) ? candidate : fallback;
  return {
    mode: input.mode === 'dark' || input.mode === 'schedule' || input.mode === 'system' ? input.mode : 'light',
    darkFrom: time(input.darkFrom, defaultThemePreference.darkFrom),
    lightFrom: time(input.lightFrom, defaultThemePreference.lightFrom),
  };
}

function minutes(time: string) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }

/** Le mode horaire suit l'heure locale de l'appareil ; la plage sombre peut passer minuit. */
export function resolveTheme(preference: ThemePreference, now: Date, systemDark: boolean): Theme {
  if (preference.mode === 'system') return systemDark ? 'dark' : 'light';
  if (preference.mode !== 'schedule') return preference.mode;
  const current = now.getHours() * 60 + now.getMinutes();
  const dark = minutes(preference.darkFrom);
  const light = minutes(preference.lightFrom);
  if (dark === light) return 'light';
  return (dark < light ? current >= dark && current < light : current >= dark || current < light) ? 'dark' : 'light';
}

function readThemePreference() {
  try { return parseThemePreference(JSON.parse(localStorage.getItem(themeStorageKey) ?? 'null')); }
  catch { return defaultThemePreference; }
}

function systemPrefersDark() { return typeof matchMedia === 'function' && matchMedia(darkQuery).matches; }

function currentTheme(preference: ThemePreference) { return resolveTheme(preference, new Date(), systemPrefersDark()); }

export function useTheme() {
  const [preference, setPreference] = useState(readThemePreference);
  const [theme, setTheme] = useState(() => currentTheme(preference));

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
  }, [theme]);

  useEffect(() => {
    const update = () => setTheme(currentTheme(preference));
    update();
    const media = typeof matchMedia === 'function' ? matchMedia(darkQuery) : null;
    let timer: number | undefined;
    // Réévaluer au début de chaque minute pour basculer à l'heure choisie.
    const tick = () => { update(); timer = window.setTimeout(tick, 60_000 - Date.now() % 60_000 + 50); };
    if (preference.mode === 'schedule') tick();
    media?.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      media?.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [preference]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) setPreference(readThemePreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /** Applique immédiatement le choix ; lève une erreur s'il ne peut pas être mémorisé sur l'appareil. */
  function changePreference(next: ThemePreference) {
    setPreference(next);
    setTheme(currentTheme(next));
    localStorage.setItem(themeStorageKey, JSON.stringify(next));
  }

  return { preference, theme, changePreference };
}
