// GTABase como fonte do semanal: leitor do HTML (fixture salva em 2026-11-12), validação de período e busca com HTTP trocado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGtabaseHtml, isCurrentPeriod, fetchGtabaseWeekly, gtabaseDeps, GTABASE_URL } from '../src/engines/gtao/systems/weekly/gtabase.js';
import { buildWeeklyCombinedEmbeds } from '../src/engines/gtao/weeklyAnalysis.js';
import { weeklyRepository } from '../src/database/repositories/weeklyRepo.js';

const html = fs.readFileSync(new URL('./fixtures/gtabase-weekly-2026-11-12.html', import.meta.url), 'utf8');
const w = parseGtabaseHtml(html);

assert.ok(w, 'leu a página');
assert.equal(w.source, 'gtabase');
assert.equal(w.id, 'gtabase-2026-11-12');
assert.deepEqual(w.periodo, { inicio: '2026-11-12', fim: '2026-11-18' }, 'período da semana (12 a 18), não o do evento (até 2 de dezembro)');
assert.deepEqual(w.bonus.map((b) => b.multiplicador), ['4', '3', '2'], 'bônus do maior para o menor');
assert.ok(w.bonus[0].atividades.includes('Freemode Challenges'));
assert.ok(w.bonus[1].atividades.includes('Stunt Races'));
assert.ok(w.bonus[2].atividades.includes("Ron's Missions"), 'apóstrofo vem sem &#039;');
assert.equal(w.descontos.length, 10);
assert.ok(w.descontos.includes('Castigator (30%)'), 'formato que o embed do Reddit entende: Nome (30%)');
assert.deepEqual(w.veiculos, { podium: 'Everon', prizeRide: 'Powersurge' });
assert.deepEqual(w.desafios, ['Win two Stunt Races to get GTA$100,000']);
assert.equal(w.gunVan.length, 4);
assert.ok(w.gunVan.includes('Free: Baseball Bat & Knife'));
assert.equal(w.gtaPlus.items.length, 2, 'itens da Van de Armas marcados GTA+');
assert.ok(w.extras.some((e) => /Kortz/.test(e.titulo)) && w.extras.some((e) => /Salvage/.test(e.titulo)));
assert.ok(w.fullText.includes('Castigator -30% ($1,650,000 -> $1,155,000)'), 'o texto para a IA traz os preços');
assert.ok(!/Aegon|comment/i.test(JSON.stringify(w)), 'os comentários dos leitores ficam de fora');
console.log('ok leitor do HTML');

// mesmo formato do Reddit: o /gta-semanal monta as páginas (resumo, bônus, descontos, Van de Armas)
const pages = buildWeeklyCombinedEmbeds(w, null).map((p) => p.toJSON());
assert.ok(pages.length >= 3, `várias páginas, não só uma (veio ${pages.length})`);
const todo = JSON.stringify(pages);
assert.ok(todo.includes('Everon') && todo.includes('Castigator'), 'pódio e descontos aparecem');
assert.ok(todo.includes('GTABase'), 'o rodapé cita a fonte');
console.log('ok páginas do /gta-semanal:', pages.length);

// o registro é um semanal válido para o banco
assert.equal(weeklyRepository.isValidWeekly(w), true);

// período
assert.equal(isCurrentPeriod(w.periodo, new Date('2026-11-12T12:00:00Z')), true);
assert.equal(isCurrentPeriod(w.periodo, new Date('2026-11-19T10:00:00Z')), true, '1 dia de folga');
assert.equal(isCurrentPeriod(w.periodo, new Date('2026-11-25T12:00:00Z')), false, 'semana velha');
assert.equal(isCurrentPeriod({ inicio: null, fim: null }, new Date()), true);

// página sem o conteúdo, vazia, ou lixo: devolve null, nunca lança
assert.equal(parseGtabaseHtml('<html><body><p>oi</p></body></html>'), null);
assert.equal(parseGtabaseHtml(''), null);
assert.equal(parseGtabaseHtml(null), null);

// busca: HTTP trocado
const original = gtabaseDeps.get;
let chamadas = 0;
gtabaseDeps.get = async (url) => { chamadas++; assert.equal(url, GTABASE_URL); return { data: html }; };
let got = await fetchGtabaseWeekly({ now: new Date('2026-11-13T10:00:00Z') });
assert.equal(got?.id, 'gtabase-2026-11-12');
assert.equal(chamadas, 1);
got = await fetchGtabaseWeekly({ now: new Date('2026-12-20T10:00:00Z') });
assert.equal(got, null, 'página velha demais não vale');
gtabaseDeps.get = async () => { throw new Error('ECONNRESET'); };
assert.equal(await fetchGtabaseWeekly(), null, 'erro de rede vira null');
gtabaseDeps.get = async () => ({ data: '<html>layout novo</html>' });
assert.equal(await fetchGtabaseWeekly({ now: new Date('2026-11-13T10:00:00Z') }), null, 'layout que mudou vira null');
gtabaseDeps.get = original;

console.log('test-gtabase OK');
process.exit(0);
