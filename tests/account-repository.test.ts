import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { accountDatabase, createRepository, guestDatabase, importInto, initialSettings, type Repository } from '../src/repository';
import { dish, meal, snapshot } from './fixtures';

const opened: Repository[] = [];
function open(name = crypto.randomUUID()) {
  const repo = createRepository(name);
  opened.push(repo);
  return repo;
}
afterEach(async () => { await Promise.all(opened.splice(0).map(repo => repo.close())); });

describe('Bases locales par compte et import des données invité', () => {
  it('isole les bases invité, compte et foyer', async () => {
    expect(new Set([guestDatabase, accountDatabase('u1', 's1'), accountDatabase('u1', 's2'), accountDatabase('u2', 's1')]).size).toBe(4);
    const first = open(accountDatabase('u1', 's1'));
    const second = open(accountDatabase('u1', 's2'));
    await first.save([meal()]);
    expect((await second.snapshot()).records).toEqual([]);
  });

  it('importe plus de 100 enregistrements dans l’outbox en conservant leurs versions, et peut être relancé sans doublon', async () => {
    const target = open();
    await target.merge({ ...snapshot(), resetId: 'reset-1' });
    const records = Array.from({ length: 150 }, (_, index) => dish({ name: `Plat ${index}`, modifiedAt: 1_000 + index }));
    expect(await importInto(target, records)).toBe(150);
    // A second run (interrupted import resumed) is idempotent.
    await importInto(target, records);
    const state = await target.snapshot();
    expect(state.records).toHaveLength(150);
    expect(state.pending).toBe(150);
    expect(await target.pending()).toHaveLength(100);
    expect(state.records).toContainEqual(records[42]);
    expect(await target.resetId()).toBe('reset-1');
    // A server response with the same resetId keeps the imported, unsent records.
    await target.merge({ ...snapshot(), resetId: 'reset-1' });
    expect((await target.snapshot()).pending).toBe(150);
  });

  it('rattache les repas invités à une fiche existante de même nom au lieu de la dupliquer', async () => {
    const target = open();
    const existing = dish({ name: 'Gratin de courge' });
    await target.merge(snapshot([existing]));
    const guestDish = dish({ name: '  gratin de COURGE ' });
    const planned = meal({ dishId: guestDish.id, text: guestDish.name, modifiedAt: 5_000 });
    const other = dish({ name: 'Soupe' });
    expect(await importInto(target, [guestDish, planned, other, initialSettings('gpt-6-luna')])).toBe(2);
    const state = await target.snapshot();
    expect(state.records.filter(record => record.type === 'dish').map(record => record.id).sort()).toEqual([existing.id, other.id].sort());
    const imported = state.records.find(record => record.type === 'meal');
    expect(imported).toMatchObject({ dishId: existing.id, modifiedAt: 5_000 });
    expect(imported?.mutationId).not.toBe(planned.mutationId);
    expect(state.records.some(record => record.type === 'settings')).toBe(false);
  });

  it('laisse gagner une version plus récente déjà présente dans le foyer', async () => {
    const target = open();
    const recent = meal({ text: 'Version du foyer', modifiedAt: 9_000 });
    await target.merge(snapshot([recent]));
    await importInto(target, [meal({ text: 'Version invité', modifiedAt: 1_000 })]);
    const state = await target.snapshot();
    expect(state.records).toEqual([recent]);
    expect(state.pending).toBe(0);
  });

  it('vide la base invité après import en gardant la trace de la destination', async () => {
    const guest = open();
    await guest.save([meal(), dish()]);
    expect(await guest.userRecords()).toHaveLength(2);
    await guest.markImportedAndClear(accountDatabase('u1', 's1'));
    const state = await guest.snapshot();
    expect(state.records).toEqual([]);
    expect(state.pending).toBe(0);
  });

  it('ne compte pas les réglages initiaux comme des données saisies', async () => {
    const guest = open();
    await guest.ensureSettings('gpt-6-luna');
    await guest.ensureSettings('gpt-6-sol');
    expect(await guest.userRecords()).toEqual([]);
    expect((await guest.snapshot()).records).toEqual([expect.objectContaining({ type: 'settings', model: 'gpt-6-luna', modifiedAt: 0 })]);
  });
});
