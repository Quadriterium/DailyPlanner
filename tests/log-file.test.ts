import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { DailyLogFile } from '../server/log-file';

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'a-table-logs-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('journal sur disque', () => {
  it('écrit un fichier par jour de Paris et plafonne sa taille', () => {
    const directory = join(temporary(), 'logs');
    let now = new Date('2026-11-20T23:30:00Z');
    const file = new DailyLogFile(directory, 1000, () => now);
    const line = `${'x'.repeat(99)}\n`;
    for (let index = 0; index < 20; index++) file.write(line);
    // 23:30 UTC is already the 21st in Paris.
    const first = join(directory, 'a-table-2026-11-21.log');
    expect(statSync(first).size).toBeLessThanOrEqual(1000);
    const content = readFileSync(first, 'utf8').trim().split('\n');
    expect(content.at(-1)).toContain('Limite quotidienne');
    expect(content.filter(entry => entry === line.trim())).toHaveLength(7);

    now = new Date('2026-11-21T23:30:00Z');
    file.write(line);
    file.close();
    expect(readFileSync(join(directory, 'a-table-2026-11-22.log'), 'utf8')).toBe(line);
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it('reprend la taille du fichier du jour après un redémarrage', () => {
    const directory = temporary();
    const path = join(directory, 'a-table-2026-11-20.log');
    writeFileSync(path, 'y'.repeat(900));
    const file = new DailyLogFile(directory, 1000, () => new Date('2026-11-20T12:00:00Z'));
    file.write('z\n');
    file.write('z\n');
    file.close();
    expect(readFileSync(path, 'utf8').match(/Limite quotidienne/g)).toBeNull();
    expect(statSync(path).size).toBe(900);
  });

  it('copie les journaux du serveur dans LOG_DIR et refuse un dossier publié', async () => {
    const root = temporary();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const store = new Store(readConfig({ DATABASE_PATH: ':memory:' }));
    try {
      const published = readConfig({ DATABASE_PATH: ':memory:', LOG_DIR: join(root, 'client', 'logs') });
      await expect(buildApp(store, published, { staticRoot: join(root, 'client') })).rejects.toThrow('LOG_DIR');

      const logDir = join(root, 'logs');
      const app = await buildApp(store, readConfig({ DATABASE_PATH: ':memory:', LOG_DIR: logDir }), { staticRoot: join(root, 'client') });
      await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: 'invalide' } });
      await app.close();
      const [name] = readdirSync(logDir);
      expect(readFileSync(join(logDir, name), 'utf8')).toContain('requête refusée');
    } finally {
      store.close();
    }
  });
});
