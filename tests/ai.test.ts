import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { AiWorker, analyzeDish } from '../server/ai';
import { dish, details } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only', AI_DAILY_LIMIT: '1' });
let store: Store;
beforeEach(() => { store = new Store(config); });
afterEach(() => store.close());
function success() {
  return new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(details) }] }],
    usage: { input_tokens: 300, output_tokens: 200 },
  }));
}
describe('Analyse IA asynchrone', () => {
  it('envoie seulement le nom du repas, sans planning, avec un schéma strict et un plafond de tokens', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    const result = await analyzeDish(dish(), config, 'gpt-6-luna', new AbortController().signal, request);
    const [, options] = request.mock.calls[0];
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe('gpt-6-luna');
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(1400);
    expect(body.text.format.strict).toBe(true);
    expect(JSON.parse(body.input)).toEqual({ nomDuRepas: 'poulet frite' });
    expect(result.details).toEqual(details);
  });
  it('respecte le quota et ne facture pas à nouveau une analyse terminée', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => success());
    const log = vi.fn();
    const worker = new AiWorker(store, config, log, request);
    store.merge([dish(), dish()]);
    await Promise.all([worker.tick(), worker.tick()]);
    await worker.tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.capabilities().callsToday).toBe(1);
    expect(store.capabilities().inputTokens).toBe(300);
    expect(store.analyses().filter(item => item.status === 'ready')).toHaveLength(1);
    expect(store.analyses().filter(item => item.status === 'pending')).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });
  it('expose les erreurs et ne boucle pas automatiquement sur une requête échouée', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    const log = vi.fn();
    const worker = new AiWorker(store, config, log, request);
    const recipe = dish();
    store.merge([recipe]);
    await worker.tick();
    await worker.tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.analysis(recipe.id)?.status).toBe('error');
    expect(store.analysis(recipe.id)?.error).toContain('429');
    expect(store.get(`dish:${recipe.id}`)).toEqual(recipe);
    expect(log).toHaveBeenCalledOnce();
  });
  it('refuse une sortie malformée au lieu de l’utiliser', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name": "Seulement un nom"}' }] }],
      usage: { input_tokens: 300, output_tokens: 30 },
    })));
    await expect(analyzeDish(dish(), config, 'gpt-6-luna', new AbortController().signal, request)).rejects.toThrow('invalides');
  });
  it('laisse les analyses en attente sans clé et ignore les fiches archivées ou manuelles', async () => {
    const noKey = new Store({ ...config, OPENAI_API_KEY: '' });
    noKey.merge([dish()]);
    expect(noKey.claimAnalysis()).toBeUndefined();
    noKey.close();
    store.merge([dish({ archived: true }), dish({ details })]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('n’utilise jamais un modèle enregistré qui a été retiré de la liste autorisée', () => {
    store.merge([dish(), {
      type: 'settings', id: 'global', model: 'retired-model',
      modifiedAt: 1, mutationId: crypto.randomUUID(),
    }]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.capabilities().callsToday).toBe(0);
    store.merge([{
      type: 'settings', id: 'global', model: 'gpt-6-luna',
      modifiedAt: 2, mutationId: crypto.randomUUID(),
    }]);
    expect(store.claimAnalysis()).toBeDefined();
  });
});
