import { z } from 'zod';

export const seasons = ['spring', 'summer', 'autumn', 'winter', 'all'] as const;
export const seasonLabels: Record<Season, string> = {
  spring: 'Printemps', summer: 'Été', autumn: 'Automne', winter: 'Hiver', all: 'Toute l’année',
};
export const seasonSchema = z.enum(seasons);
export type Season = z.infer<typeof seasonSchema>;
export const defaultHousehold = { adults: 2, teenagers: 2, children: 2 };
export const householdSchema = z.object({
  adults: z.number().int().min(0).max(20),
  teenagers: z.number().int().min(0).max(20),
  children: z.number().int().min(0).max(20),
}).strict().refine(household => household.adults + household.teenagers + household.children > 0, {
  message: 'Le foyer doit contenir au moins une personne.',
});
export type Household = z.infer<typeof householdSchema>;
export const householdCategories = [
  ['adults', 'Adultes'], ['teenagers', 'Adolescents'], ['children', 'Enfants'],
] as const;
export function householdSummary(household: Household): string {
  return householdCategories.filter(([key]) => household[key] > 0)
    .map(([key, label]) => `${household[key]} ${label.toLocaleLowerCase('fr-FR').replace(/s$/, household[key] === 1 ? '' : 's')}`)
    .join(' · ');
}
export const recipeUrlSchema = z.string().trim().max(2048).url().refine(value => {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Utilisez un lien HTTP ou HTTPS sans identifiants.');
export function recipeUrl(value: string): string | undefined {
  const result = recipeUrlSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
const mealInputSchema = z.union([z.string().max(240), recipeUrlSchema]);
const version = {
  modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: z.string().uuid(),
};
export const cookingLevels = [1, 2, 3, 4] as const;
export const cookingLevelSchema = z.literal(cookingLevels);
export type CookingLevel = z.infer<typeof cookingLevelSchema>;
export const defaultCookingLevel: CookingLevel = 2;
export const cookingLevelLabels: Record<CookingLevel, string> = {
  1: 'Tablier tout neuf', 2: 'Popote du quotidien', 3: 'Toque affûtée', 4: 'Haute voltige étoilée',
};
export const cookingLevelHints: Record<CookingLevel, string> = {
  1: 'Express et sans technique : peu d’ingrédients, une cuisson simple.',
  2: 'Les classiques familiaux faciles : quelques étapes, gestes de base.',
  3: 'Plusieurs préparations à mener de front et un vrai coup de main.',
  4: 'Techniques fines, temps long et dressage soigné : le grand jeu.',
};
export const detailsSchema = z.object({
  name: z.string().trim().min(1).max(240),
  seasons: z.array(seasonSchema).min(1).max(5),
  ingredients: z.array(z.string().trim().min(1).max(120)).max(30),
  recipe: z.string().max(4000),
  level: cookingLevelSchema.optional(),
}).strict();
export type DishDetails = z.infer<typeof detailsSchema>;
export const dishSchema = z.object({
  type: z.literal('dish'),
  id: z.string().uuid(),
  name: z.string().trim().min(1).pipe(mealInputSchema),
  creationSeason: seasonSchema,
  sourceUrl: recipeUrlSchema.optional(),
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
  index: z.literal(1).optional(),
  text: mealInputSchema,
  dishId: z.string().uuid().nullable(),
  household: householdSchema.nullable().optional(),
  ...version,
}).strict();
export const settingsSchema = z.object({
  type: z.literal('settings'),
  id: z.literal('global'),
  model: z.string().trim().min(1).max(100),
  household: householdSchema.default(defaultHousehold),
  avoid: z.string().max(1000).default(''),
  cookingLevel: cookingLevelSchema.default(defaultCookingLevel),
  ...version,
}).strict();
export const recordSchema = z.discriminatedUnion('type', [dishSchema, mealSchema, settingsSchema])
  .superRefine((record, context) => {
    if (record.type === 'meal' && (
      record.id !== mealId(record.date, record.slot, record.index) || (!record.text.trim() && (record.dishId !== null || record.household != null))
    )) context.addIssue({ code: 'custom', message: 'Créneau invalide' });
  });
export type Dish = z.infer<typeof dishSchema>;
export type Meal = z.infer<typeof mealSchema>;
export function mealId(date: string, slot: Slot, index?: 1): string {
  return `${date}:${slot}${index === 1 ? ':2' : ''}`;
}
export function mealHousehold(meal: Meal | undefined, household: Household = defaultHousehold): Household {
  return meal?.household ?? household;
}
export const generateMealRequestSchema = z.object({ date: dateSchema, level: cookingLevelSchema.optional() }).strict();
export const generateMealResponseSchema = z.object({ details: detailsSchema }).strict();
export type Settings = z.infer<typeof settingsSchema>;
export type RecordData = z.infer<typeof recordSchema>;
export type Slot = Meal['slot'];
export const analysisSchema = z.object({
  dishId: z.string().uuid(),
  analysisKey: z.string().uuid(),
  status: z.enum(['pending', 'processing', 'ready', 'error']),
  details: detailsSchema.nullable(),
  error: z.string().nullable(),
  name: detailsSchema.shape.name.optional(),
  updatedAt: z.number(),
});
export type Analysis = z.infer<typeof analysisSchema>;
export const capabilitiesSchema = z.object({
  aiConfigured: z.boolean(),
  allowedModels: z.array(z.string()),
  callsToday: z.number(),
  callsThisMonth: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  dailyLimit: z.number().int().positive().nullable().default(20),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const syncRequestSchema = z.object({
  mutations: z.array(recordSchema).max(100),
  resetId: z.string().uuid().nullable().optional(),
}).strict();
export const syncResponseSchema = z.object({
  // Changed by the server to force every client to discard its local copy.
  resetId: z.string().uuid().nullable(),
  records: z.array(recordSchema),
  analyses: z.array(analysisSchema),
  serverTime: z.number(),
  capabilities: capabilitiesSchema,
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const featureRequestStatuses = ['received', 'planned', 'added', 'declined'] as const;
export const featureRequestStatusLabels: Record<FeatureRequestStatus, string> = {
  received: 'Reçue', planned: 'Prévue', added: 'Ajoutée', declined: 'Non retenue',
};
export const featureRequestSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(1000),
  status: z.enum(featureRequestStatuses),
  note: z.string().max(1000).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type FeatureRequest = z.infer<typeof featureRequestSchema>;
export type FeatureRequestStatus = typeof featureRequestStatuses[number];
export const createFeatureRequestSchema = z.object({ text: z.string().trim().min(3).max(1000) }).strict();
export const featureRequestListSchema = z.object({ requests: z.array(featureRequestSchema) }).strict();

/** Modèle OpenAI par défaut du serveur, aussi utilisé pour les réglages créés hors ligne en mode invité. */
export const defaultOpenAiModel = 'gpt-6-luna';
/** Identifiant fixe de l'espace commun utilisé quand l'authentification est désactivée. */
export const commonSpaceId = 'common';
export const authProviders = ['google'] as const;
export type AuthProvider = typeof authProviders[number];
export const authErrorCodes = ['auth_required', 'membership_revoked', 'confirmation_required', 'invitation_invalid'] as const;
export type AuthErrorCode = typeof authErrorCodes[number];
export const authCallbackReasons = ['cancelled', 'expired', 'invalid', 'invitation_invalid'] as const;
export type AuthCallbackReason = typeof authCallbackReasons[number];
export const spaceKinds = ['common', 'household'] as const;
export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
}).strict();
export type SessionUser = z.infer<typeof sessionUserSchema>;
export const sessionSpaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(spaceKinds),
}).strict();
export type SessionSpace = z.infer<typeof sessionSpaceSchema>;
export const authSessionSchema = z.object({
  authEnabled: z.boolean(),
  providers: z.array(z.enum(authProviders)),
  user: sessionUserSchema.nullable(),
  space: sessionSpaceSchema.nullable(),
  defaultModel: z.string(),
  sessionExpiresAt: z.number().nullable(),
}).strict();
export type AuthSession = z.infer<typeof authSessionSchema>;
/** Jeton aléatoire de 32 octets encodé en base64url (session, transaction OAuth, invitation). */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const authStartRequestSchema = z.object({ invitation: tokenSchema.optional() }).strict();
export const authStartResponseSchema = z.object({ url: z.string().url() }).strict();
export const spaceNameSchema = z.string().trim().min(1).max(60);
export const renameSpaceRequestSchema = z.object({ name: spaceNameSchema }).strict();
export const spaceMemberSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
  joinedAt: z.number(),
  isMe: z.boolean(),
}).strict();
export type SpaceMember = z.infer<typeof spaceMemberSchema>;
export const spaceInvitationSchema = z.object({
  id: z.string().uuid(),
  createdBy: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
}).strict();
export type SpaceInvitation = z.infer<typeof spaceInvitationSchema>;
export const spaceDetailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(spaceMemberSchema),
  invitations: z.array(spaceInvitationSchema),
}).strict();
export type SpaceDetails = z.infer<typeof spaceDetailsSchema>;
export const createdInvitationSchema = z.object({ id: z.string().uuid(), url: z.string().url(), expiresAt: z.number() }).strict();
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;
export const revokeInvitationRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const removeMemberRequestSchema = z.object({ userId: z.string().uuid() }).strict();
export const invitationPreviewRequestSchema = z.object({ token: tokenSchema }).strict();
export const invitationPreviewSchema = z.object({ spaceName: z.string(), invitedBy: z.string(), expiresAt: z.number() }).strict();
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
export const acceptInvitationRequestSchema = z.object({ token: tokenSchema, leaveCurrent: z.boolean() }).strict();
export const apiErrorSchema = z.object({ error: z.string(), code: z.string().optional() });

