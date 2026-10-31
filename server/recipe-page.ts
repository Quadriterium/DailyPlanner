import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { loadBuffer } from 'cheerio';
import ipaddr from 'ipaddr.js';
import { detailsSchema, recipeUrlSchema } from '../shared/model.js';

const maxPageBytes = 2 * 1024 * 1024;
export interface RecipePage {
  url: string;
  name?: string;
  content: string;
}
export type RecipePageLoader = (url: string, signal: AbortSignal) => Promise<RecipePage>;

export async function resolveRecipeTarget(value: string, resolve: typeof lookup = lookup, signal?: AbortSignal) {
  const url = new URL(recipeUrlSchema.parse(value));
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) {
    throw new Error('Le lien de recette doit utiliser un port HTTP ou HTTPS standard.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal?.throwIfAborted();
  let abort = () => {};
  const resolution = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
    : resolve(hostname, { all: true });
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const addresses = await Promise.race([resolution, interrupted])
    .finally(() => signal?.removeEventListener('abort', abort));
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new Error('Le lien de recette doit désigner un site public, pas une adresse locale ou privée.');
  }
  return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}

async function readPublicPage(value: string, signal: AbortSignal) {
  const target = await resolveRecipeTarget(value, lookup, signal);
  signal.throwIfAborted();
  return new Promise<{ status: number; location?: string; body: Buffer; charset?: string }>((resolve, reject) => {
    const send = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target.url, {
      signal,
      family: target.family,
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'A-table-recipe-import/1.0' },
      // Pin the checked address: a second DNS lookup could otherwise reach the local network.
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        resolve({ status, location: response.headers.location, body: Buffer.alloc(0) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new Error(`Page de recette inaccessible (HTTP ${status}). Le lien est conservé.`));
        return;
      }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? '')) {
        response.destroy();
        reject(new Error('Le lien ne renvoie pas une page HTML de recette.'));
        return;
      }
      let size = 0;
      const encoding = response.headers['content-encoding']?.toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
        : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (encoding && encoding !== 'identity' && !decoder) {
        response.destroy();
        reject(new Error('Compression de la page de recette non prise en charge.'));
        return;
      }
      const content = decoder ?? response;
      let transferred = 0;
      response.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        if (transferred > maxPageBytes) req.destroy(new Error('La page de recette est trop volumineuse (2 Mo maximum).'));
      });
      const chunks: Buffer[] = [];
      content.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxPageBytes) {
          const error = new Error('La page de recette est trop volumineuse (2 Mo maximum).');
          content.destroy(error);
          req.destroy(error);
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      content.on('error', error => { req.destroy(error); reject(error); });
      content.on('end', () => resolve({
        status, body: Buffer.concat(chunks),
        charset: /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.headers['content-type'] ?? '')?.[1],
      }));
      if (decoder) response.pipe(decoder);
    });
    req.on('error', reject);
    req.end();
  });
}

function recipesIn(value: unknown, depth = 0): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || depth > 20) return [];
  if (Array.isArray(value)) return value.flatMap(item => recipesIn(item, depth + 1));
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  if (types.some(type => typeof type === 'string' && /(?:^|[/#])Recipe$/.test(type))) return [record];
  return Object.values(record).flatMap(item => recipesIn(item, depth + 1));
}

export function parseRecipePage(body: Buffer, url: string, charset?: string): RecipePage {
  const $ = loadBuffer(body, { encoding: { transportLayerEncodingLabel: charset } });
  const recipes: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    const parsed = parseOptionalJson($(element).text());
    if (parsed !== undefined) recipes.push(...recipesIn(parsed));
  });
  const recipe = recipes[0];
  const name = detailsSchema.shape.name.safeParse(recipe?.name);
  const structured = recipe ? {
    name: recipe.name, recipeYield: recipe.recipeYield,
    recipeIngredient: recipe.recipeIngredient, recipeInstructions: recipe.recipeInstructions,
    prepTime: recipe.prepTime, cookTime: recipe.cookTime, totalTime: recipe.totalTime,
  } : undefined;
  const title = $('title').text().trim();
  $('script,style,nav,header,footer,aside,noscript,form').remove();
  const main = $('main,article,[itemtype*="schema.org/Recipe"]').first();
  const text = (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim();
  const content = JSON.stringify({ title, ...(structured ? { recette: structured } : {}), texte: text.slice(0, 24_000) });
  if (!text && !structured) throw new Error('La page ne contient aucun contenu de recette lisible.');
  if (content.length > 40_000) throw new Error('Les données de la recette sont trop volumineuses pour être analysées.');
  return { url, ...(name.success ? { name: name.data } : {}), content };
}

function parseOptionalJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Invalid optional site metadata does not prevent analysis of its visible HTML.
    return undefined;
  }
}

export const fetchRecipePage: RecipePageLoader = async (url, signal) => {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await readPublicPage(url, boundedSignal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location) throw new Error('Redirection de recette sans destination.');
        url = new URL(response.location, url).href;
        continue;
      }
      return parseRecipePage(response.body, url, response.charset);
    }
    throw new Error('Le lien de recette effectue trop de redirections.');
  } catch (error) {
    throw new Error(`Import du lien impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`, { cause: error });
  }
};
