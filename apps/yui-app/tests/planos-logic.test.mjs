// Testes da seção "Planos e avisos" do Admin (lacunas do painel, entrega B, 26/11/2026; só leitura): a lógica pura (src/planosLogic.ts), o cliente da API
// (GET /v1/admin/planos e /v1/admin/avisos) e a ligação na tela. Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  avisoDosPlanos,
  confirmacaoDeAprovacao,
  detalheDoPasso,
  estadoDoPlano,
  linhaDaFila,
  linhaObservada,
  nomeDaFerramenta,
  nomeDaOrigem,
  ordenarObservados,
  pedidoDeDecisao,
  podeAprovar,
  podeDecidir,
  resultadoDaDecisao,
  TEXTO_APROVAR_PELA_DM,
  resumoDaContagem,
  resumoDosPlanos,
  rotuloDoAviso,
  textoDoModo,
  vistaDoPlano,
} from '../src/planosLogic.ts';

const AGORA = new Date(2026, 10, 26, 14, 30, 0);
const em = (dia, h, m = 0) => new Date(2026, 10, dia, h, m).toISOString();
const P = (over = {}) => ({
  id: 'a1b2c3d4e5f6', versao: 1, hash: 'abcdef0123456789', estado: 'concluido', criadoEm: em(26, 10, 0), validade: em(26, 10, 30), aprovadoEm: em(26, 10, 1), aprovacao: 'automatica',
  encerradoEm: em(26, 10, 2), motivo: 'concluido', passos: [{ ferramenta: 'agenda', estado: 'feito' }, { ferramenta: 'biblioteca_recentes', estado: 'feito' }], ...over,
});

test('estado do plano: os estados conhecidos com o tom certo; desconhecido aparece como veio, sem tom', () => {
  assert.deepEqual(estadoDoPlano('aguardando'), { texto: 'Aguardando aprovação', tom: 'atencao' });
  assert.deepEqual(estadoDoPlano('concluido'), { texto: 'Concluído', tom: 'ok' });
  assert.deepEqual(estadoDoPlano('interrompido'), { texto: 'Interrompido', tom: 'critico' });
  assert.deepEqual(estadoDoPlano('recusado'), { texto: 'Recusado', tom: 'neutro' });
  assert.deepEqual(estadoDoPlano('desconhecido'), { texto: 'Desconhecido', tom: 'neutro' });
  assert.deepEqual(estadoDoPlano(''), { texto: '—', tom: 'neutro' });
});

test('ferramentas: nomes legíveis; a desconhecida aparece como veio', () => {
  assert.equal(nomeDaFerramenta('biblioteca_buscar'), 'Biblioteca: buscar');
  assert.equal(nomeDaFerramenta('pesquisa'), 'Pesquisa na web');
  assert.equal(nomeDaFerramenta('desconhecida'), 'desconhecida');
  assert.equal(nomeDaFerramenta(''), '—');
});

test('cartão do plano encerrado: criado, passos feitos, aprovação automática, encerrado e o motivo; dos passos só a ferramenta e o estado', () => {
  const v = vistaDoPlano(P(), AGORA);
  assert.equal(v.titulo, 'Plano a1b2c3d4e5f6');
  assert.deepEqual(v.estado, { texto: 'Concluído', tom: 'ok' });
  assert.deepEqual(v.linhas, [
    { rotulo: 'Criado', valor: 'hoje às 10:00' },
    { rotulo: 'Passos feitos', valor: '2 de 2' },
    { rotulo: 'Aprovado automaticamente', valor: 'hoje às 10:01' },
    { rotulo: 'Encerrado', valor: 'hoje às 10:02' },
  ]);
  assert.deepEqual(v.passos, [{ texto: '1. Agenda do Google', detalhe: null, estado: 'feito', tom: 'ok' }, { texto: '2. Biblioteca: recentes', detalhe: null, estado: 'feito', tom: 'ok' }]);
  assert.match(v.nota, /Todos os passos foram feitos/);
});

