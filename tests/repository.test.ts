import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../src/repository';
import { mealDisplayName } from '../shared/model';
import { dish, meal, snapshot } from './fixtures';

let repo: Repository;
beforeEach(() => { repo = createRepository(crypto.randomUUID()); });
afterEach(async () => { await repo.close(); });

describe('Sauvegarde locale et synchronisation', () => {
  it('conserve le lien et le nom provisoire hors ligne sans laisser une ancienne analyse écraser une correction', async () => {
    const url = `https://example.org/recipe?tracking=${'a'.repeat(500)}`;
    await repo.save([dish({ name: url, sourceUrl: url })]);
    const [recipe] = await repo.pending();
    if (recipe.type !== 'dish') throw new Error('Fiche attendue');
    const planned = meal({ text: url, dishId: recipe.id });
    const analysis = { dishId: recipe.id, analysisKey: recipe.analysisKey, status: 'processing' as const,
      name: 'Gratin de courge', details: null, error: null, updatedAt: Date.now() };
    await repo.merge({ ...snapshot([recipe, planned]), analyses: [analysis] });
    const state = await repo.snapshot();
    expect(state.records).toContainEqual(recipe);
    expect(mealDisplayName(planned, recipe, state.analyses[0])).toBe(analysis.name);
    const corrected = { ...recipe, name: 'Ma correction', analysisKey: crypto.randomUUID() };
    await repo.save([corrected]);
    await repo.merge({ ...snapshot([recipe, planned]), analyses: [{ ...analysis, updatedAt: Date.now() + 1 }] });
    const current = (await repo.snapshot()).records.find(record => record.type === 'dish');
    expect(current).toMatchObject({ id: recipe.id, name: corrected.name, sourceUrl: url, analysisKey: corrected.analysisKey });
    expect(current?.modifiedAt).toBeGreaterThan(recipe.modifiedAt);
    expect(current?.mutationId).not.toBe(recipe.mutationId);
    expect(current?.type === 'dish' && mealDisplayName(planned, current, analysis)).toBe(corrected.name);
  });
  it('sauvegarde le repas et sa fiche atomiquement avant toute connexion', async () => {
    const recipe = dish();
    await repo.save([recipe, meal({ dishId: recipe.id })]);
    const state = await repo.snapshot();
    expect(state.records).toHaveLength(2);
    expect(state.pending).toBe(2);
    expect(state.lastSync).toBeNull();
  });
  it('ne valide pas une modification créée pendant un aller-retour serveur', async () => {
    await repo.save([meal({ text: 'Premier choix' })]);
    const sent = await repo.pending();
    await repo.save([meal({ text: 'Nouveau choix hors ligne' })]);
    await repo.merge(snapshot(sent));
    const state = await repo.snapshot();
    expect(state.pending).toBe(1);
    const record = state.records[0];
    expect(record.type === 'meal' && record.text).toBe('Nouveau choix hors ligne');
  });
  it('prend le dernier changement distant et acquitte le changement local perdant', async () => {
    await repo.save([meal()]);
    const pending = await repo.pending();
    const remote = meal({ text: 'Choix de la tablette', modifiedAt: pending[0].modifiedAt + 1 });
    await repo.merge(snapshot([remote]));
    expect((await repo.snapshot()).records).toEqual([remote]);
    expect((await repo.snapshot()).pending).toBe(0);
  });
  it('ne ressuscite pas une suppression locale lors d’une réponse obsolète', async () => {
    await repo.save([meal()]);
    const original = await repo.pending();
    await repo.save([meal({ text: '', dishId: null })]);
    await repo.merge(snapshot(original));
    const state = await repo.snapshot();
    expect(state.records[0].type === 'meal' && state.records[0].text).toBe('');
    expect(state.pending).toBe(1);
  });
  it('conserve les données et la file lors de la réouverture hors ligne', async () => {
    const name = crypto.randomUUID();
    const first = createRepository(name);
    await first.save([meal()]);
    await first.close();
    const reopened = createRepository(name);
    expect((await reopened.snapshot()).pending).toBe(1);
    expect((await reopened.snapshot()).records).toHaveLength(1);
    await reopened.close();
  });
  it('ne persiste aucune partie d’un lot invalide', async () => {
    await expect(repo.save([dish(), meal({ text: 'a'.repeat(241) })])).rejects.toThrow();
    expect((await repo.snapshot()).records).toEqual([]);
  });
  it('efface seulement les repas et fiches locaux, y compris non envoyés, et conserve les paramètres', async () => {
    const kept = meal({ id: '2026-10-31:lunch', date: '2026-10-31', text: 'Ancien' });
    const settings = { type: 'settings' as const, id: 'global' as const, model: 'gpt-6-luna', household: { adults: 1, teenagers: 0, children: 1 }, avoid: '' };
    await repo.merge(snapshot([kept]));
    await repo.save([dish(), meal({ text: 'Non envoyé' }), settings]);
    const resetId = crypto.randomUUID();
    const remote = meal({ id: '2026-11-01:lunch', date: '2026-11-01', text: 'Nouveau départ' });
    await repo.merge({ ...snapshot([remote]), resetId });
    expect(await repo.resetId()).toBe(resetId);
    const after = await repo.snapshot();
    expect(after.records.filter(record => record.type !== 'settings')).toEqual([remote]);
    expect(after.records.find(record => record.type === 'settings')).toMatchObject(settings);
    expect(await repo.pending()).toEqual([expect.objectContaining(settings)]);
    await repo.save([meal({ text: 'Après réinitialisation' })]);
    await repo.merge({ ...snapshot([]), resetId });
    expect((await repo.pending()).map(record => record.type).sort()).toEqual(['meal', 'settings']);
  });
  it('sérialise les écritures de plusieurs onglets et conserve une version monotone', async () => {
    const name = crypto.randomUUID();
    const a = createRepository(name);
    const b = createRepository(name);
    await Promise.all([a.save([meal({ text: 'A' })]), b.save([meal({ text: 'B' })])]);
    expect((await a.pending())).toHaveLength(1);
    expect(await a.snapshot()).toEqual(await b.snapshot());
    await a.close();
    await b.close();
  });
});
