// Testes da lógica da aba Status (diagnóstico completo) e do texto do "Reiniciar a Yui" (sem React e sem rede). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DIAGNOSTICO_ATUALIZA_MS, chamadaEmItem, duracao, erroEmTexto, estadoGeral, haQuanto, motivoEmTexto, podeVerDiagnostico, rotaPrivada, seguro, visaoDoDiagnostico,
} from '../src/diagnosticoLogic.ts';
import { confirmacaoDeReinicio } from '../src/restartLogic.ts';
import { describeEvent } from '../src/overviewLogic.ts';

const AGORA = Date.parse('2026-11-18T12:00:00Z');
const haSegundos = (s) => new Date(AGORA - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Um payload completo, no formato que o servidor entrega (src/core/diagnostico.js); cada teste muda só o que precisa. */
function payload(extra = {}) {
  const base = {
    versao: 1,
    geradoEm: haSegundos(3),
    modo: 'cerebro-separado',
    estado: 'ok',
    motivos: [],
    processo: { uptimeSegundos: 4000, memoriaMB: 105 },
    cerebro: { uptimeSegundos: 93784, backend: 'gateway', ponteDoBot: false, botConectado: true, discordOnline: true, canal: { conexoes: 1 }, conversa: { turnos: 4 }, pesquisa: {}, retomadaDaPesquisa: {}, comentarios: {}, lembretes: {}, travasPerdidas: 0 },
    ia: {
      backendAtivo: 'gateway', backends: [{ nome: 'gateway', ativo: true, local: false }], gatewayConfigurado: true, algumDisponivel: true, provedorAtual: 'omniroute', totais: { requests: 1200, ok: 1150, failed: 50 },
      provedores: [
        { id: 'omniroute', rotulo: 'OmniRoute', anonimo: true, prioridade: 5, chaves: 1, chavesEmDescanso: 0, descansoSegundos: 0, alvos: [{ modelo: 'auto', disponivel: true, descansoSegundos: 0, falhasSeguidas: 0, acertos: 900, falhas: 3, ultimoErro: { tipo: 'cota', status: 429 }, ultimoOkHaSegundos: 12 }] },
        { id: 'groq', rotulo: 'Groq', anonimo: false, prioridade: 10, chaves: 2, chavesEmDescanso: 1, descansoSegundos: 120, alvos: [{ modelo: 'llama', disponivel: false, descansoSegundos: 120, falhasSeguidas: 3, acertos: 10, falhas: 20, ultimoErro: { tipo: 'tempo', status: null }, ultimoOkHaSegundos: null }] },
      ],
    },
    limitesDeTokens: {
      teto: 4096, discord: { aplica: true, provedores: [{ provedor: 'groq', limite: 1500, configurado: 1500, capacidade: 8192, origem: 'configuração do canal' }] },
      app: { provedores: [{ provedor: 'groq', limite: 1000, configurado: 1500, capacidade: 1000, origem: 'capacidade do provedor' }] }, erroDeConfiguracao: false,
    },
    cotasDeBusca: {
      hora: {
        global: { usadas: 7, limite: 20, cheia: false, liberaEmSegundos: 0 }, porPessoaLimite: 3, reutilizadas: 2,
        persistencia: { gravando: true, pesquisaDisponivel: true, gravacaoComFalha: false, dono: 'cerebro', aguardandoTrava: false, perdeuATrava: false, motivo: null },
      },
      mes: [{ provedor: 'serper', usadas: 40, teto: 2500 }], reservaPercentual: 20,
    },
    avisosDeConfiguracao: [],
    erros: { ultimas24h: 3, reconexoesDoDiscord24h: 1, porEtiqueta: [{ etiqueta: 'IA', quantidade: 2 }, { etiqueta: 'Search', quantidade: 1 }] },
    bancos: { total: 10, motores: { sqljs: 10 }, tamanhoTotalMB: 12.5, comAlerta: [] },
    perfisDeIa: {
      configurado: true, origem: 'arquivo', errosDeConfiguracao: [],
      perfis: [
        { nome: 'conversa', habilitado: true, privacidade: 'geral', combo: 'auto', provedorDaYui: 'omniroute', provedorCadastrado: true, maxTokens: 1024, limiteEfetivo: 1024, capacidadeConhecida: null, chamadas: 10, ok: 8, erros: 1, fallbacks: 1, fechadas: 0, recusadasPorPrivacidade: 0 },
        { nome: 'privado', habilitado: true, privacidade: 'privada', combo: 'combo-privado', provedorDaYui: 'omniroute-privado', provedorCadastrado: true, maxTokens: 1024, limiteEfetivo: 1024, capacidadeConhecida: 4096, chamadas: 2, ok: 1, erros: 0, fallbacks: 0, fechadas: 1, recusadasPorPrivacidade: 0 },
      ],
      totais: { chamadas: 12, ok: 9, erros: 1, fallbacks: 1, fechadas: 1, recusadasPorPrivacidade: 0 },
      ultimas: [
        { quando: haSegundos(600), ponto: 'conversa', perfil: 'conversa', combo: 'auto', provedorQueRespondeu: 'groq', estrategia: 'priority', fallbackUsado: false, limiteDeTokens: 1024, latenciaMs: 420, resultado: 'ok', decisao: 'confirmada', motivo: null },
        { quando: haSegundos(60), ponto: 'conversa', perfil: 'conversa', combo: 'auto', provedorQueRespondeu: null, estrategia: null, fallbackUsado: true, limiteDeTokens: 1024, latenciaMs: null, resultado: 'fallback', decisao: 'nao-aplicavel', motivo: 'servidor' },
      ],
      rotaPrivada: {
        estado: 'validada', motivo: null, motivos: [], formatoDefinido: true, sondas: 3, sondasValidas: 2, violacoes: 0, ultimaSondaHaSegundos: 180, falhasSeguidas: 0, sondaSozinhaPausada: false,
        falhasRecentes: [],
      },
    },
    motorAgente: { pedido: 'nativo', ativo: 'nativo', recusado: false, motivo: null, implementados: { nativo: true, mastra: false } },
  };
  return { ...base, ...extra };
}
const cartao = (v, chave) => v.cartoes.find((c) => c.chave === chave);
const textoDe = (c) => JSON.stringify(c);

test('só o dono vê o diagnóstico (o membro nem pede; o servidor também responde 403); atualiza a cada 30 s', () => {
  assert.equal(podeVerDiagnostico('OWNER'), true);
  for (const r of ['MEMBER', 'TRUSTED', 'GUEST', 'BLOCKED', '', null, undefined, 'owner', 'ADMIN']) assert.equal(podeVerDiagnostico(r), false, String(r));
  assert.equal(DIAGNOSTICO_ATUALIZA_MS, 30_000);
});

test('estado geral: tudo certo, atenção e problema (cor e texto) com os motivos; um estado desconhecido nunca vira "tudo certo"', () => {
  assert.deepEqual(estadoGeral('ok'), { texto: 'Tudo certo', tom: 'ok' });
  assert.deepEqual(estadoGeral('atencao'), { texto: 'Atenção', tom: 'atencao' });
  assert.deepEqual(estadoGeral('problema'), { texto: 'Problema', tom: 'problema' });
  for (const x of ['', 'quebrado', null, undefined, 42, 'constructor', '__proto__']) assert.equal(estadoGeral(x).tom, 'atencao', String(x));
  const v = visaoDoDiagnostico(payload({ estado: 'problema', motivos: [{ codigo: 'sem-provedor-de-ia', texto: 'Nenhum provedor de IA está disponível agora.' }, { codigo: 'bot-desconectado', texto: 'O bot do Discord não está conectado ao cérebro.' }] }), AGORA);
  const g = cartao(v, 'geral');
  assert.equal(v.estado, 'problema');
  assert.deepEqual(g.selo, { texto: 'Problema', tom: 'problema' });
  assert.equal(g.itens.length, 2);
  assert.equal(g.itens[0].titulo, 'Nenhum provedor de IA está disponível agora.');
  assert.equal(g.itens[0].tom, 'problema');
  assert.equal(visaoDoDiagnostico(payload({ estado: 'atencao', motivos: [{ codigo: 'x', texto: 'Algo pede atenção.' }] }), AGORA).cartoes[0].itens[0].tom, 'atencao');
  assert.equal(cartao(visaoDoDiagnostico(payload(), AGORA), 'geral').nota, 'Nenhum motivo de atenção agora.');
  assert.equal(visaoDoDiagnostico(payload({ estado: 'lixo' }), AGORA).estado, 'atencao');
});

test('cérebro e bot: ligado há, bot ligado ao cérebro, Discord visto pelo bot, travas perdidas; processo único mostra só o processo', () => {
  const v = visaoDoDiagnostico(payload(), AGORA);
  const c = cartao(v, 'processos');
  assert.equal(c.titulo, 'Cérebro e bot');
  const linha = (rotulo) => c.linhas.find((l) => l.rotulo === rotulo);
  assert.equal(linha('Cérebro ligado há').valor, '1 d 2 h');
  assert.deepEqual([linha('Bot ligado ao cérebro').valor, linha('Bot ligado ao cérebro').tom], ['Sim', 'ok']);
  assert.deepEqual([linha('Discord (visto pelo bot)').valor, linha('Discord (visto pelo bot)').tom], ['Conectado', 'ok']);
  assert.equal(linha('Travas de dono perdidas').tom, 'ok');
  const fora = cartao(visaoDoDiagnostico(payload({ cerebro: { ...payload().cerebro, botConectado: false, discordOnline: null, travasPerdidas: 2 } }), AGORA), 'processos');
  assert.deepEqual(fora.selo, { texto: 'Bot desconectado', tom: 'atencao' });
  assert.equal(fora.linhas.find((l) => l.rotulo === 'Discord (visto pelo bot)').valor, 'Desconhecido');
  assert.equal(fora.linhas.find((l) => l.rotulo === 'Travas de dono perdidas').tom, 'problema');
  const unico = cartao(visaoDoDiagnostico(payload({ modo: 'unico', cerebro: null }), AGORA), 'processos');
  assert.equal(unico.titulo, 'Yui (processo único)');
  assert.equal(unico.linhas[0].valor, '1 h 6 min');
  assert.equal(cartao(visaoDoDiagnostico(payload({ modo: 'unico', cerebro: null }), AGORA), 'geral').linhas[1].valor, 'Processo único');
});

test('IA: o provedor que responderia agora, os totais e, por provedor, os modelos disponíveis, o descanso e o último erro (tipo e HTTP, nunca o texto)', () => {
  const c = cartao(visaoDoDiagnostico(payload(), AGORA), 'ia');
  assert.deepEqual(c.selo, { texto: 'Provedor disponível', tom: 'ok' });
  assert.equal(c.linhas.find((l) => l.rotulo === 'Responderia agora').valor, 'omniroute');
  assert.equal(c.linhas.find((l) => l.rotulo === 'Chamadas aos provedores').valor, '1.200 (1.150 ok, 50 com falha)');
  const [omni, groq] = c.itens;
  assert.equal(omni.titulo, 'OmniRoute (anônimo)');
  assert.match(omni.detalhe, /1 de 1 modelo\(s\) disponível\(is\)/);
  assert.match(omni.detalhe, /último erro: cota esgotada \(HTTP 429\)/);
  assert.equal(omni.tom, 'atencao');
  assert.equal(groq.tom, 'problema', 'nenhum modelo disponível = problema');
  assert.match(groq.detalhe, /2 chave\(s\), 1 em descanso/);
  assert.match(groq.detalhe, /em descanso por mais 2 min/);
  assert.match(groq.detalhe, /último erro: tempo esgotado/);
  const sem = cartao(visaoDoDiagnostico(payload({ ia: { ...payload().ia, algumDisponivel: false, provedorAtual: null } }), AGORA), 'ia');
  assert.deepEqual(sem.selo, { texto: 'Nenhum provedor disponível', tom: 'problema' });
  assert.equal(sem.linhas.find((l) => l.rotulo === 'Responderia agora').valor, 'nenhum provedor disponível');
  const nada = cartao(visaoDoDiagnostico(payload({ ia: { ...payload().ia, gatewayConfigurado: false, algumDisponivel: null, provedorAtual: null, provedores: [] } }), AGORA), 'ia');
  assert.deepEqual(nada.selo, { texto: 'Gateway não configurado', tom: 'neutro' });
});

test('limites de tokens e cotas de busca: teto, Discord (só com o cérebro separado), app, hora, mês, disco e pesquisa indisponível', () => {
  const l = cartao(visaoDoDiagnostico(payload(), AGORA), 'limites');
  assert.equal(l.linhas.find((x) => x.rotulo === 'Teto global').valor, '4.096 tokens');
  assert.ok(l.itens.some((i) => i.titulo === 'Discord · groq' && /1\.500 tokens/.test(i.detalhe)));
  assert.ok(l.itens.some((i) => i.titulo === 'App · groq' && /1\.000 tokens · capacidade do provedor/.test(i.detalhe)));
  const unico = cartao(visaoDoDiagnostico(payload({ limitesDeTokens: { ...payload().limitesDeTokens, discord: { aplica: false, provedores: [{ provedor: 'groq', limite: 9, configurado: 9, capacidade: 9, origem: 'x' }] } } }), AGORA), 'limites');
  assert.ok(!unico.itens.some((i) => i.titulo.startsWith('Discord')), 'no processo único o Discord não segue esta tabela');
  assert.match(unico.linhas.find((x) => x.rotulo === 'No Discord').valor, /cadeia do bot/);
  assert.equal(cartao(visaoDoDiagnostico(payload({ limitesDeTokens: { ...payload().limitesDeTokens, erroDeConfiguracao: true } }), AGORA), 'limites').selo.tom, 'atencao');
  const k = cartao(visaoDoDiagnostico(payload(), AGORA), 'cotas');
  assert.equal(k.linhas.find((x) => x.rotulo === 'Esta hora').valor, '7 de 20');
  assert.equal(k.linhas.find((x) => x.rotulo === 'Registro da cota em disco').valor, 'gravando');
  assert.equal(k.linhas.find((x) => x.rotulo === 'Reserva para o /yui').valor, '20% da cota');
  assert.equal(k.itens[0].detalhe, '40 de 2.500');
  assert.equal(k.selo, undefined);
  const cheia = cartao(visaoDoDiagnostico(payload({ cotasDeBusca: { ...payload().cotasDeBusca, hora: { ...payload().cotasDeBusca.hora, global: { usadas: 20, limite: 20, cheia: true, liberaEmSegundos: 600 } } } }), AGORA), 'cotas');
  assert.deepEqual(cheia.selo, { texto: 'Teto da hora atingido', tom: 'atencao' });
  assert.equal(cheia.linhas[0].valor, '20 de 20 (libera em 10 min)');
  const indisp = cartao(visaoDoDiagnostico(payload({ cotasDeBusca: { ...payload().cotasDeBusca, hora: { ...payload().cotasDeBusca.hora, persistencia: { ...payload().cotasDeBusca.hora.persistencia, pesquisaDisponivel: false } } } }), AGORA), 'cotas');
  assert.deepEqual(indisp.selo, { texto: 'Pesquisa indisponível', tom: 'atencao' });
});

test('perfis de IA: cada perfil (combo, limite, contadores) e as últimas chamadas (provedor que respondeu, estratégia, fallback, limite, latência), a mais recente primeiro', () => {
  const c = cartao(visaoDoDiagnostico(payload(), AGORA), 'perfis');
  assert.deepEqual(c.selo, { texto: 'Configurados', tom: 'ok' });
  assert.equal(c.linhas[0].valor, 'arquivo');
  assert.match(c.linhas[1].valor, /12 \(9 ok, 1 erro\(s\), 1 pelo caminho de sempre, 1 fechada\(s\)\)/);
  const conversa = c.itens.find((i) => i.titulo === 'Perfil conversa');
  assert.match(conversa.detalhe, /combo auto · geral · limite 1\.024 tokens · 10 chamada\(s\): 8 ok, 1 erro\(s\), 1 pelo caminho de sempre, 0 fechada\(s\)/);
  assert.match(c.itens.find((i) => i.titulo === 'Perfil privado').detalhe, /privado/);
  const chamadas = c.itens.filter((i) => / · combo /.test(i.titulo) && /·.*há/.test(i.titulo));
  assert.equal(chamadas.length, 2);
  assert.match(chamadas[0].titulo, /fallback|caiu no caminho de sempre/, 'a mais recente (60 s) vem primeiro');
  assert.match(chamadas[0].titulo, /há 1 min/);
  assert.match(chamadas[1].titulo, /respondeu · há 10 min/);
  assert.match(chamadas[1].detalhe, /Provedor que respondeu: groq · Estratégia: priority · Caminho de sempre usado: não · Limite: 1\.024 tokens · Demorou: 420 ms/);
  assert.match(chamadas[0].detalhe, /Provedor que respondeu: não confirmado/);
  assert.match(chamadas[0].detalhe, /Caminho de sempre usado: sim/);
  assert.match(chamadas[0].detalhe, /motivo: erro do servidor/);
  const sem = cartao(visaoDoDiagnostico(payload({ perfisDeIa: { ...payload().perfisDeIa, configurado: false, origem: 'nenhuma', perfis: [], ultimas: [], totais: { chamadas: 0, ok: 0, erros: 0, fallbacks: 0, fechadas: 0, recusadasPorPrivacidade: 0 } } }), AGORA), 'perfis');
  assert.deepEqual(sem.selo, { texto: 'Nenhum perfil configurado', tom: 'neutro' });
  assert.match(sem.nota, /caminho de sempre/);
  const erro = cartao(visaoDoDiagnostico(payload({ perfisDeIa: { ...payload().perfisDeIa, errosDeConfiguracao: [{ perfil: 'privado', codigo: 'provedor-nao-cadastrado' }] } }), AGORA), 'perfis');
  assert.equal(erro.selo.tom, 'atencao');
  assert.equal(erro.itens[0].titulo, 'Erro na configuração do perfil privado');
  assert.equal(erro.itens[0].detalhe, 'provedor não cadastrado');
  assert.match(chamadaEmItem({ quando: haSegundos(5), ponto: null, perfil: 'privado', combo: 'c', provedorQueRespondeu: null, estrategia: null, fallbackUsado: null, limiteDeTokens: null, latenciaMs: null, resultado: 'bloqueado', decisao: 'violada', motivo: 'provedor-invalido' }, AGORA).detalhe, /provedor fora da lista · motivo: provedor fora da lista permitida/);
});

test('rota privada: os seis estados (desligada, incompleta, não verificada, validada, não validada, bloqueada) com cor coerente; falhas seguidas, sonda sozinha pausada e falhas recentes', () => {
  const esperado = { desligada: 'neutro', incompleta: 'atencao', 'nao-verificada': 'atencao', validada: 'ok', 'nao-validada': 'atencao', bloqueada: 'problema' };
  const textos = { desligada: 'Desligada', incompleta: 'Incompleta', 'nao-verificada': 'Não verificada', validada: 'Validada', 'nao-validada': 'Não validada', bloqueada: 'Bloqueada' };
  for (const [estado, tom] of Object.entries(esperado)) {
    const r = rotaPrivada(estado);
    assert.deepEqual([r.texto, r.tom], [textos[estado], tom], estado);
    assert.ok(r.explica.length > 20, `${estado}: explicação em português`);
    const c = cartao(visaoDoDiagnostico(payload({ perfisDeIa: { ...payload().perfisDeIa, rotaPrivada: { ...payload().perfisDeIa.rotaPrivada, estado } } }), AGORA), 'rota-privada');
    assert.deepEqual(c.selo, { texto: textos[estado], tom }, estado);
    assert.equal(c.nota, r.explica);
  }
  for (const x of ['', 'confiavel', null, undefined, 'constructor']) assert.equal(rotaPrivada(x).tom, 'atencao', `${x}: nunca "validada"`);
  const p = payload();
  const falha = cartao(visaoDoDiagnostico(payload({ perfisDeIa: { ...p.perfisDeIa, rotaPrivada: {
    ...p.perfisDeIa.rotaPrivada, estado: 'nao-validada', motivo: 'tempo-esgotado', falhasSeguidas: 12, sondaSozinhaPausada: true, violacoes: 0, falhasRecentes: [{ haSegundos: 120, motivo: 'tempo-esgotado' }, { haSegundos: 420, motivo: 'rede' }],
  } } }), AGORA), 'rota-privada');
  const l = (rotulo) => falha.linhas.find((x) => x.rotulo === rotulo);
  assert.equal(l('Falhas seguidas da verificação').valor, '12');
  assert.equal(l('Falhas seguidas da verificação').tom, 'atencao');
  assert.equal(l('Verificação sozinha').valor, 'pausada (limite de tentativas)');
  assert.equal(l('Motivo').valor, 'tempo esgotado');
  assert.deepEqual(falha.itens.map((i) => i.titulo), ['há 2 min · tempo esgotado', 'há 7 min · falha de rede']);
  const bloq = cartao(visaoDoDiagnostico(payload({ perfisDeIa: { ...p.perfisDeIa, rotaPrivada: { ...p.perfisDeIa.rotaPrivada, estado: 'bloqueada', motivo: 'provedor-invalido', violacoes: 1 } } }), AGORA), 'rota-privada');
  assert.equal(bloq.linhas.find((x) => x.rotulo === 'Respostas fora do combinado').tom, 'problema');
  assert.equal(bloq.linhas.find((x) => x.rotulo === 'Verificação sozinha').valor, 'não se aplica', 'bloqueada nunca é sondada sozinha');
  const ok = cartao(visaoDoDiagnostico(payload(), AGORA), 'rota-privada');
  assert.equal(ok.linhas.find((x) => x.rotulo === 'Verificação sozinha').valor, 'ativa');
  assert.equal(ok.linhas.find((x) => x.rotulo === 'Verificações válidas').valor, '2 de 3');
  assert.equal(ok.linhas.find((x) => x.rotulo === 'Última verificação').valor, 'há 3 min');
});

test('motor do agente, erros e bancos, avisos de configuração', () => {
  const m = cartao(visaoDoDiagnostico(payload(), AGORA), 'motor');
  assert.deepEqual(m.linhas.map((x) => x.valor), ['nativo', 'nativo', 'ainda não implementado']);
  const recusado = cartao(visaoDoDiagnostico(payload({ motorAgente: { pedido: 'mastra', ativo: 'nativo', recusado: true, motivo: 'nao-implementado', implementados: { nativo: true, mastra: false } } }), AGORA), 'motor');
  assert.equal(recusado.selo.tom, 'atencao');
  assert.match(recusado.nota, /segue no motor nativo/);
  const e = cartao(visaoDoDiagnostico(payload(), AGORA), 'erros');
  assert.equal(e.linhas[0].valor, '3');
  assert.match(e.linhas[2].valor, /^10 \(10 sql\.js\) · 12\.5 MB$/);
  assert.deepEqual(e.itens.map((i) => i.titulo), ['[IA]', '[Search]']);
  assert.equal(cartao(visaoDoDiagnostico(payload({ erros: { ...payload().erros, ultimas24h: 25 } }), AGORA), 'erros').selo.tom, 'atencao');
  assert.equal(cartao(visaoDoDiagnostico(payload(), AGORA), 'avisos'), undefined, 'sem avisos, sem cartão');
  const a = cartao(visaoDoDiagnostico(payload({ avisosDeConfiguracao: [{ variavel: 'AI_MAX_TOKENS', problema: 'valor inválido', usando: 1500 }] }), AGORA), 'avisos');
  assert.equal(a.itens[0].titulo, 'AI_MAX_TOKENS');
  assert.match(a.itens[0].detalhe, /valor inválido \(valendo: 1500\)/);
});

test('servidor mais antigo (sem perfisDeIa e motorAgente) e payload vazio ou torto: nada quebra e nada é inventado', () => {
  const { perfisDeIa, motorAgente, ...antigo } = payload();
  void perfisDeIa; void motorAgente;
  const v = visaoDoDiagnostico(antigo, AGORA);
  for (const chave of ['perfis', 'rota-privada', 'motor']) assert.equal(cartao(v, chave), undefined, `${chave}: sem o dado, sem cartão`);
  assert.ok(cartao(v, 'geral') && cartao(v, 'ia') && cartao(v, 'cotas'));
  for (const torto of [{}, { estado: 'ok' }, { ia: null, cerebro: 3, perfisDeIa: { rotaPrivada: 'x', perfis: 'y', ultimas: 5 }, limitesDeTokens: 'a', cotasDeBusca: [], erros: null, bancos: 7 }]) {
    const out = visaoDoDiagnostico(torto, AGORA);
    assert.ok(Array.isArray(out.cartoes) && out.cartoes.length >= 5);
    assert.ok(!JSON.stringify(out).includes('undefined') && !JSON.stringify(out).includes('NaN'), JSON.stringify(torto).slice(0, 60));
  }
  assert.equal(cartao(visaoDoDiagnostico({}, AGORA), 'cotas').linhas[0].valor, '— de —');
});

test('NADA além do que o servidor entrega: campos extras (segredos plantados) nunca aparecem; textos viram uma linha curta, sem controle', () => {
  const SEGREDO = 'sk-SEGREDO-PLANTADO-0123456789abcdef';
  const p = payload();
  p.segredo = SEGREDO;
  p.cerebro.token = SEGREDO;
  p.cerebro.canal = { chave: SEGREDO };
  p.ia.provedores[0].apiKey = SEGREDO;
  p.ia.provedores[0].alvos[0].ultimoErro = { tipo: 'cota', status: 429, texto: SEGREDO };
  p.perfisDeIa.perfis[0].authorization = `Bearer ${SEGREDO}`;
  p.perfisDeIa.ultimas[0].cabecalho = SEGREDO;
  p.perfisDeIa.rotaPrivada.promptDoDono = SEGREDO;
  p.cotasDeBusca.consulta = SEGREDO;
  const tudo = JSON.stringify(visaoDoDiagnostico(p, AGORA));
  assert.ok(!tudo.includes(SEGREDO), 'um campo que o servidor não promete nunca é mostrado');
  assert.ok(!tudo.includes('Bearer'));
  // um texto torto num campo que o servidor promete (rótulo) é limpo e cortado
  const feio = payload();
  feio.ia.provedores[0].rotulo = `Linha 1\n\r\u0000Linha 2 ${'x'.repeat(400)}`;
  const item = cartao(visaoDoDiagnostico(feio, AGORA), 'ia').itens[0];
  assert.ok(!/[\u0000-\u001f]/.test(item.titulo) && item.titulo.length <= 60, item.titulo);
  assert.equal(seguro('a\nb\t c'), 'a b c');
  assert.equal(seguro('x'.repeat(200), 20).length, 20);
  assert.ok(seguro('x'.repeat(200), 20).endsWith('…'));
  for (const v of [null, undefined, 3, {}, [], '', '   ']) assert.equal(seguro(v), '—', String(v));
});

test('o app NÃO guarda o diagnóstico em disco: nem a lógica nem a tela usam o armazenamento, e só o dono pede', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src');
  const logica = fs.readFileSync(path.join(raiz, 'diagnosticoLogic.ts'), 'utf8');
  const tela = fs.readFileSync(path.join(raiz, 'screens', 'StatusScreen.tsx'), 'utf8');
  const restart = fs.readFileSync(path.join(raiz, 'restartLogic.ts'), 'utf8');
  for (const [nome, codigo] of [['diagnosticoLogic.ts', logica], ['StatusScreen.tsx', tela], ['restartLogic.ts', restart]]) {
    const semComentarios = codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(semComentarios, /AsyncStorage|localStorage|sessionStorage|indexedDB|from '\.\.?\/storage|from '\.\/storage|expo-file-system|node:fs|from 'fs'/, `${nome} não pode guardar nada`);
  }
  assert.match(tela, /podeVerDiagnostico\(me\.role\)/, 'a tela só mostra (e só pede) o diagnóstico para o dono');
  assert.match(tela, /client\.admin\.diagnostico\(\)/);
  assert.match(tela, /DIAGNOSTICO_ATUALIZA_MS/);
  assert.match(tela, /status === 401 \|\| e\.status === 403/, 'sem permissão: para de pedir');
});

