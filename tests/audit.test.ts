import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit, describeMutations, logFailedRequest } from '../server/audit';

const user = { id: '00000000-0000-4000-8000-000000000001', name: 'Alice', email: 'alice@example.com', picture: null };
const version = { modifiedAt: 1, mutationId: '00000000-0000-4000-8000-000000000002' };
const fakeRequest = (signedIn = true, url = '/api/sync') => ({
  auth: { user: signedIn ? user : null, space: { id: 's', name: 'Maison', kind: 'household' }, sessionExpiresAt: null },
  headers: {}, ip: '192.168.1.10', socket: { remoteAddress: '192.168.1.10' }, method: 'POST', url, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}) as unknown as FastifyRequest & { log: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> };

describe('journal des actions', () => {
  it('attribue l’action à l’adresse e-mail du compte', () => {
    const request = fakeRequest();
    audit(request, 'auth.logout', 'déconnexion');
    expect(request.log.info).toHaveBeenCalledWith(
      { action: 'auth.logout', user: 'alice@example.com', space: 'Maison', ip: '192.168.1.10' },
      'alice@example.com : déconnexion',
    );
    const anonymous = fakeRequest(false);
    audit(anonymous, 'sync', 'x');
    expect(anonymous.log.info.mock.calls[0][1]).toBe('anonyme : x');
  });

  it('utilise CF-Connecting-IP uniquement depuis le proxy local de confiance', () => {
    const request = fakeRequest();
    request.headers['cf-connecting-ip'] = '203.0.113.7';
    request.socket.remoteAddress = '127.0.0.1';
    audit(request, 'sync', 'x', {}, 'cloudflare');
    expect(request.log.info.mock.calls[0][0]).toMatchObject({ ip: '203.0.113.7' });

    const untrusted = fakeRequest();
    untrusted.headers['cf-connecting-ip'] = '203.0.113.7';
    untrusted.socket.remoteAddress = '192.168.1.20';
    audit(untrusted, 'sync', 'x', {}, 'cloudflare');
    expect(untrusted.log.info.mock.calls[0][0]).toMatchObject({ ip: '192.168.1.20' });
  });

  it('résume les modifications synchronisées', () => {
    expect(describeMutations([
      { type: 'meal', id: '2026-11-03:dinner', date: '2026-11-03', slot: 'dinner', text: 'Gratin', dishId: null, ...version },
      { type: 'meal', id: '2026-11-04:lunch:2', date: '2026-11-04', slot: 'lunch', index: 1, text: '', dishId: null, ...version },
    ] as never)).toBe('repas 2026-11-03 soir = « Gratin » ; repas 2026-11-04 midi (2e plat) vidé');
  });

  it('ne journalise que les requêtes d’API en échec', () => {
    const request = fakeRequest(true, '/api/auth/google/callback?code=secret');
    logFailedRequest(request, { statusCode: 200, elapsedTime: 1 } as FastifyReply);
    expect(request.log.warn).not.toHaveBeenCalled();
    request.headers['cf-connecting-ip'] = '203.0.113.7';
    request.socket.remoteAddress = '::1';
    logFailedRequest(request, { statusCode: 403, elapsedTime: 1 } as FastifyReply, 'cloudflare');
    expect(request.log.warn.mock.calls[0][0]).toMatchObject({ user: 'alice@example.com', statusCode: 403, url: '/api/auth/google/callback' });
    logFailedRequest(request, { statusCode: 502, elapsedTime: 1 } as FastifyReply);
    expect(request.log.error).toHaveBeenCalledOnce();
  });
});
