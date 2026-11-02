import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const deployScript = new URL('../scripts/deploy.ps1', import.meta.url);

it('conserve le BOM UTF-8 requis pour les accents dans Windows PowerShell', () => {
  expect([...readFileSync(deployScript).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
});

describe.skipIf(process.platform !== 'win32')('Déploiement Windows sans Get-FileHash', () => {
  it.each([
    { change: 'none', install: false },
    { change: 'package.json', install: true },
    { change: 'package-lock.json', install: true },
    { change: 'missing', install: true },
  ])('compare les dépendances et publie le build : $change', ({ change, install }) => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-deploy-'));
    const repository = join(folder, 'repository');
    const production = join(folder, 'production');
    const commands = join(folder, 'commands.txt');
    try {
      for (const directory of [
        join(repository, 'scripts'), join(repository, 'dist'),
        join(production, 'data'), join(production, 'dist'),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      copyFileSync(deployScript, join(repository, 'scripts', 'deploy.ps1'));
      writeFileSync(join(repository, 'scripts', 'start.ps1'), '# fixture');
      writeFileSync(join(repository, 'scripts', 'backup.mjs'), '// fixture');
      writeFileSync(join(repository, 'dist', 'build.txt'), 'new build');
      writeFileSync(join(production, 'dist', 'build.txt'), 'old build');
      const env = 'PORT=3000\r\nDATABASE_PATH=./data/planner.sqlite\r\n';
      writeFileSync(join(production, '.env'), env);
      writeFileSync(join(production, 'data', 'planner.sqlite'), 'existing database');
      for (const name of ['package.json', 'package-lock.json']) {
        writeFileSync(join(repository, name), '{"version":"2"}');
        if (change !== 'missing') {
          writeFileSync(join(production, name), change === name ? '{"version":"1"}' : '{"version":"2"}');
        }
      }

      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `
        $ErrorActionPreference = 'Stop'
        function Get-FileHash { throw 'Get-FileHash must not be used' }
        function Get-NetTCPConnection { }
        function npm {
          Add-Content -LiteralPath $env:DEPLOY_COMMANDS -Value ($args -join ' ')
          $global:LASTEXITCODE = 0
        }
        function node {
          [System.IO.File]::WriteAllText($args[-1], 'backup fixture')
          $global:LASTEXITCODE = 0
        }
        & (Join-Path $env:DEPLOY_REPOSITORY 'scripts\\deploy.ps1') -ProductionPath $env:DEPLOY_PRODUCTION -ServerStopped
      `], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          DEPLOY_REPOSITORY: repository,
          DEPLOY_PRODUCTION: production,
          DEPLOY_COMMANDS: commands,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(commands, 'utf8').trim().split(/\r?\n/))
        .toEqual(install ? ['run build', 'ci --omit=dev'] : ['run build']);
      expect(readFileSync(join(production, 'dist', 'build.txt'), 'utf8')).toBe('new build');
      const releases = readdirSync(join(production, 'releases'));
      expect(releases).toHaveLength(1);
      expect(readFileSync(join(production, 'releases', releases[0], 'build.txt'), 'utf8')).toBe('old build');
      expect(readFileSync(join(production, '.env'), 'utf8')).toBe(env);
      expect(readFileSync(join(production, 'data', 'planner.sqlite'), 'utf8')).toBe('existing database');
      expect(readdirSync(join(production, 'backups'))).toHaveLength(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 30_000);
});