test('ajudantes: duração, "há quanto tempo", erro do provedor e códigos do servidor em português', () => {
  assert.deepEqual([45, 300, 7500, 200000, 86400].map(duracao), ['45 s', '5 min', '2 h 5 min', '2 d 7 h', '1 d']);
  for (const v of [null, undefined, -1, Number.NaN, '5', {}]) assert.equal(duracao(v), '—', String(v));
  assert.deepEqual([2, 45, 300, 7200].map(haQuanto), ['agora', 'há 45 s', 'há 5 min', 'há 2 h']);
  assert.equal(erroEmTexto({ tipo: 'cota', status: 429 }), 'cota esgotada (HTTP 429)');
  assert.equal(erroEmTexto({ tipo: 'rede', status: null }), 'falha de rede');
  assert.equal(erroEmTexto({ tipo: 'inventado', status: null }), 'erro');
  assert.equal(erroEmTexto(null), '—');
  assert.equal(motivoEmTexto('tempo-esgotado'), 'tempo esgotado');
  assert.equal(motivoEmTexto('algo-novo-do-servidor'), 'algo novo do servidor', 'código que o app não conhece: o próprio código, já filtrado pelo servidor');
  assert.equal(motivoEmTexto(null), '—');
  assert.equal(motivoEmTexto('constructor'), 'constructor');
});

