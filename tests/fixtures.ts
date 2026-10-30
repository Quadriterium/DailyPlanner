import { randomUUID } from 'node:crypto';
import type { Capabilities, Dish, DishDetails, Meal, RecordData, SyncResponse } from '../shared/model';

export function dish(overrides: Partial<Dish> = {}): Dish {
  return {
    type: 'dish', id: randomUUID(), name: 'poulet frite',
    creationSeason: 'autumn', archived: false, details: null, analysisKey: randomUUID(),
    modifiedAt: Date.now(), mutationId: randomUUID(), ...overrides,
  };
}
export function meal(overrides: Partial<Meal> = {}): Meal {
  return {
    type: 'meal', id: '2026-10-30:lunch', date: '2026-10-30', slot: 'lunch',
    text: 'poulet frite', dishId: null, modifiedAt: Date.now(), mutationId: randomUUID(), ...overrides,
  };
}
export const details: DishDetails = {
  name: 'Poulet-frites', seasons: ['all'], ingredients: ['Poulet', 'Pommes de terre'],
  recipe: '1. Préparez les ingrédients.\n2. Faites cuire complètement le poulet et les pommes de terre.',
};
export const capabilities: Capabilities = {
  aiConfigured: false, allowedModels: ['gpt-6-luna', 'gpt-5.6-luna'],
  dailyLimit: 20, monthlyLimit: 200, callsToday: 0, callsThisMonth: 0, inputTokens: 0, outputTokens: 0,
};
export function snapshot(records: RecordData[] = []): SyncResponse {
  return { records, analyses: [], serverTime: Date.now(), capabilities };
}
