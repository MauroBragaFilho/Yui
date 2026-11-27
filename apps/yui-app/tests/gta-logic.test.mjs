// Testes da seção "GTA" do Admin (item 9 v1 do plano das lacunas do painel, 27/11/2026; só leitura): a lógica pura (src/gtaLogic.ts), o cliente da API
// (GET /v1/admin/gta) e a ligação na tela. Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  TEXTO_SEM_DIARIO, alvosDoTipo, avisoDeErros, confirmacaoDaRepublicacao, dataEHora, dia, linhasDasFontes, ondeSaiu, resumoDaNoticia, resumoDoDiario, resumoDoSemanal,
  rotuloDoAlvo, semRepublicar, textoDaRepublicacao,
} from '../src/gtaLogic.ts';

const local = (ano, mes, d, h, m) => new Date(ano, mes - 1, d, h, m).toISOString();
const FONTES = {
  diario: { estado: 'ligado', horario: '06:00 UTC' },
  semanal: { estado: 'ligado', aoReiniciar: null, intervaloMin: 30 },
  reddit: { estado: 'ligado', voltaEm: null, falhas: 0 },
  reserva: { estado: 'ligado' },
  newswire: { estado: 'desligado', aoReiniciar: null, intervaloMin: 30 },
};
const DIARIO = {
  data: '2026-11-27', coletadoEm: '2026-11-27T06:00:10.000Z',
  vanDeArmas: { local: 'Paleto Bay', armas: [{ nome: 'Railgun', desconto: 40 }, { nome: 'Pistola', desconto: null }] },
  comerciantes: [{ local: 'Vespucci Beach', produto: 'Meth' }, { local: 'Sandy Shores', produto: null }],
  naufragio: 'Chumash', baus: 2, desafios: [{ nome: 'RC Bandito', local: 'Porto' }],
  publicado: [{ servidorId: '1', servidor: 'Servidor Um', canalId: '2', canal: 'gta-diario', em: local(2026, 11, 27, 6, 1) }],
};
const SEMANAL = {
  semana: '2026-W47', fonte: 'reddit', titulo: 'Weekly Bonuses and Discounts', periodo: { inicio: '2026-11-20', fim: '2026-11-27' },
  bonus: [{ multiplicador: 2, atividades: ['Corridas', 'Missões'] }, { multiplicador: 1.5, atividades: ['Golpes'] }], descontos: ['Turismo R - 30%', 'Zentorno - 40%'],
  podio: 'Pegassi Zentorno', premio: null, temAnalise: true, link: 'https://www.reddit.com/r/gtaonline/x', salvoEm: '2026-11-20T18:00:00.000Z', publicado: [],
};

test('datas: dia do jogo (sem fuso) e data e hora locais; sem data ou inválida, "—"', () => {
  assert.equal(dia('2026-11-27'), '27/11/2026');
  for (const ruim of [null, undefined, '', '27/11/2026', '2026-11-27T00:00']) assert.equal(dia(ruim), '—', String(ruim));
  assert.equal(dataEHora(local(2026, 11, 27, 6, 1)), '27/11/2026 às 06:01');
  for (const ruim of [null, '', 'lixo']) assert.equal(dataEHora(ruim), '—', String(ruim));
});