test('"Reiniciar a Yui": com o cérebro separado o texto diz que reinicia os DOIS; no processo único, a Yui inteira; a confirmação continua explícita', () => {
  const dois = confirmacaoDeReinicio({ cerebro: { botConectado: true } });
  assert.equal(dois.titulo, 'Reiniciar o cérebro e o bot?');
  assert.match(dois.mensagem, /DOIS/);
  assert.match(dois.mensagem, /cérebro/);
  assert.match(dois.mensagem, /bot do Discord/);
  assert.match(dois.mensagem, /sem resposta até o cérebro voltar/);
  assert.equal(dois.sim, 'Reiniciar os dois');
  assert.ok(!/já está desconectado/.test(dois.mensagem));
  assert.match(confirmacaoDeReinicio({ cerebro: { botConectado: false } }).mensagem, /O bot já está desconectado do cérebro agora\./);
  for (const sem of [null, undefined, {}, { cerebro: null }]) {
    const unico = confirmacaoDeReinicio(sem);
    assert.equal(unico.titulo, 'Reiniciar a Yui?');
    assert.match(unico.mensagem, /A Yui fica offline por alguns segundos e volta sozinha/);
    assert.ok(!/DOIS/.test(unico.mensagem));
    assert.equal(unico.sim, 'Reiniciar');
  }
  const raiz = path.resolve(import.meta.dirname, '..', 'src');
  const admin = fs.readFileSync(path.join(raiz, 'screens', 'AdminScreen.tsx'), 'utf8');
  assert.match(admin, /confirmacaoDeReinicio\(data\)/);
  assert.match(admin, /confirmAction\(\s*c\.titulo,\s*c\.mensagem,/, 'a tela usa o texto da lógica e a confirmação explícita');
  assert.equal(describeEvent('admin.restart.recusado').tone, 'bad', 'um reinício recusado não aparece como "Yui reiniciada"');
  assert.notEqual(describeEvent('admin.restart.recusado').label, describeEvent('admin.restart').label);
});
