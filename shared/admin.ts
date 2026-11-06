import { z } from 'zod';
import { capabilitiesSchema, detailsSchema, featureRequestSchema, featureRequestStatuses, recipeUrlSchema, sessionUserSchema } from './model.js';

export const adminLifetime = 30 * 60_000;
const count = z.number().int().nonnegative();
export const aiLimitSchema = count.max(1_000_000).nullable();
export const spaceAiPolicySchema = z.object({ dailyLimit: aiLimitSchema, monthlyLimit: aiLimitSchema }).strict();
export const globalAiPolicySchema = spaceAiPolicySchema.extend({ hourlyLimit: aiLimitSchema, paused: z.boolean() }).strict();
export type SpaceAiPolicy = z.infer<typeof spaceAiPolicySchema>;
export type GlobalAiPolicy = z.infer<typeof globalAiPolicySchema>;
export const adminSessionSchema = z.object({
  authEnabled: z.boolean(), user: sessionUserSchema.nullable(), allowed: z.boolean(),
  expiresAt: z.number().nullable(), csrfToken: z.string().nullable(),
}).strict();
export type AdminSession = z.infer<typeof adminSessionSchema>;
export const adminOverviewSchema = z.object({
  users: count, spaces: count, activeSessions: count, catalog: count, requests: count,
  analyses: z.object({ pending: count, processing: count, error: count }),
  usage: capabilitiesSchema, policy: globalAiPolicySchema,
  serverTime: z.number(), uptime: z.number(), schemaVersion: count,
}).strict();
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
const userSchema = z.object({
  id: z.string().uuid(), name: z.string(), email: z.string().nullable(), emailVerified: z.boolean(),
  createdAt: z.number(), lastLoginAt: z.number(), spaceId: z.string().nullable(), spaceName: z.string().nullable(),
});
export const adminUsersSchema = z.object({ users: z.array(userSchema), more: z.boolean() }).strict();
export const adminSpacesSchema = z.object({
  spaces: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.string(), members: count, records: count, createdAt: z.number(),
    policy: spaceAiPolicySchema, usage: capabilitiesSchema,
  })), more: z.boolean(),
}).strict();
export const adminAiSchema = z.object({
  policy: globalAiPolicySchema, usage: capabilitiesSchema, hourlyCalls: count,
  configured: z.boolean(), allowedModels: z.array(z.string()),
}).strict();
export const adminCatalogSchema = z.object({
  entries: z.array(z.object({
    id: z.string().uuid(), details: detailsSchema, sourceUrl: recipeUrlSchema.optional(),
    deleted: z.boolean(), seq: count, createdAt: z.number(),
  })), more: z.boolean(),
}).strict();
export type AdminCatalogEntry = z.infer<typeof adminCatalogSchema>['entries'][number];
export const adminRequestsSchema = z.object({
  requests: z.array(z.object({ request: featureRequestSchema, spaceId: z.string(), spaceName: z.string().nullable() })),
  more: z.boolean(),
}).strict();
export const adminAuditSchema = z.object({
  entries: z.array(z.object({
    id: count, userId: z.string(), action: z.string(), target: z.string(), details: z.string(), createdAt: z.number(),
  })), more: z.boolean(),
}).strict();
export const adminPageSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  search: z.string().trim().max(200).default(''),
}).strict();
export const adminConfirmSchema = z.object({ confirm: z.literal(true) }).strict();
export const adminGlobalPolicyRequestSchema = globalAiPolicySchema.extend({ confirm: z.literal(true) }).strict();
export const adminSpacePolicyRequestSchema = spaceAiPolicySchema.extend({ confirm: z.literal(true) }).strict();
export const adminCatalogCorrectionSchema = z.object({
  details: detailsSchema, sourceUrl: recipeUrlSchema.nullable(),
  expectedSeq: count, confirm: z.literal(true),
}).strict();
export const adminCatalogRemovalSchema = z.object({
  removed: z.boolean(), expectedSeq: count, confirm: z.literal(true),
}).strict();
export const legalFieldMax = {
  firstName: 80, lastName: 80, companyName: 160, registration: 160, street: 240, postalCode: 20, city: 120, country: 80,
  phone: 40, email: 254, publicationDirector: 160, hostName: 160, hostAddress: 400, hostPhone: 40, hostingLocation: 240, logRetention: 240,
} as const;
const legalField = (key: keyof typeof legalFieldMax) => z.string().trim().max(legalFieldMax[key]);
export const legalInfoSchema = z.object({
  firstName: legalField('firstName'), lastName: legalField('lastName'),
  companyName: legalField('companyName'), registration: legalField('registration'),
  street: legalField('street'), postalCode: legalField('postalCode'), city: legalField('city'), country: legalField('country'),
  phone: legalField('phone'), email: z.union([z.literal(''), z.string().trim().email().max(legalFieldMax.email)]),
  publicationDirector: legalField('publicationDirector'),
  hostName: legalField('hostName'), hostAddress: legalField('hostAddress'), hostPhone: legalField('hostPhone'),
  hostingLocation: legalField('hostingLocation'), logRetention: legalField('logRetention'),
}).strict();
export type LegalInfo = z.infer<typeof legalInfoSchema>;
export const legalFieldLabels: Record<keyof LegalInfo, string> = {
  firstName: 'Prénom', lastName: 'Nom', companyName: 'Raison sociale (si société ou association)',
  registration: 'SIRET / RCS (si professionnel)', street: 'Adresse (numéro et voie)', postalCode: 'Code postal',
  city: 'Ville', country: 'Pays', phone: 'Téléphone', email: 'E-mail de contact',
  publicationDirector: 'Directeur de la publication', hostName: 'Hébergeur (nom ou raison sociale)',
  hostAddress: 'Adresse de l’hébergeur', hostPhone: 'Téléphone de l’hébergeur',
  hostingLocation: 'Lieu d’hébergement du serveur', logRetention: 'Durée de conservation des journaux techniques',
};
export const defaultLegalInfo: LegalInfo = {
  firstName: '', lastName: '', companyName: '', registration: '', street: '', postalCode: '', city: '', country: 'France',
  phone: '', email: 'olivier-berthelot@hotmail.fr', publicationDirector: '',
  hostName: '', hostAddress: '', hostPhone: '', hostingLocation: '', logRetention: '',
};
export const adminLegalSchema = z.object({ info: legalInfoSchema, updatedAt: count }).strict();
export const adminLegalRequestSchema = z.object({
  info: legalInfoSchema, expectedUpdatedAt: count, confirm: z.literal(true),
}).strict();
export const adminRequestUpdateSchema = z.object({
  status: z.enum(featureRequestStatuses), note: z.string().trim().max(1000).nullable(),
  expectedUpdatedAt: z.number().int().nonnegative(), confirm: z.literal(true),
}).strict();
