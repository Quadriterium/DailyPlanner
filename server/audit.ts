import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { recordSchema } from '../shared/model.js';

type SyncRecord = z.infer<typeof recordSchema>;

/** OAuth callbacks carry `code` and `state` in their query: never log it. */
export const loggedUrl = (url: string) => /^\/api\/(auth|test-auth)\//.test(url) ? url.split('?')[0] : url;

const slotLabels = { lunch: 'midi', dinner: 'soir' } as const;
const maxDescribed = 20;
const clip = (text: string, length = 80) => text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** Who did it: the account email when signed in, otherwise "anonyme". */
export function actor(request: Pick<FastifyRequest, 'auth' | 'ip'>) {
  const user = request.auth?.user;
  return { user: user ? user.email ?? user.id : 'anonyme', ...(request.auth?.space ? { space: request.auth.space.name } : {}), ip: request.ip };
}

/** One line per user action, readable in the server console: never tokens, cookies nor invitation contents. */
export function audit(request: FastifyRequest, action: string, message: string, details: Record<string, unknown> & { user?: string } = {}) {
  const who = { ...actor(request), ...details };
  request.log.info({ action, ...who }, `${who.user} : ${message}`);
}

export function describeMutation(record: SyncRecord): string {
  if (record.type === 'meal') {
    const slot = `${record.date} ${slotLabels[record.slot]}${record.index ? ' (2e plat)' : ''}`;
    return record.text.trim() ? `repas ${slot} = « ${clip(record.text)} »` : `repas ${slot} vidé`;
  }
  if (record.type === 'dish') {
    const state = record.archived ? 'archivée' : record.details ? 'corrigée' : 'enregistrée';
    return `fiche « ${clip(record.name)} » ${state}`;
  }
  return `paramètres (niveau ${record.cookingLevel}, modèle ${record.model})`;
}

export function describeMutations(records: SyncRecord[]): string {
  const described = records.slice(0, maxDescribed).map(describeMutation);
  if (records.length > maxDescribed) described.push(`… et ${records.length - maxDescribed} autre(s)`);
  return described.join(' ; ');
}

/** Successful requests are not logged anymore; failed API calls still are, with their author. */
export function logFailedRequest(request: FastifyRequest, reply: FastifyReply) {
  if (reply.statusCode < 400 || !request.url.startsWith('/api/')) return;
  const entry = { ...actor(request), method: request.method, url: loggedUrl(request.url), statusCode: reply.statusCode, responseTime: Math.round(reply.elapsedTime) };
  if (reply.statusCode >= 500) request.log.error(entry, 'requête en échec');
  else request.log.warn(entry, 'requête refusée');
}