test('cartão do plano aguardando: a validade da aprovação aparece, sem "encerrado" nem motivo; aprovado por você; versão > 1 no título', () => {
  const v = vistaDoPlano(P({ estado: 'aguardando', aprovadoEm: null, aprovacao: null, encerradoEm: null, motivo: null, passos: [{ ferramenta: 'pesquisa', estado: 'pendente' }] }), AGORA);
  assert.deepEqual(v.linhas.map((l) => l.rotulo), ['Criado', 'Passos feitos', 'Aprovação vale até']);
  assert.equal(v.nota, null);
  assert.deepEqual(v.passos, [{ texto: '1. Pesquisa na web', detalhe: null, estado: 'pendente', tom: 'neutro' }]);
  assert.equal(vistaDoPlano(P({ aprovacao: 'dono' }), AGORA).linhas[2].rotulo, 'Aprovado por você');
  assert.equal(vistaDoPlano(P({ versao: 2 }), AGORA).titulo, 'Plano a1b2c3d4e5f6 (versão 2)');
  const incerto = vistaDoPlano(P({ estado: 'interrompido', motivo: 'interrompido', passos: [{ ferramenta: 'agenda', estado: 'feito' }, { ferramenta: 'tarefas', estado: 'incerto' }] }), AGORA);
  assert.deepEqual(incerto.passos[1], { texto: '2. Tarefas do Google', detalhe: null, estado: 'incerto (não repetido)', tom: 'critico' });
  assert.match(incerto.nota, /não repete sozinha/);
  assert.equal(vistaDoPlano(P({ motivo: 'motivo-novo' }), AGORA).nota, null, 'motivo desconhecido não inventa texto');
});

test('resumo dos planos e o aviso do topo (desligados, arquivo ilegível, automático ou pela DM)', () => {
  assert.equal(resumoDosPlanos([]), 'Nenhum plano');
  assert.equal(resumoDosPlanos([P({ estado: 'aguardando' }), P({ estado: 'executando' }), P(), P({ estado: 'cancelado' })]), '1 aguardando aprovação, 1 em andamento, 2 encerrados');
  assert.equal(resumoDosPlanos([P()]), '1 encerrado');
  assert.match(avisoDosPlanos({ ligado: false, auto: false, ilegivel: false }), /desligados/);
  assert.match(avisoDosPlanos({ ligado: true, auto: false, ilegivel: true }), /Não consegui ler o arquivo dos planos/);
  assert.match(avisoDosPlanos({ ligado: true, auto: true, ilegivel: false }), /Aprovação automática ligada/);
  assert.match(avisoDosPlanos({ ligado: true, auto: false, ilegivel: false }), /botões da DM/);
  assert.equal(avisoDosPlanos(null), null);
  // entrega E: com `painel`, aprovar aqui ou pela DM; sem ele (ou servidor antigo), o caminho para ligar
  assert.match(avisoDosPlanos({ ligado: true, auto: false, ilegivel: false, painel: true }), /Aprove ou recuse aqui ou pelos botões da DM: as regras são as mesmas e a primeira decisão vale\./);
  assert.match(avisoDosPlanos({ ligado: true, auto: true, ilegivel: false, painel: true }), /^Aprovação automática ligada: .* Aprove ou recuse aqui/);
  assert.match(avisoDosPlanos({ ligado: true, auto: false, ilegivel: false, painel: false }), /"Aprovar e recusar planos pelo painel" em Configuração e chaves/);
  assert.doesNotMatch(avisoDosPlanos({ ligado: true, auto: false, ilegivel: false }), /ainda não existe/);
});

test('decisão pelo painel: os botões só no plano aguardando, dentro da validade, com o hash e "painel: true"', () => {
  const aguardando = P({ estado: 'aguardando', validade: em(26, 14, 45), aprovadoEm: null, aprovacao: null, encerradoEm: null, motivo: null });
  const lista = { ligado: true, painel: true };
  assert.equal(podeDecidir(aguardando, lista, AGORA), true);
  assert.equal(podeDecidir(aguardando, { ligado: true, painel: false }, AGORA), false, 'chave desligada: só leitura');
  assert.equal(podeDecidir(aguardando, { ligado: true }, AGORA), false, 'servidor antigo (sem o campo): só leitura');
  assert.equal(podeDecidir(aguardando, { ligado: false, painel: true }, AGORA), false, 'planos desligados');
  assert.equal(podeDecidir(aguardando, null, AGORA), false);
  assert.equal(podeDecidir({ ...aguardando, validade: em(26, 14, 30) }, lista, AGORA), false, 'venceu agora');
  assert.equal(podeDecidir({ ...aguardando, validade: null }, lista, AGORA), false, 'sem validade');
  assert.equal(podeDecidir({ ...aguardando, hash: null }, lista, AGORA), false, 'sem o hash não dá para pedir');
  assert.equal(podeDecidir({ ...aguardando, hash: 'curto' }, lista, AGORA), false);
  for (const estado of ['a_entregar', 'aprovado', 'executando', 'concluido', 'recusado', 'expirado', 'cancelado', 'interrompido', 'falhou', 'x']) {
    assert.equal(podeDecidir({ ...aguardando, estado }, lista, AGORA), false, estado);
  }
  assert.deepEqual(pedidoDeDecisao(aguardando, true), { versao: 1, hash: 'abcdef0123456789', aprovar: true });
  assert.deepEqual(pedidoDeDecisao({ versao: 2, hash: 'ff'.repeat(8) }, false), { versao: 2, hash: 'ff'.repeat(8), aprovar: false });
});