/** Records removed by a server-forced reset: planned meals and library dishes, never settings. */
export function isResetScoped(record: Pick<RecordData, 'type'>): boolean {
  return record.type === 'meal' || record.type === 'dish';
}

export function recordKey(record: Pick<RecordData, 'type' | 'id'>): string {
  return `${record.type}:${record.id}`;
}

export function compareVersions(a: Pick<RecordData, 'modifiedAt' | 'mutationId'>, b: Pick<RecordData, 'modifiedAt' | 'mutationId'>): number {
  return a.modifiedAt - b.modifiedAt || (a.mutationId > b.mutationId ? 1 : a.mutationId < b.mutationId ? -1 : 0);
}

export function dishDetails(dish: Dish, analysis?: Analysis): DishDetails {
  if (dish.details) return dish.details;
  if (analysis?.analysisKey === dish.analysisKey && analysis.status === 'ready' && analysis.details) return analysis.details;
  return {
    name: analysis?.analysisKey === dish.analysisKey && analysis.name ? analysis.name : dish.name,
    seasons: [dish.creationSeason], ingredients: [], recipe: '',
  };
}

export function mealDisplayName(meal: Meal, dish?: Dish, analysis?: Analysis): string {
  return recipeUrl(meal.text) && dish && meal.dishId === dish.id &&
    meal.text.trim() === (dish.sourceUrl ?? dish.name).trim()
    ? dishDetails(dish, analysis).name : meal.text;
}

