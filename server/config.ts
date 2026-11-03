import { z } from 'zod';
import { defaultOpenAiModel } from '../shared/model.js';

const booleanFlag = (name: string) => z.string().trim().toLowerCase().default('false')
  .refine(value => value === 'true' || value === 'false', `${name} doit valoir true ou false.`)
  .transform(value => value === 'true');

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default('./data/planner.sqlite'),
  CLIENT_UPDATE_ID: z.string().trim().max(200).default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(defaultOpenAiModel),
  OPENAI_ALLOWED_MODELS: z.string().default('gpt-6-luna,gpt-6-sol,gpt-5.6-luna,gpt-5.6-terra'),
  PUBLIC_ORIGIN: z.string().url().optional(),
  AUTH_ENABLED: booleanFlag('AUTH_ENABLED'),
  ADMIN_USER_IDS: z.string().trim().default(''),
  GOOGLE_CLIENT_ID: z.string().trim().default(''),
  GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
  AUTH_SESSION_DAYS: z.string().trim().default('30')
    .refine(value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 365, 'AUTH_SESSION_DAYS doit être un entier de 1 à 365.')
    .transform(Number),
  TRUSTED_PROXY: z.enum(['none', 'cloudflare'], { error: 'TRUSTED_PROXY doit valoir none ou cloudflare.' }).default('none'),
  // Fournisseur simulé réservé aux tests automatisés (NODE_ENV=test et base :memory:).
  AUTH_TEST_PROVIDER: booleanFlag('AUTH_TEST_PROVIDER'),
  NODE_ENV: z.string().default(''),
});

function isLoopback(host: string) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.replace(/^\[|\]$/g, '').toLowerCase()) || /^127\./.test(host);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new Error(`Configuration invalide : ${result.error.issues.map(issue => issue.message).join(' ')}`);
  const parsed = result.data;
  const allowedModels = [...new Set(parsed.OPENAI_ALLOWED_MODELS.split(',').map(model => model.trim()).filter(Boolean))];
  if (!allowedModels.includes(parsed.OPENAI_MODEL)) throw new Error('OPENAI_MODEL doit appartenir à OPENAI_ALLOWED_MODELS.');
  if (parsed.PUBLIC_ORIGIN && new URL(parsed.PUBLIC_ORIGIN).origin !== parsed.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN doit être une origine sans chemin ni slash final.');
  }
  if (parsed.TRUSTED_PROXY === 'cloudflare' && !isLoopback(parsed.HOST)) {
    throw new Error('TRUSTED_PROXY=cloudflare exige HOST=127.0.0.1 : seul cloudflared, sur ce PC, doit joindre le serveur.');
  }
  if (parsed.AUTH_TEST_PROVIDER && !(parsed.NODE_ENV === 'test' && parsed.DATABASE_PATH === ':memory:')) {
    throw new Error('AUTH_TEST_PROVIDER est réservé aux tests (NODE_ENV=test et DATABASE_PATH=:memory:). Retirez-le de la configuration.');
  }
  const authEnabled = parsed.AUTH_ENABLED;
  const adminUserIds = [...new Set(parsed.ADMIN_USER_IDS.split(',').map(id => id.trim()).filter(Boolean))];
  if (adminUserIds.some(id => !z.string().uuid().safeParse(id).success)) {
    throw new Error('ADMIN_USER_IDS doit contenir des identifiants de comptes complets (UUID), séparés par des virgules.');
  }
  if (adminUserIds.length && !authEnabled) throw new Error('ADMIN_USER_IDS exige AUTH_ENABLED=true. L’administration ne peut pas être publique.');
  if (authEnabled) {
    if (!parsed.PUBLIC_ORIGIN) throw new Error('AUTH_ENABLED=true exige PUBLIC_ORIGIN (adresse exacte utilisée dans le navigateur).');
    if (!parsed.AUTH_TEST_PROVIDER && (!parsed.GOOGLE_CLIENT_ID || !parsed.GOOGLE_CLIENT_SECRET)) {
      throw new Error('AUTH_ENABLED=true exige GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env. Le serveur ne démarre pas sans authentification.');
    }
    const origin = new URL(parsed.PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) {
      throw new Error('Avec AUTH_ENABLED=true, PUBLIC_ORIGIN doit être en https:, ou http://localhost:<port> / http://127.0.0.1:<port> (règle Google).');
    }
  }
  const secureCookies = parsed.PUBLIC_ORIGIN?.startsWith('https:') ?? false;
  return {
    ...parsed,
    allowedModels,
    adminUserIds,
    authEnabled,
    secureCookies,
    redirectUri: parsed.PUBLIC_ORIGIN ? `${parsed.PUBLIC_ORIGIN}/api/auth/google/callback` : '',
  };
}
export type Config = ReturnType<typeof readConfig>;
