// Testes da lógica da Visão Geral do painel (sem React e sem rede). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, formatUptime, greetingFor, groupEvents, levelForFree, percent, relativeTime, systemSummary } from '../src/overviewLogic.ts';
import { TABS, tabVisible } from '../src/tabs.ts';

test('saudação por horário', () => {
  assert.equal(greetingFor(5), 'Bom dia');
  assert.equal(greetingFor(11), 'Bom dia');
  assert.equal(greetingFor(12), 'Boa tarde');
  assert.equal(greetingFor(17), 'Boa tarde');
  assert.equal(greetingFor(18), 'Boa noite');
  assert.equal(greetingFor(0), 'Boa noite');
  assert.equal(greetingFor(4), 'Boa noite');
  assert.equal(greetingFor(Number.NaN), 'Olá');
});

test('tempo ligada', () => {
  assert.equal(formatUptime(90), '1min');
  assert.equal(formatUptime(5400), '1h 30min');
  assert.equal(formatUptime(93784), '1d 2h');
  assert.equal(formatUptime(null), '—');
  assert.equal(formatUptime(-1), '—');
  assert.equal(formatUptime(undefined), '—');
});

test('percentual e nível de RAM/disco livres', () => {
  assert.equal(percent(1024, 4096), 25);
  assert.equal(percent(0, 4096), 0);
  assert.equal(percent(5000, 4096), 100);
  assert.equal(percent(null, 4096), null);
  assert.equal(percent(10, 0), null);
  assert.equal(levelForFree(25), 'ok');
  assert.equal(levelForFree(15), 'ok');
  assert.equal(levelForFree(14), 'warn');
  assert.equal(levelForFree(8), 'warn');
  assert.equal(levelForFree(7), 'danger');
  assert.equal(levelForFree(null), 'unknown');
});

test('"há quanto tempo"', () => {
  const now = Date.parse('2026-11-10T20:00:00Z');
  assert.equal(relativeTime('2026-11-10T19:59:30Z', now), 'agora');
  assert.equal(relativeTime('2026-11-10T19:55:00Z', now), 'há 5 min');
  assert.equal(relativeTime('2026-11-10T17:00:00Z', now), 'há 3 h');
  assert.equal(relativeTime('2026-11-08T20:00:00Z', now), 'há 2 d');
  assert.equal(relativeTime('2026-11-10T21:00:00Z', now), 'agora', 'relógio adiantado não vira número negativo');
  assert.equal(relativeTime('lixo', now), '—');
  assert.equal(relativeTime(null, now), '—');
});

test('eventos da auditoria em texto simples', () => {
  assert.equal(describeEvent('api.chat').label, 'Conversa pelo app');
  assert.equal(describeEvent('agent.tool.denied').tone, 'bad');
  assert.equal(describeEvent('auth.login.fail').tone, 'bad');
  assert.equal(describeEvent('admin.follow.youtube.liveMode').label, 'Modo das lives alterado');
  assert.equal(describeEvent('admin.algo.novo').label, 'Ajuste feito no painel', 'prefixo conhecido');
  assert.equal(describeEvent('dev.run.start').label, 'Módulo de código');
  assert.equal(describeEvent('evento.desconhecido').label, 'evento.desconhecido', 'sem tradução: mostra o próprio nome');
  assert.equal(describeEvent('').label, 'Evento');
});

test('frase de estado diz a verdade', () => {
  const ok = systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'ok' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /funcionando normalmente/);
  assert.equal(systemSummary({ discordOnline: true, aiOk: null, hostLevel: 'unknown' }).ok, true, 'sem leitura da IA não afirma problema');
  assert.match(systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'warn' }).text, /apertado/);
  const bad = systemSummary({ discordOnline: false, aiOk: false, hostLevel: 'danger' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Discord está desconectado, nenhum provedor de IA está disponível e o computador/);
  assert.match(systemSummary({ discordOnline: false, aiOk: true, hostLevel: 'ok' }).text, /^Preciso de atenção: o Discord está desconectado\.$/);
});

test('abas: Visão Geral e Admin só para o dono, Código só com o módulo ligado', () => {
  assert.equal(TABS[0].key, 'home');
  assert.equal(tabVisible('home', {}), false);
  assert.equal(tabVisible('home', { showAdmin: true }), true);
  assert.equal(tabVisible('admin', { showAdmin: false }), false);
  assert.equal(tabVisible('code', { showAdmin: true }), false);
  assert.equal(tabVisible('code', { showAdmin: true, showCode: true }), true);
  assert.equal(tabVisible('chat', {}), true);
  assert.equal(tabVisible('memory', {}), true);
  assert.equal(tabVisible('status', {}), true);
});

test('eventos iguais seguidos viram uma linha com contagem, sem perder a hora do mais recente', () => {
  const g = groupEvents([
    { ts: '2026-11-10T20:00:00Z', event: 'dev.tool' },
    { ts: '2026-11-10T19:59:00Z', event: 'dev.run.start' },
    { ts: '2026-11-10T19:58:00Z', event: 'dev.tool' },
    { ts: '2026-11-10T19:50:00Z', event: 'auth.login.ok' },
    { ts: '2026-11-10T19:40:00Z', event: 'dev.tool' },
  ]);
  assert.deepEqual(g.map((x) => [x.label, x.count]), [['Módulo de código', 3], ['Login no painel', 1], ['Módulo de código', 1]]);
  assert.equal(g[0].ts, '2026-11-10T20:00:00Z');
  assert.deepEqual(groupEvents([]), []);
});

test('leitura da saúde do computador: converte as unidades e nunca lança', async () => {
  const root = new URL('../../../src/core/api/admin.js', import.meta.url);
  const { readHostStats } = await import(root.href);
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const osFake = { platform: () => 'win32', totalmem: () => 4096 * MB, freemem: () => 1024 * MB };
  const fsFake = { statfsSync: () => ({ blocks: 100 * (GB / 4096), bavail: 25 * (GB / 4096), bsize: 4096 }) };
  assert.deepEqual(readHostStats({ osImpl: osFake, fsImpl: fsFake }), { platform: 'win32', ramTotalMB: 4096, ramFreeMB: 1024, diskTotalGB: 100, diskFreeGB: 25 });
  const broken = { platform: () => 'linux', totalmem: () => { throw new Error('x'); }, freemem: () => { throw new Error('x'); } };
  const noDisk = { statfsSync: () => { throw new Error('sem permissão'); } };
  assert.deepEqual(readHostStats({ osImpl: broken, fsImpl: noDisk }), { platform: 'linux', ramTotalMB: null, ramFreeMB: null, diskTotalGB: null, diskFreeGB: null });
});