test('fontes: o Reddit desligado é "Desligado" (neutro), NUNCA erro; em espera mostra as falhas e a hora; o que muda ao reiniciar aparece', () => {
  const ligado = linhasDasFontes(FONTES);
  assert.deepEqual(ligado.map((l) => [l.chave, l.tom]), [['diario', 'ok'], ['semanal', 'ok'], ['reddit', 'ok'], ['reserva', 'ok'], ['newswire', 'neutro']]);
  assert.match(ligado[1].texto, /a cada 30 min/);
  assert.match(ligado[4].texto, /Desligado: não publica notícias sozinho/);
  const desligado = linhasDasFontes({ ...FONTES, reddit: { estado: 'desligado', voltaEm: null, falhas: 7 } }).find((l) => l.chave === 'reddit');
  assert.deepEqual([desligado.tom, desligado.texto], ['neutro', 'Desligado (o semanal segue pelas outras fontes).']);
  assert.doesNotMatch(desligado.texto, /erro|falha/i);
  const espera = linhasDasFontes({ ...FONTES, reddit: { estado: 'em-espera', voltaEm: local(2026, 11, 27, 13, 0), falhas: 2 } }).find((l) => l.chave === 'reddit');
  assert.deepEqual([espera.tom, espera.texto], ['atencao', 'Em espera depois de 2 falha(s) seguida(s); tenta de novo em 27/11/2026 às 13:00.']);
  const reinicio = linhasDasFontes({ ...FONTES, semanal: { estado: 'ligado', aoReiniciar: 'desligado', intervaloMin: null }, newswire: { estado: 'desligado', aoReiniciar: 'ligado', intervaloMin: 30 } });
  assert.match(reinicio[1].texto, /^Ligado\. Desliga ao reiniciar a Yui\.$/);
  assert.match(reinicio[4].texto, /Liga ao reiniciar a Yui\.$/);
  assert.deepEqual(linhasDasFontes(null), []);
});

test('erros de leitura viram uma frase só, com o que faltou; sem erro, null', () => {
  assert.equal(avisoDeErros(['diario', 'canais', 'qualquer']), 'Não consegui ler o reset diário e os canais dos servidores agora. O resto está abaixo.');
  assert.equal(avisoDeErros(['semanal']), 'Não consegui ler o evento semanal agora. O resto está abaixo.');
  assert.equal(avisoDeErros([]), null);
  assert.equal(avisoDeErros(undefined), null);
});

test('onde saiu: sem canal em nenhum servidor, com canal mas não saiu, e saiu (servidor, canal e hora; sem nome, o id)', () => {
  assert.deepEqual(ondeSaiu([], 0), { resumo: 'Nenhum servidor tem canal para isto.', linhas: [] });
  assert.deepEqual(ondeSaiu([], 3), { resumo: 'Ainda não saiu em nenhum dos 3 servidor(es) com canal.', linhas: [] });
  const r = ondeSaiu([...DIARIO.publicado, { servidorId: '9', servidor: null, canalId: '8', canal: null, em: null }], 3);
  assert.equal(r.resumo, 'Saiu em 2 de 3 servidor(es) com canal.');
  assert.deepEqual(r.linhas, ['Servidor Um (#gta-diario), 27/11/2026 às 06:01', 'servidor 9 (canal 8), —']);
  assert.equal(ondeSaiu(DIARIO.publicado, 0).resumo, 'Saiu em 1 de 1 servidor(es) com canal.', 'nunca "1 de 0"');
});

test('diário legível: Van de Armas com local e descontos, comerciantes, naufrágio, baús e desafios; sem dado, null', () => {
  const b = resumoDoDiario(DIARIO);
  assert.equal(b.titulo, 'Reset diário de 27/11/2026');
  assert.deepEqual(b.linhas, [
    { rotulo: 'Van de Armas', valor: 'Paleto Bay • Railgun (-40%), Pistola' },
    { rotulo: 'Comerciantes', valor: 'Vespucci Beach (Meth), Sandy Shores' },
    { rotulo: 'Naufrágio', valor: 'Chumash' },
    { rotulo: 'Baús do tesouro', valor: '2' },
    { rotulo: 'Contra o relógio', valor: 'RC Bandito: Porto' },
  ]);
  assert.equal(resumoDoDiario(null), null);
  const vazio = resumoDoDiario({ ...DIARIO, vanDeArmas: null, comerciantes: [], naufragio: null, baus: 0, desafios: [] });
  assert.deepEqual(vazio.linhas, [{ rotulo: 'Detalhes', valor: 'O reset foi salvo, mas sem detalhes.' }]);
  assert.match(TEXTO_SEM_DIARIO, /06:00 UTC/);
});

