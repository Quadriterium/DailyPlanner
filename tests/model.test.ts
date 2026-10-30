import { describe, expect, it } from 'vitest';
import { addDays, compareVersions, dishDetails, parisDate, recordSchema, seasonForDate } from '../shared/model';
import { dish, details, meal } from './fixtures';

describe('Dates et saisons françaises', () => {
  it('utilise le jour français même autour de minuit et des changements d’heure', () => {
    expect(parisDate(new Date('2026-06-01T22:30:00Z'))).toBe('2026-06-02');
    expect(parisDate(new Date('2026-12-01T23:30:00Z'))).toBe('2026-12-02');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
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
  it('rejette une date impossible ou un identifiant incohérent', () => {
    expect(recordSchema.safeParse(meal({ date: '2026-02-30', id: '2026-02-30:lunch' })).success).toBe(false);
    expect(recordSchema.safeParse(meal({ slot: 'dinner' })).success).toBe(false);
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