test('confirmação de aprovar ("Executar estes N passos de leitura?") com os passos legíveis, e a frase da resposta', () => {
  const c = confirmacaoDeAprovacao(P());
  assert.equal(c.titulo, 'Aprovar o plano');
  assert.equal(c.sim, 'Aprovar');
  assert.match(c.mensagem, /^Executar estes 2 passos de leitura\?\n\n1\. Agenda do Google\n2\. Biblioteca: recentes\n\nOs detalhes de cada passo estão na mensagem da DM\./);
  assert.match(confirmacaoDeAprovacao(P({ passos: [{ ferramenta: 'lembretes', estado: 'pendente' }] })).mensagem, /^Executar este 1 passo de leitura\?/);
  assert.deepEqual(resultadoDaDecisao({ ok: true, final: true, texto: 'Aprovado. Aviso aqui quando terminar.' }), { texto: 'Aprovado. Aviso aqui quando terminar.', tom: 'ok' });
  assert.deepEqual(resultadoDaDecisao({ ok: false, final: true, texto: 'Esse plano já foi respondido ou não vale mais.' }), { texto: 'Esse plano já foi respondido ou não vale mais.', tom: 'atencao' });
  assert.equal(resultadoDaDecisao({ ok: false, texto: '' }).texto, 'Não consegui decidir agora.');
  assert.equal(resultadoDaDecisao(null), null);
});

test('correção C1: o passo mostra a ação do resumo seguro e o detalhe (serviço, acesso, para onde vai, texto livre só como tamanho); sem resumo, como antes', () => {
  const resumoAgenda = { acao: 'Ler a sua agenda do Google (os próximos 7 dias)', servico: 'Google Agenda', acesso: 'leitura', saida: 'google', textoLivre: [], soPelaDm: false };
  const resumoBusca = { acao: 'Procurar um nome na biblioteca', servico: 'Biblioteca (BDS)', acesso: 'leitura', saida: 'rede-local', textoLivre: [{ campo: 'nome buscado', caracteres: 18 }], soPelaDm: false };
  const v = vistaDoPlano(P({ passos: [{ ferramenta: 'agenda', estado: 'feito', resumo: resumoAgenda }, { ferramenta: 'biblioteca_buscar', estado: 'pendente', resumo: resumoBusca }] }), AGORA);
  assert.deepEqual(v.passos.map((s) => [s.texto, s.detalhe]), [
    ['1. Ler a sua agenda do Google (os próximos 7 dias)', 'Google Agenda · só leitura · lê da sua conta Google'],
    ['2. Procurar um nome na biblioteca', 'Biblioteca (BDS) · só leitura · fica na rede de casa · nome buscado: 18 caracteres (o texto está na DM)'],
  ]);
  assert.equal(detalheDoPasso({ ...resumoAgenda, acesso: 'outro', saida: 'lua' }), 'Google Agenda · acesso desconhecido · destino desconhecido');
  assert.equal(detalheDoPasso({ ...resumoBusca, textoLivre: [{ campo: 'nome da lista', caracteres: 1 }] }).endsWith('nome da lista: 1 caractere (o texto está na DM)'), true);
  assert.equal(detalheDoPasso(undefined), null);
  // a confirmação de Aprovar usa as mesmas linhas
  const c = confirmacaoDeAprovacao({ passos: [{ ferramenta: 'agenda', estado: 'pendente', resumo: resumoAgenda }] });
  assert.match(c.mensagem, /^Executar este 1 passo de leitura\?\n\n1\. Ler a sua agenda do Google \(os próximos 7 dias\)\n {3}Google Agenda · só leitura · lê da sua conta Google\n\n/);
});