test('semanal legível: título, período, fonte, bônus por multiplicador, descontos, pódio e se saiu com análise', () => {
  const b = resumoDoSemanal(SEMANAL);
  assert.equal(b.titulo, 'Weekly Bonuses and Discounts');
  assert.deepEqual(b.linhas, [
    { rotulo: 'Período', valor: '20/11/2026 a 27/11/2026' },
    { rotulo: 'Fonte', valor: 'Reddit (r/gtaonline)' },
    { rotulo: '2x', valor: 'Corridas, Missões' },
    { rotulo: '1,5x', valor: 'Golpes' },
    { rotulo: 'Descontos', valor: 'Turismo R - 30% • Zentorno - 40%' },
    { rotulo: 'Veículo do pódio', valor: 'Pegassi Zentorno' },
    { rotulo: 'Análise da IA', valor: 'Saiu junto com a publicação' },
  ]);
  assert.equal(resumoDoSemanal({ ...SEMANAL, titulo: null, fonte: 'desconhecida', periodo: { inicio: null, fim: null }, bonus: [], descontos: [], podio: null, temAnalise: false }).titulo, 'Evento semanal 2026-W47');
  assert.equal(resumoDoSemanal(null), null);
  assert.deepEqual(resumoDaNoticia({ titulo: 'Novidades', categoria: null, publicadaEm: local(2026, 11, 26, 12, 0), link: null, publicado: [] }).linhas, [
    { rotulo: 'Categoria', valor: '—' }, { rotulo: 'Publicada', valor: '26/11/2026 às 12:00' },
  ]);
  assert.equal(resumoDaNoticia(null), null);
});

test('cliente: GET /v1/admin/gta (só leitura, sem corpo); os erros do servidor chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { fontes: FONTES, canais: { diario: 1, semanal: 0, noticias: 0 }, diario: DIARIO, semanal: null, noticia: null, erros: [] } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ?? null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  const r = await c.admin.gta();
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['GET', 'http://yui.local:3939/v1/admin/gta', null]);
  assert.equal(r.diario.vanDeArmas.local, 'Paleto Bay');
  resposta = { status: 503, body: { error: 'Disponível só com o bot conectado.' } };
  await assert.rejects(() => c.admin.gta(), (e) => e instanceof ApiError && e.status === 503 && /bot conectado/.test(e.message));
  assert.equal(Object.keys(c.admin).filter((k) => /gta/i.test(k)).sort().join(','), 'gta,republicarGta', 'a leitura e o republicar (item 9 v2)');
});

// ── Item 9 v2 (entrega E, parte 2): republicar o mais recente num servidor, no canal configurado, com confirmação ──
const ALVOS = {
  diario: [{ servidorId: '20', servidor: 'Zeta', canalId: '21', canal: 'gta' }, { servidorId: '10', servidor: null, canalId: '11', canal: null }],
  semanal: [],
  noticia: [{ servidorId: '30', servidor: 'Alfa', canalId: '31', canal: 'noticias' }],
};
const VIEW = { fontes: FONTES, canais: { diario: 2, semanal: 0, noticias: 1 }, alvos: ALVOS, diario: DIARIO, semanal: SEMANAL, noticia: null, erros: [] };

