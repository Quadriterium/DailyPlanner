import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default('./data/planner.sqlite'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
  OPENAI_ALLOWED_MODELS: z.string().default('gpt-6-luna,gpt-5.6-luna'),
  AI_DAILY_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
  AI_MONTHLY_LIMIT: z.coerce.number().int().min(1).max(10000).default(200),
  PUBLIC_ORIGIN: z.string().url().optional(),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const allowedModels = [...new Set(parsed.OPENAI_ALLOWED_MODELS.split(',').map(model => model.trim()).filter(Boolean))];
  if (!allowedModels.includes(parsed.OPENAI_MODEL)) throw new Error('OPENAI_MODEL doit appartenir à OPENAI_ALLOWED_MODELS.');
  if (parsed.PUBLIC_ORIGIN && new URL(parsed.PUBLIC_ORIGIN).origin !== parsed.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN doit être une origine sans chemin ni slash final.');
  }
  return { ...parsed, allowedModels };
}
export type Config = ReturnType<typeof readConfig>;
