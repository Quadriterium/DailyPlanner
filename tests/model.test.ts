import { describe, expect, it } from 'vitest';
import { addDays, compareVersions, defaultHousehold, dishDetails, isoWeekday, mealDisplayName, parisDate, randomMealCandidates, recipeUrl, recordSchema, seasonForDate } from '../shared/model';
import { dish, details, meal } from './fixtures';

describe('Dates et saisons françaises', () => {
  it('utilise le jour français même autour de minuit et des changements d’heure', () => {
    expect(parisDate(new Date('2026-06-01T22:30:00Z'))).toBe('2026-06-02');
    expect(parisDate(new Date('2026-12-01T23:30:00Z'))).toBe('2026-12-02');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('numérote les jours de la semaine du lundi (1) au dimanche (7)', () => {
    expect(isoWeekday('2026-10-26')).toBe(1);
    expect(isoWeekday('2026-10-31')).toBe(6);
    expect(isoWeekday('2026-11-01')).toBe(7);
    expect(isoWeekday('2026-03-29')).toBe(7);
  });
  it('emploie les quatre saisons météorologiques larges', () => {
    expect(seasonForDate('2026-02-28')).toBe('winter');
    expect(seasonForDate('2026-03-01')).toBe('spring');
    expect(seasonForDate('2026-06-01')).toBe('summer');
    expect(seasonForDate('2026-09-01')).toBe('autumn');
    expect(seasonForDate('2026-12-01')).toBe('winter');
  });
});
describe('Contrats et versions', () => {
  it('accepte les liens longs, sans augmenter la limite des noms et des recettes enrichies', () => {
    const url = `https://example.org/recipe?tracking=${'a'.repeat(500)}`;
    expect(recordSchema.parse(dish({ name: url, sourceUrl: url })).name).toBe(url);
    expect(recordSchema.parse(meal({ text: url })).type).toBe('meal');
    expect(recordSchema.safeParse(meal({ text: 'a'.repeat(241) })).success).toBe(false);
    expect(recordSchema.safeParse(dish({ name: 'a'.repeat(241) })).success).toBe(false);
    expect(recordSchema.safeParse(dish({ details: { ...details, name: url } })).success).toBe(false);
    expect(recipeUrl('ftp://example.org/recipe')).toBeUndefined();
    expect(recipeUrl('https://example.org/' + 'a'.repeat(2048))).toBeUndefined();
  });
  it('affiche le nom découvert pour un lien seulement, sans réécrire les textes ni utiliser une analyse obsolète', () => {
    const url = 'https://example.org/recipe';
    const recipe = dish({ name: url, sourceUrl: url });
    const planned = meal({ text: url, dishId: recipe.id });
    const analysis = { dishId: recipe.id, analysisKey: recipe.analysisKey, details: null,
      name: 'Gratin de courge', status: 'processing' as const, error: null, updatedAt: 1 };
    expect(mealDisplayName(planned, recipe, analysis)).toBe('Gratin de courge');
    expect(planned.text).toBe(url);
    expect(mealDisplayName(planned, { ...recipe, analysisKey: crypto.randomUUID() }, analysis)).toBe(url);
    expect(mealDisplayName({ ...planned, text: 'Mon gratin' }, recipe, analysis)).toBe('Mon gratin');
    expect(mealDisplayName(planned, { ...recipe, details: { ...details, name: 'Ma version' } }, analysis)).toBe('Ma version');
    expect(mealDisplayName(planned, undefined, analysis)).toBe(url);
  });
  it('rejette une date impossible ou un identifiant incohérent', () => {
    expect(recordSchema.safeParse(meal({ date: '2026-02-30', id: '2026-02-30:lunch' })).success).toBe(false);
    expect(recordSchema.safeParse(meal({ slot: 'dinner' })).success).toBe(false);
  });
  it('utilise le foyer par défaut et refuse un foyer vide', () => {
    const settings = { type: 'settings' as const, id: 'global' as const, model: 'gpt-6-luna', modifiedAt: 0, mutationId: crypto.randomUUID() };
    expect(recordSchema.parse(settings)).toMatchObject({ household: defaultHousehold });
    expect(recordSchema.safeParse({ ...settings, household: { adults: 0, teenagers: 0, children: 0 } }).success).toBe(false);
  });

  describe('Tirage de saison sur les sept jours affichés', () => {
    it('ignore archives et autres saisons et accepte toute l’année', () => {
      const autumn = dish();
      const all = dish({ details });
      expect(randomMealCandidates([autumn, all, dish({ creationSeason: 'summer' }), dish({ archived: true })],
        [], [], '2026-10-30', '2026-10-30')).toEqual([autumn, all]);
    });
    it('évite les identifiants et noms déjà prévus, y compris au-delà du dimanche', () => {
      const used = dish();
      const sameName = dish({ name: '  SOUPE   maison ' });
      const unused = dish({ name: 'Gratin' });
      const meals = [
        meal({ date: '2026-11-02', dishId: used.id }),
        meal({ date: '2026-11-05', text: 'Soupe maison' }),
        meal({ date: '2026-11-06', dishId: unused.id, text: unused.name }),
      ];
      expect(randomMealCandidates([used, sameName, unused], [], meals, '2026-11-01', '2026-10-30')).toEqual([unused]);
    });
    it('utilise les noms et saisons analysés et se replie sur les répétitions si nécessaire', () => {
      const recipe = dish({ name: 'nom brut', creationSeason: 'summer' });
      const analysis = { dishId: recipe.id, analysisKey: recipe.analysisKey, details, status: 'ready' as const, error: null, updatedAt: 1 };
      const other = dish({ name: 'Gratin' });
      const used = meal({ text: details.name });
      expect(randomMealCandidates([recipe, other], [analysis], [used], '2026-10-30', '2026-10-30')).toEqual([other]);
      expect(randomMealCandidates([recipe], [analysis], [used], '2026-10-30', '2026-10-30')).toEqual([recipe]);
      expect(randomMealCandidates([], [], [], '2026-10-30', '2026-10-30')).toEqual([]);
    });
  });
  it('départage les dates identiques de manière déterministe', () => {
    const a = meal({ modifiedAt: 1, mutationId: '00000000-0000-4000-8000-000000000001' });
    const b = { ...a, mutationId: '00000000-0000-4000-8000-000000000002' };
    expect(compareVersions(a, b)).toBe(-1);
    expect(compareVersions(b, a)).toBe(1);
  });
  it('garde la saison de création en attendant une analyse et privilégie la correction manuelle', () => {
    const record = dish();
    expect(dishDetails(record).seasons).toEqual(['autumn']);
    const analysis = { dishId: record.id, analysisKey: record.analysisKey, details, status: 'ready' as const, error: null, updatedAt: 1 };
    expect(dishDetails(record, analysis)).toEqual(details);
    expect(dishDetails({ ...record, analysisKey: crypto.randomUUID() }, analysis).name).toBe(record.name);
    expect(dishDetails({ ...record, details: { ...details, name: 'Ma version' } }, analysis).name).toBe('Ma version');
  });
});