test('correção C1: plano com pesquisa (ou passo que o servidor não sabe resumir): Recusar fica, Aprovar some e o aviso manda aprovar pela DM', () => {
  const lista = { ligado: true, painel: true };
  const base = P({ estado: 'aguardando', validade: em(26, 14, 45), aprovadoEm: null, aprovacao: null, encerradoEm: null, motivo: null });
  const pesquisa = { acao: 'Pesquisar na web (as palavras saem para o buscador)', servico: 'Pesquisa na web', acesso: 'leitura', saida: 'internet', textoLivre: [{ campo: 'texto da pesquisa', caracteres: 20 }], soPelaDm: true };
  const comPesquisa = { ...base, aprovarSoPelaDm: true, passos: [{ ferramenta: 'pesquisa', estado: 'pendente', resumo: pesquisa }] };
  assert.deepEqual([podeDecidir(comPesquisa, lista, AGORA), podeAprovar(comPesquisa, lista, AGORA)], [true, false]);
  assert.equal(podeAprovar({ ...comPesquisa, aprovarSoPelaDm: undefined }, lista, AGORA), false, 'o passo sozinho já basta');
  assert.equal(podeAprovar(base, lista, AGORA), true, 'sem resumo (servidor antigo): como antes; o servidor confere de novo');
  assert.equal(podeAprovar({ ...base, aprovarSoPelaDm: false }, { ligado: true, painel: false }, AGORA), false, 'sem decisão pelo painel, nem aprovar');
  assert.match(TEXTO_APROVAR_PELA_DM, /aprove pela DM/);
  const tela = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'screens', 'AdminPlanos.tsx'), 'utf8');
  assert.match(tela, /aprova=\{podeAprovar\(p, planos\)\}/);
  assert.match(tela, /\{aprova \? <Button testID=\{`plano-aprovar-\$\{p\.id\}`\}/);
  assert.match(tela, /decide && !aprova \? <Text style=\{styles\.hint\} testID=\{`plano-so-pela-dm-\$\{p\.id\}`\}>\{TEXTO_APROVAR_PELA_DM\}<\/Text>/);
});

test('avisos: o assunto vira um nome legível; sem assunto (o servidor não pode mostrar), só a classe; motivo e até quando', () => {
  assert.equal(rotuloDoAviso({ assunto: 'google-reautorizar', classe: 'importante' }), 'Google: autorizar de novo');
  assert.equal(rotuloDoAviso({ assunto: 'provider', classe: 'importante' }), 'Provedor de IA parou');
  assert.equal(rotuloDoAviso({ assunto: null, classe: 'critico' }), 'Aviso crítico');
  assert.equal(rotuloDoAviso({ assunto: 'chave-nova', classe: 'informativo' }), 'chave-nova');
  const fila = linhaDaFila({ assunto: 'youtube', classe: 'informativo', motivo: 'silencio', ate: em(27, 7, 0), estado: 'pendente' }, AGORA);
  assert.deepEqual(fila, { titulo: 'Aviso do YouTube', detalhe: 'informativo · horário de silêncio · sai amanhã às 07:00', tom: 'atencao' });
  assert.equal(linhaDaFila({ assunto: null, classe: 'importante', motivo: 'falha', ate: null, estado: 'enviando' }, AGORA).detalhe, 'importante · o envio falhou; tenta de novo · sai na próxima passada · enviando agora');
  const obs = linhaObservada({ em: em(26, 1, 15), assunto: 'boot', classe: 'informativo', acao: 'adiar', motivo: 'silencio', ate: em(26, 7, 0) }, AGORA);
  assert.deepEqual(obs, { titulo: 'A Yui ligou', detalhe: 'hoje às 01:15 · teria adiado até hoje às 07:00 · horário de silêncio', tom: 'neutro' });
  assert.match(linhaObservada({ em: em(26, 9, 0), assunto: 'ai-down', classe: 'importante', acao: 'descartar', motivo: 'teto-assunto-repetido', ate: null }, AGORA).detalhe, /teria descartado · repetido acima do teto/);
});

test('modo do filtro, origem, ordem (mais novas primeiro, sem mudar a lista) e contagem', () => {
  assert.equal(textoDoModo('observar').titulo, 'Filtro só observando');
  assert.equal(textoDoModo('ligar').titulo, 'Filtro ligado');
  assert.match(textoDoModo('off').texto, /Avisos na hora certa/);
  assert.equal(textoDoModo('qualquer').titulo, 'Filtro desligado');
  assert.deepEqual(['cerebro', 'bot', 'unico', 'x'].map(nomeDaOrigem), ['Cérebro', 'Bot do Discord', 'Yui', 'x']);
  const lista = [{ em: em(26, 1) }, { em: em(26, 3) }, { em: null }, { em: em(26, 2) }];
  const copia = JSON.stringify(lista);
  assert.deepEqual(ordenarObservados(lista).map((x) => x.em), [em(26, 3), em(26, 2), em(26, 1), null]);
  assert.equal(JSON.stringify(lista), copia);
  assert.deepEqual(ordenarObservados(undefined), []);
  assert.equal(resumoDaContagem({ enviar: 3, adiar: 2, descartar: 0 }), '3 enviados na hora, 2 teriam sido adiados');
  assert.equal(resumoDaContagem({ enviar: 1, adiar: 1, descartar: 1 }), '1 enviado na hora, 1 teria sido adiado, 1 teria sido descartado');
  assert.equal(resumoDaContagem(undefined), '—');
});

