import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';

test('Verificação de inicialização a partir do zero (diretório limpo)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-clean-db-test-'));

  const script = `
    import path from 'node:path';
    import fs from 'node:fs';
    import { initDatabase } from './src/database/db.js';

    const testSchemas = {
      'core': 'CREATE TABLE IF NOT EXISTS guild_settings (id TEXT PRIMARY KEY);',
      'newswire': 'CREATE TABLE IF NOT EXISTS news_articles (id TEXT PRIMARY KEY);',
      'gta-diario': 'CREATE TABLE IF NOT EXISTS daily_resets (id TEXT PRIMARY KEY);',
      'gta-semanal': 'CREATE TABLE IF NOT EXISTS weekly_events (id TEXT PRIMARY KEY);',
      'social-twitch': 'CREATE TABLE IF NOT EXISTS twitch_subs (id TEXT PRIMARY KEY);',
      'social-youtube': 'CREATE TABLE IF NOT EXISTS youtube_subs (id TEXT PRIMARY KEY);'
    };

    async function run() {
      for (const [name, sql] of Object.entries(testSchemas)) {
        await initDatabase(name, sql);
      }
      const created = fs.readdirSync(process.env.DATABASE_DIR).filter(f => f.endsWith('.db'));
      console.log('CREATED:' + created.sort().join(','));
    }
    run().catch(err => {
      console.error(err);
      process.exit(1);
    });
  `;

  // Etapa 8 (revisão da Liz): o filho roda sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers falham e ficam registrados);
  // nenhuma exceção: ele só cria os bancos numa pasta vazia.
  const bloqueio = criarBloqueioTemporario({ teste: 'test:cleanbootstrap', liberar: {} });
  const child = spawn(process.execPath, [...bloqueio.argv, '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_DIR: tmpRoot,
      LOG_LEVEL: 'error',
      ...bloqueio.env('bootstrap-limpo'),
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  bloqueio.fechar('test:cleanbootstrap'); // falha alto se o filho tentou rede, DNS, UDP, programa ou worker

  assert.equal(exitCode, 0, `Processo filho falhou: ${stderr}`);
  assert(stdout.includes('CREATED:core.db,gta-diario.db,gta-semanal.db,newswire.db,social-twitch.db,social-youtube.db'));

  const filesInTmp = fs.readdirSync(tmpRoot).filter((f) => f.endsWith('.db'));
  assert.equal(filesInTmp.length, 6);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