test('republicar: só os servidores com o canal do tipo (em ordem), o rótulo com servidor e canal, e o motivo quando não dá', () => {
  assert.equal(rotuloDoAlvo(ALVOS.diario[0]), 'Zeta (#gta)');
  assert.equal(rotuloDoAlvo(ALVOS.diario[1]), 'servidor 10 (canal 11)', 'sem nome, o id');
  assert.deepEqual(alvosDoTipo(VIEW, 'diario').map((a) => a.servidorId), ['10', '20'], 'em ordem de rótulo');
  assert.deepEqual(alvosDoTipo(VIEW, 'semanal'), []);
  assert.deepEqual(alvosDoTipo({ ...VIEW, alvos: undefined }, 'diario'), [], 'servidor antigo sem "alvos"');
  assert.equal(semRepublicar(VIEW, 'diario'), null);
  assert.equal(semRepublicar(VIEW, 'semanal'), 'Nenhum servidor tem canal semanal configurado (escolha em Servidores).');
  assert.equal(semRepublicar(VIEW, 'noticia'), null, 'sem notícia salva o card já diz; nada de botão nem de aviso a mais');
  assert.equal(semRepublicar(null, 'diario'), null);
});

test('republicar: a confirmação diz o que sai, onde e que só repete depois de 10 min; a frase do sucesso', () => {
  const c = confirmacaoDaRepublicacao('semanal', ALVOS.diario[0]);
  assert.equal(c.titulo, 'Republicar no Discord?');
  assert.equal(c.mensagem, 'Publica de novo o evento semanal mais recente em Zeta (#gta). É uma mensagem nova no canal configurado; dá para repetir só depois de 10 minutos.');
  assert.equal(textoDaRepublicacao('diario', ALVOS.diario[0]), 'O reset diário saiu de novo em Zeta (#gta).');
  assert.equal(textoDaRepublicacao('noticia', ALVOS.noticia[0]), 'A notícia saiu de novo em Alfa (#noticias).');
});

test('cliente: POST /v1/admin/gta/republicar com { tipo, guildId, confirm: true } (nunca um canal); 409/429 chegam com a frase do servidor', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ok: true, tipo: 'diario', guildId: '20', canalId: '21' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  const r = await c.admin.republicarGta({ tipo: 'diario', guildId: '20' });
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['POST', 'http://yui.local:3939/v1/admin/gta/republicar', { tipo: 'diario', guildId: '20', confirm: true }]);
  assert.equal(r.canalId, '21');
  resposta = { status: 429, body: { error: 'Muito cedo para republicar: isso saiu nesse servidor há pouco. Espere 9 min.' } };
  await assert.rejects(() => c.admin.republicarGta({ tipo: 'diario', guildId: '20' }), (e) => e instanceof ApiError && e.status === 429 && /Espere 9 min/.test(e.message));
  resposta = { status: 409, body: { error: 'Esse servidor não tem canal semanal configurado (escolha em Servidores > Canais).' } };
  await assert.rejects(() => c.admin.republicarGta({ tipo: 'semanal', guildId: '20' }), (e) => e.status === 409);
});

test('a tela: "GTA" no grupo Operação do Admin, com carregando, erro, o aviso das leituras que falharam e o republicar com confirmação em cada card', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const operacao = admin.slice(admin.indexOf("title: 'Operação'"), admin.indexOf("title: 'IA e memória'"));
  assert.match(operacao, /\{ key: 'gta', label: 'GTA' \}/);
  assert.match(admin, /section === 'gta' \? <Gta client=\{client\} \/>/);
  const tela = fs.readFileSync(path.join(raiz, 'AdminGta.tsx'), 'utf8');
  for (const p of ['kind="loading"', 'kind="error"', 'avisoDeErros(', 'linhasDasFontes(', 'resumoDoDiario(', 'resumoDoSemanal(', 'resumoDaNoticia(', 'ondeSaiu(']) assert.ok(tela.includes(p), p);
  for (const p of ['alvosDoTipo(', 'semRepublicar(', 'confirmacaoDaRepublicacao(', 'confirmAction(', 'client.admin.republicarGta(', 'textoDaRepublicacao(']) assert.ok(tela.includes(p), p);
  for (const tipo of ['diario', 'semanal', 'noticia']) assert.match(tela, new RegExp(`<Republicar client=\\{client\\} tipo="${tipo}"`), tipo);
  assert.doesNotMatch(tela, /TextInput/, 'nenhum canal digitado: só os servidores com o canal configurado');
});