export function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR');
}

export function seasonalDishes(dishes: Dish[], analyses: Analysis[], date: string): Dish[] {
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const season = seasonForDate(date);
  return dishes.filter(dish => {
    const details = dishDetails(dish, analysisMap.get(dish.id));
    return !dish.archived && (details.seasons.includes(season) || details.seasons.includes('all'));
  });
}

export function randomMealCandidates(
  dishes: Dish[], analyses: Analysis[], meals: Meal[], date: string, start: string, level?: CookingLevel,
): Dish[] {
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const candidates = seasonalDishes(dishes, analyses, date)
    .filter(dish => level === undefined || dishDetails(dish, analysisMap.get(dish.id)).level === level);
  const week = meals.filter(meal => meal.date >= start && meal.date <= addDays(start, 6) && meal.text.trim());
  const ids = new Set(week.map(meal => meal.dishId));
  const names = new Set(week.map(meal => normalizedName(meal.text)));
  const unused = candidates.filter(dish => !ids.has(dish.id) && !names.has(normalizedName(dish.name)) &&
    !names.has(normalizedName(dishDetails(dish, analysisMap.get(dish.id)).name)));
  return unused.length ? unused : candidates;
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

/** Jour de la semaine ISO d'une date civile : 1 = lundi … 7 = dimanche. */
export function isoWeekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
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
