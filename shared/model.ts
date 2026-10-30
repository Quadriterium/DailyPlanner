import { z } from 'zod';

export const seasons = ['spring', 'summer', 'autumn', 'winter', 'all'] as const;
export const seasonLabels: Record<Season, string> = {
  spring: 'Printemps', summer: 'Été', autumn: 'Automne', winter: 'Hiver', all: 'Toute l’année',
};
export const seasonSchema = z.enum(seasons);
export type Season = z.infer<typeof seasonSchema>;
const version = {
  modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: z.string().uuid(),
};
export const detailsSchema = z.object({
  name: z.string().trim().min(1).max(240),
  seasons: z.array(seasonSchema).min(1).max(5),
  ingredients: z.array(z.string().trim().min(1).max(120)).max(30),
  recipe: z.string().max(4000),
}).strict();
export type DishDetails = z.infer<typeof detailsSchema>;
export const dishSchema = z.object({
  type: z.literal('dish'),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(240),
  creationSeason: seasonSchema,
  analysisKey: z.string().uuid(),
  details: detailsSchema.nullable(),
  archived: z.boolean(),
  ...version,
}).strict();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  'Date invalide',
);
export const mealSchema = z.object({
  type: z.literal('meal'),
  id: z.string(),
  date: dateSchema,
  slot: z.enum(['lunch', 'dinner']),
  text: z.string().max(240),
  dishId: z.string().uuid().nullable(),
  ...version,
}).strict();
export const settingsSchema = z.object({
  type: z.literal('settings'),
  id: z.literal('global'),
  model: z.string().trim().min(1).max(100),
  ...version,
}).strict();
export const recordSchema = z.discriminatedUnion('type', [dishSchema, mealSchema, settingsSchema])
  .superRefine((record, context) => {
    if (record.type === 'meal' && (
      record.id !== `${record.date}:${record.slot}` || (!record.text.trim() && record.dishId !== null)
    )) context.addIssue({ code: 'custom', message: 'Créneau invalide' });
  });
export type Dish = z.infer<typeof dishSchema>;
export type Meal = z.infer<typeof mealSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type RecordData = z.infer<typeof recordSchema>;
export type Slot = Meal['slot'];
export const analysisSchema = z.object({
  dishId: z.string().uuid(),
  analysisKey: z.string().uuid(),
  status: z.enum(['pending', 'processing', 'ready', 'error']),
  details: detailsSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.number(),
});
export type Analysis = z.infer<typeof analysisSchema>;
export const capabilitiesSchema = z.object({
  aiConfigured: z.boolean(),
  allowedModels: z.array(z.string()),
  dailyLimit: z.number(),
  monthlyLimit: z.number(),
  callsToday: z.number(),
  callsThisMonth: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const syncRequestSchema = z.object({ mutations: z.array(recordSchema).max(100) }).strict();
export const syncResponseSchema = z.object({
  records: z.array(recordSchema),
  analyses: z.array(analysisSchema),
  serverTime: z.number(),
  capabilities: capabilitiesSchema,
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export function recordKey(record: Pick<RecordData, 'type' | 'id'>): string {
  return `${record.type}:${record.id}`;
}

export function compareVersions(a: Pick<RecordData, 'modifiedAt' | 'mutationId'>, b: Pick<RecordData, 'modifiedAt' | 'mutationId'>): number {
  return a.modifiedAt - b.modifiedAt || (a.mutationId > b.mutationId ? 1 : a.mutationId < b.mutationId ? -1 : 0);
}

export function dishDetails(dish: Dish, analysis?: Analysis): DishDetails {
  if (dish.details) return dish.details;
  if (analysis?.analysisKey === dish.analysisKey && analysis.status === 'ready' && analysis.details) return analysis.details;
  return { name: dish.name, seasons: [dish.creationSeason], ingredients: [], recipe: '' };
}

export function parisDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function seasonForDate(date: string): Season {
  const month = Number(date.slice(5, 7));
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

export function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: 'Europe/Paris' })
    .format(new Date(`${date}T12:00:00Z`));
}
