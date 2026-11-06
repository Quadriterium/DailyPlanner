import { describe, expect, it } from 'vitest';
import { addDays, compareVersions, cookingLevelLabels, cookingLevels, defaultCookingLevel, defaultHousehold, dishDetails, householdSummary, isoWeekday, mealDisplayName, mealHousehold, mealId, parisDate, randomMealCandidates, recipeUrl, recordSchema, seasonForDate } from '../shared/model';
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
  it('accepte plus de trente ingrédients et quantités structurées sans retirer la validation de chaque ligne', () => {
    const ingredients = Array.from({ length: 60 }, (_, index) => `100 g de légume ${index}`);
    const items = ingredients.map((_, index) => ({ name: `Légume ${index}`, quantity: 100, unit: 'g' }));
    const recipe = dish({ details: { ...details, ingredients, items } });
    expect(recordSchema.parse(recipe)).toEqual(recipe);
    expect(recordSchema.safeParse(dish({ details: { ...details, ingredients: ['a'.repeat(121)] } })).success).toBe(false);
  });
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
  it('donne un niveau de cuisine intermédiaire aux anciens paramètres et n’accepte que quatre niveaux', () => {
    const settings = { type: 'settings' as const, id: 'global' as const, model: 'gpt-6-luna', modifiedAt: 0, mutationId: crypto.randomUUID() };
    expect(recordSchema.parse(settings)).toMatchObject({ cookingLevel: defaultCookingLevel });
    expect(defaultCookingLevel).toBe(2);
    expect(cookingLevels.map(level => cookingLevelLabels[level])).toEqual([
      'Tablier tout neuf', 'Popote du quotidien', 'Toque affûtée', 'Haute voltige étoilée',
    ]);
    for (const level of cookingLevels) expect(recordSchema.parse({ ...settings, cookingLevel: level })).toMatchObject({ cookingLevel: level });
    for (const level of [0, 5, 2.5, '3']) {
      expect(recordSchema.safeParse({ ...settings, cookingLevel: level }).success).toBe(false);
      expect(recordSchema.safeParse(dish({ details: { ...details, level } as typeof details })).success).toBe(false);
    }
    const { level: _level, ...legacy } = details;
    expect(recordSchema.safeParse(dish({ details: legacy })).success).toBe(true);
  });
  it('utilise les paramètres à jour sauf si les convives du repas sont personnalisés', () => {
    const household = { adults: 1, teenagers: 0, children: 3 };
    const custom = { adults: 2, teenagers: 0, children: 0 };
    expect(mealHousehold(meal(), household)).toEqual(household);
    expect(mealHousehold(meal({ household: null }), household)).toEqual(household);
    expect(mealHousehold(meal({ household: custom }), household)).toEqual(custom);
    expect(mealHousehold(undefined)).toEqual(defaultHousehold);
    expect(householdSummary(household)).toBe('1 adulte · 3 enfants');
    expect(householdSummary(custom)).toBe('2 adultes');
    expect(householdSummary({ adults: 0, teenagers: 1, children: 1 })).toBe('1 adolescent · 1 enfant');
  });
  it('valide les convives sans imposer une migration des anciens repas', () => {
    expect(recordSchema.safeParse(meal()).success).toBe(true);
    expect(recordSchema.safeParse(meal({ household: null })).success).toBe(true);
    expect(recordSchema.safeParse(meal({ household: { adults: 20, teenagers: 0, children: 1 } })).success).toBe(true);
    for (const adults of [-1, 21, 1.5, NaN]) {
      expect(recordSchema.safeParse(meal({ household: { adults, teenagers: 0, children: 0 } })).success).toBe(false);
    }
    expect(recordSchema.safeParse(meal({ household: { adults: 0, teenagers: 0, children: 0 } })).success).toBe(false);
    expect(recordSchema.safeParse(meal({ text: '', household: { adults: 2, teenagers: 0, children: 0 } })).success).toBe(false);
  });
  it('autorise deux plats indépendants par créneau et conserve les identifiants historiques', () => {
    expect(mealId('2026-10-30', 'lunch')).toBe('2026-10-30:lunch');
    expect(mealId('2026-10-30', 'lunch', 1)).toBe('2026-10-30:lunch:2');
    expect(recordSchema.safeParse(meal({ id: '2026-10-30:lunch:2', index: 1 })).success).toBe(true);
    expect(recordSchema.safeParse(meal({ index: 1 })).success).toBe(false);
    expect(recordSchema.safeParse(meal({ id: '2026-10-30:lunch:2' })).success).toBe(false);
    expect(recordSchema.safeParse({ ...meal(), id: '2026-10-30:lunch:3', index: 2 }).success).toBe(false);
  });

  describe('Tirage de saison sur les sept jours affichés', () => {
    it('ignore archives et autres saisons et accepte toute l’année', () => {
      const autumn = dish();
      const all = dish({ details });
      expect(randomMealCandidates([autumn, all, dish({ creationSeason: 'summer' }), dish({ archived: true })],
        [], [], '2026-10-30', '2026-10-30')).toEqual([autumn, all]);
    });
    it('exclut un plat supprimé uniquement à la date concernée', () => {
      const excluded = dish({
        name: 'Plat supprimé', details: { ...details, name: 'Plat supprimé' }, excludedGenerationDates: ['2026-10-30'],
      });
      expect(randomMealCandidates([excluded], [], [], '2026-10-30', '2026-10-30')).toEqual([]);
      expect(randomMealCandidates([excluded], [], [], '2026-10-31', '2026-10-31')).toEqual([excluded]);
    });
    it('exclut durablement un plat et ses doublons de nom, puis permet de le réautoriser sans perdre les dates exclues', () => {
      const excluded = dish({
        name: 'nom brut', details: { ...details, name: 'Soupe maison' },
        excludedFromGeneration: true, excludedGenerationDates: ['2026-10-30'],
      });
      const duplicate = dish({ name: ' SOUPE   maison ' });
      expect(randomMealCandidates([excluded, duplicate], [], [], '2026-10-31', '2026-10-31')).toEqual([]);
      const restored = { ...excluded, excludedFromGeneration: false };
      expect(recordSchema.parse(restored)).toEqual(restored);
      expect(randomMealCandidates([restored], [], [], '2026-10-30', '2026-10-30')).toEqual([]);
      expect(randomMealCandidates([restored], [], [], '2026-10-31', '2026-10-31')).toEqual([restored]);
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
    it('ne pioche que parmi les plats du niveau demandé, sans plat non évalué', () => {
      const easy = dish({ details: { ...details, name: 'Omelette', level: 1 } });
      const usual = dish({ details: { ...details, name: 'Gratin', level: 2 } });
      const unrated = dish({ name: 'Soupe' });
      const analyzed = dish({ name: 'nom brut' });
      const analysis = {
        dishId: analyzed.id, analysisKey: analyzed.analysisKey, details: { ...details, name: 'Pot-au-feu', level: 3 as const },
        status: 'ready' as const, error: null, updatedAt: 1,
      };
      const all = [easy, usual, unrated, analyzed];
      expect(randomMealCandidates(all, [analysis], [], '2026-10-30', '2026-10-30', 1)).toEqual([easy]);
      expect(randomMealCandidates(all, [analysis], [], '2026-10-30', '2026-10-30', 3)).toEqual([analyzed]);
      expect(randomMealCandidates(all, [analysis], [], '2026-10-30', '2026-10-30', 4)).toEqual([]);
      expect(randomMealCandidates(all, [analysis], [meal({ text: 'Omelette' })], '2026-10-30', '2026-10-30', 1)).toEqual([easy]);
      expect(randomMealCandidates(all, [analysis], [], '2026-10-30', '2026-10-30')).toEqual(all);
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