test('cliente: GET /v1/admin/planos e /v1/admin/avisos (só leitura, sem corpo); os erros do servidor chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ligado: true, auto: true, ilegivel: false, total: 1, planos: [P()] } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ?? null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  assert.equal((await c.admin.planos()).planos[0].id, 'a1b2c3d4e5f6');
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['GET', 'http://yui.local:3939/v1/admin/planos', null]);
  resposta = { status: 200, body: { modo: 'observar', fila: { existe: false, ilegivel: false, resumoPendente: false, total: 0, itens: [] }, observados: [{ origem: 'bot', indisponivel: true }] } };
  assert.equal((await c.admin.avisos()).observados[0].indisponivel, true);
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['GET', 'http://yui.local:3939/v1/admin/avisos']);
  resposta = { status: 403, body: { error: 'proibido' } };
  await assert.rejects(() => c.admin.planos(), (e) => e instanceof ApiError && e.status === 403);
});

test('cliente: POST /v1/admin/planos/:id/decisao só com versão, hash e aprovar; 404 (chave desligada) e 429 chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ok: true, final: true, texto: 'Aprovado. Aviso aqui quando terminar.' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  assert.deepEqual(await c.admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: true, extra: 'x' }), resposta.body);
  assert.deepEqual(calls.at(-1), { url: 'http://yui.local:3939/v1/admin/planos/a1b2c3d4e5f6/decisao', method: 'POST', body: { versao: 1, hash: 'abcdef0123456789', aprovar: true } });
  await c.admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: 'sim' });
  assert.equal(calls.at(-1).body.aprovar, false, 'só true aprova');
  resposta = { status: 404, body: { error: 'Aprovar planos pelo painel está desligado.' } };
  await assert.rejects(() => c.admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: true }), (e) => e instanceof ApiError && e.status === 404);
  resposta = { status: 429, body: { error: 'Muitas decisões seguidas.' } };
  await assert.rejects(() => c.admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: true }), (e) => e instanceof ApiError && e.status === 429);
});

test('a tela: "Planos e avisos" no grupo Operação do Admin; Aprovar (com confirmação) e Recusar só quando podeDecidir; a frase aparece e a lista recarrega', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const operacao = admin.slice(admin.indexOf("title: 'Operação'"), admin.indexOf("title: 'IA e memória'"));
  assert.match(operacao, /\{ key: 'planos', label: 'Planos e avisos' \}/);
  assert.match(admin, /section === 'planos' \? <PlanosEAvisos client=\{client\} \/>/);
  const tela = fs.readFileSync(path.join(raiz, 'AdminPlanos.tsx'), 'utf8');
  for (const t of ['kind="loading"', 'kind="error"', 'kind="empty"', 'o.indisponivel', 'avisos.fila.ilegivel', 'vistaDoPlano(p)', 'linhaDaFila(a)', 'linhaObservada(r)', 'ordenarObservados(']) assert.ok(tela.includes(t), t);
  assert.match(tela, /Promise\.allSettled\(\[client\.admin\.planos\(\), client\.admin\.avisos\(\)\]\)/, 'um erro em uma das listas não esconde a outra');
  // os botões: só com podeDecidir(p, planos) (sem a chave, nenhum botão); aprovar confirma, recusar não; depois, a frase do servidor e o recarregar
  assert.match(tela, /decide=\{podeDecidir\(p, planos\)\}/);
  assert.match(tela, /\{decide \? \(/, 'os botões só existem com decide');
  // aprovar: a confirmação e depois a chave pela DM (correção C2; o detalhe está em confirmacao-logic.test.mjs); recusar não pede nenhuma das duas
  assert.match(tela, /confirmacaoDeAprovacao\(p\)[\s\S]*confirmAction\(c\.titulo, c\.mensagem, \(\) => \{ pedirChave\(p\); \}, c\.sim\)/);
  assert.match(tela, /if \(!aprovar\) \{\s*setChave\(null\);\s*enviarDecisao\(p, false\);/);
  assert.match(tela, /client\.admin\.decidirPlano\(p\.id, \{ \.\.\.pedidoDeDecisao\(p, aprovar\), \.\.\.\(confirmacao \? \{ confirmacao \} : \{\}\) \}\)/);
  assert.match(tela, /setResposta\(resultadoDaDecisao\(/);
  assert.match(tela, /finally \{\s*setDecidindo\(null\);\s*\}\s*await reload\(\);/, 'a lista recarrega depois de decidir (os botões somem)');
});
