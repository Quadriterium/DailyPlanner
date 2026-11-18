import { z } from 'zod';

export const reminderTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const pushSlots = ['lunch', 'dinner'] as const;
export const defaultReminders = { lunch: null, dinner: '17:00' } as const;

/** Content shown by the service worker; `url` is a same-origin path opened on click. */
export const pushPayloadSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(240),
  url: z.string().regex(/^\/(?!\/)/).max(200).default('/'),
  tag: z.string().max(80).optional(),
}).strict();
export type PushPayload = z.input<typeof pushPayloadSchema>;

const base64Url = (min: number, max: number) => z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).min(min).max(max);
/** `PushSubscription.toJSON()`; unknown members such as expirationTime are ignored. */
export const browserSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).startsWith('https://'),
  keys: z.object({ p256dh: base64Url(80, 100), auth: base64Url(16, 32) }),
});
export type BrowserSubscription = z.infer<typeof browserSubscriptionSchema>;

export const pushRegisterSchema = z.object({
  subscription: browserSubscriptionSchema,
  lunch: reminderTimeSchema.nullable(),
  dinner: reminderTimeSchema.nullable(),
}).strict();
export const pushEndpointSchema = z.object({ endpoint: z.string().url().max(2048) }).strict();
export const pushRenewSchema = z.object({ oldEndpoint: z.string().url().max(2048), subscription: browserSubscriptionSchema }).strict();

export const pushInfoSchema = z.object({ configured: z.boolean(), publicKey: z.string().nullable() }).strict();
export const pushStatusSchema = z.object({
  registered: z.boolean(),
  lunch: reminderTimeSchema.nullable(),
  dinner: reminderTimeSchema.nullable(),
  admin: z.boolean(),
}).strict();
export type PushStatus = z.infer<typeof pushStatusSchema>;
export const pushTestSchema = z.object({ devices: z.number().int().nonnegative() }).strict();
