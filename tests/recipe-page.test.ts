import { EventEmitter } from 'node:events';
import { IncomingMessage, type RequestOptions } from 'node:http';
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRecipePage, parseRecipePage, resolveRecipeTarget } from '../server/recipe-page';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:http', async importOriginal => ({
  ...await importOriginal<typeof import('node:http')>(), request: send,
}));
vi.mock('node:https', () => ({ request: send }));

beforeEach(() => {
  send.mockReset();
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

function respond(body: string | Buffer, status = 200, headers = { 'content-type': 'text/html' }) {
  return (_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end() {
        const response = new IncomingMessage(new Socket());
        response.statusCode = status;
        response.headers = headers;
        callback(response);
        response.push(Buffer.from(body));
        response.push(null);
      },
      destroy(error: Error) { req.emit('error', error); },
    });
  };
}

describe('Page source de recette', () => {
  it('extrait Recipe dans @graph, ses portions et ses étapes, sans scripts ni navigation', () => {
    const recipe = { '@type': ['Thing', 'Recipe'], name: 'Gratin de courge', recipeYield: '4 personnes',
      recipeIngredient: ['800 g de courge'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Cuire 30 minutes.' }] };
    const page = parseRecipePage(Buffer.from(`<html><title>Gratin - Site</title><nav>Publicité</nav>
      <script type="application/ld+json">${JSON.stringify({ '@graph': [recipe] })}</script>
      <main><h1>Gratin de courge</h1><p>Cuire 30 minutes.</p><script>instruction pirate</script></main></html>`), 'https://example.org/gratin');
    expect(page.name).toBe(recipe.name);
    expect(JSON.parse(page.content).recette).toMatchObject({
      name: recipe.name, recipeYield: recipe.recipeYield,
      recipeIngredient: recipe.recipeIngredient, recipeInstructions: recipe.recipeInstructions,
    });
    expect(page.content).not.toContain('instruction pirate');
    expect(page.content).not.toContain('Publicité');
  });
  it('laisse l’IA identifier le plat dans le HTML quand les métadonnées sont absentes ou invalides', () => {
    const page = parseRecipePage(Buffer.from('<script type="application/ld+json">{invalid}</script><article>Soupe de courge : 500 g de courge.</article>'), 'https://example.org/soupe');
    expect(page.name).toBeUndefined();
    expect(page.content).toContain('500 g de courge');
    expect(() => parseRecipePage(Buffer.from('<html><body></body></html>'), page.url)).toThrow('aucun contenu');
  });
  it.each(['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]'])('refuse la cible non publique %s', async host => {
    await expect(resolveRecipeTarget(`http://${host}/recipe`)).rejects.toThrow('site public');
  });
  it('refuse un DNS mêlant adresses publiques et privées et les ports non standards', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }]);
    await expect(resolveRecipeTarget('https://example.org')).rejects.toThrow('site public');
    await expect(resolveRecipeTarget('https://example.org:3000')).rejects.toThrow('port');
    await expect(resolveRecipeTarget('file:///etc/passwd')).rejects.toThrow();
    await expect(resolveRecipeTarget('https://user:password@example.org')).rejects.toThrow();
  });
  it('récupère une page publique et épingle l’adresse DNS vérifiée', async () => {
    send.mockImplementation(respond('<main>Soupe de courge</main>'));
    const page = await fetchRecipePage('https://example.org/recipe', new AbortController().signal);
    expect(page.content).toContain('Soupe de courge');
    const options: RequestOptions = send.mock.calls[0][1];
    expect(options.family).toBe(4);
    const callback = vi.fn();
    options.lookup?.('example.org', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.headers).not.toHaveProperty('Authorization');
  });
  it('décompresse le HTML et respecte son encodage de transport', async () => {
    send.mockImplementation(respond(gzipSync(Buffer.from('<main>Gratin crème</main>', 'latin1')), 200,
      { 'content-type': 'text/html; charset=iso-8859-1', 'content-encoding': 'gzip' }));
    const page = await fetchRecipePage('https://example.org/', new AbortController().signal);
    expect(page.content).toContain('Gratin crème');
  });
  it('interrompt aussi une résolution DNS bloquée sans lancer de connexion', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const fetching = fetchRecipePage('https://example.org/', controller.signal);
    controller.abort(new Error('Délai dépassé'));
    await expect(fetching).rejects.toThrow('Délai dépassé');
    expect(send).not.toHaveBeenCalled();
  });
  it('suit une redirection relative, mais bloque une redirection vers le réseau local', async () => {
    send.mockImplementationOnce(respond('', 302, { 'content-type': 'text/html', location: '/recette' }))
      .mockImplementationOnce(respond('<main>Soupe</main>'));
    expect((await fetchRecipePage('http://example.org/', new AbortController().signal)).url).toBe('http://example.org/recette');
    send.mockReset().mockImplementation(respond('', 302, { 'content-type': 'text/html', location: 'http://127.0.0.1/' }));
    await expect(fetchRecipePage('https://example.org', new AbortController().signal)).rejects.toThrow('site public');
    expect(send).toHaveBeenCalledOnce();
  });
  it('refuse les boucles, les erreurs HTTP, les types non HTML et les pages dépassant 2 Mo', async () => {
    const signal = new AbortController().signal;
    send.mockImplementation(respond('', 302, { 'content-type': 'text/html', location: '/loop' }));
    await expect(fetchRecipePage('https://example.org/', signal)).rejects.toThrow('trop de redirections');
    expect(send).toHaveBeenCalledTimes(5);
    send.mockImplementation(respond('', 403));
    await expect(fetchRecipePage('https://example.org/', signal)).rejects.toThrow('403');
    send.mockImplementation(respond('{}', 200, { 'content-type': 'application/json' }));
    await expect(fetchRecipePage('https://example.org/', signal)).rejects.toThrow('HTML');
    send.mockImplementation(respond('a'.repeat(2 * 1024 * 1024 + 1)));
    await expect(fetchRecipePage('https://example.org/', signal)).rejects.toThrow('volumineuse');
    send.mockImplementation(respond(gzipSync(Buffer.from('a'.repeat(2 * 1024 * 1024 + 1))), 200,
      { 'content-type': 'text/html', 'content-encoding': 'gzip' }));
    await expect(fetchRecipePage('https://example.org/', signal)).rejects.toThrow('volumineuse');
  });
});
