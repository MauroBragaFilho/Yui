#!/usr/bin/env node
// AUTORIZAÇÃO ÚNICA do Google (etapa 15): roda UMA vez, num PC COM NAVEGADOR (não no servidor), e gera o arquivo de token que a Yui lê.
//
//   node scripts/google-autorizar.mjs --cliente caminho/do/cliente.json [--saida arquivo] [--gmail] [--porta N] [--sem-navegador] [--tempo segundos]
//
// Como funciona (fluxo de "app para computador" com redirecionamento local, o único que o Google aceita para Agenda, Tarefas e Gmail):
//  1. lê o JSON do cliente OAuth que você baixou do console do Google (tipo "App para computador");
//  2. abre um servidor SÓ em 127.0.0.1 numa porta livre, gera o PKCE (S256) e um `state`, e IMPRIME o link de consentimento (também tenta abrir o navegador);
//  3. você entra com a sua conta e autoriza (somente leitura); o Google volta para 127.0.0.1 com um código;
//  4. confere o `state`, troca o código pelos tokens e grava o arquivo (secrets/google-token.json, ou --saida) com a permissão restrita ao dono do PC.
// Escopos: Agenda e Tarefas (somente leitura). `--gmail` acrescenta o Gmail (somente leitura): só use se for mesmo ligar o Gmail; o consentimento incremental NÃO existe em
// app de computador, então os escopos são pedidos TODOS de uma vez. Nunca imprime segredo, código nem token.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hostsDoGoogle, hostsDeBaseLocal, ESCOPOS, temEscopo, ehEscopoDoGoogle } from '../src/integrations/google/endpoints.js';
import { arquivoDoTokenPadrao } from '../src/integrations/google/config.js';
import { gravarArquivoDeToken } from '../src/integrations/google/arquivoToken.js';
import { trocarCodigoPorTokens } from '../src/integrations/google/troca.js';
// O PKCE, o link de consentimento e a comparação do `state` vivem num módulo compartilhado com a reautorização pelo painel (src/integrations/google/consentimento.js);
// o comportamento é o mesmo de antes, e o script continua exportando criarPkce e montarUrlDeConsentimento.
import { criarPkce, montarUrlDeConsentimento, iguaisEmTempoConstante as iguais, CODIGO_DE_AUTORIZACAO_RE as CODIGO_RE } from '../src/integrations/google/consentimento.js';

export { criarPkce, montarUrlDeConsentimento };

const TEMPO_PADRAO_S = 300;

const AJUDA = `Autorização única do Google para a Yui (somente leitura).

Uso:
  node scripts/google-autorizar.mjs --cliente <cliente.json> [opções]

Opções:
  --cliente <arquivo>   o JSON do cliente OAuth baixado do console do Google (tipo "App para computador"). Obrigatório.
  --saida <arquivo>     onde gravar o arquivo de token (padrão: secrets/google-token.json).
  --gmail               pede também o Gmail (somente leitura). Só se você for ligar o Gmail.
  --porta <número>      porta local do retorno (padrão: uma porta livre).
  --sem-navegador       só imprime o link, sem tentar abrir o navegador.
  --tempo <segundos>    quanto esperar a autorização (padrão ${TEMPO_PADRAO_S}).
  --ajuda               mostra isto.
`;

/** Lê os argumentos. Devolve { ok: true, opcoes } ou { ok: false, erro }. */
export function lerArgumentos(argv) {
  const o = { cliente: null, saida: null, gmail: false, porta: 0, semNavegador: false, tempoS: TEMPO_PADRAO_S, ajuda: false };
  const lista = [...argv];
  const valor = (nome) => { const v = lista.shift(); if (v === undefined || v.startsWith('--')) throw new Error(`falta o valor de ${nome}.`); return v; };
  try {
    while (lista.length) {
      const a = lista.shift();
      if (a === '--cliente' || a === '-c') o.cliente = valor(a);
      else if (a === '--saida' || a === '-o') o.saida = valor(a);
      else if (a === '--gmail') o.gmail = true;
      else if (a === '--porta') {
        const n = Number(valor(a));
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--porta precisa ser um número de 0 a 65535.');
        o.porta = n;
      } else if (a === '--sem-navegador') o.semNavegador = true;
      else if (a === '--tempo') {
        const n = Number(valor(a));
        if (!Number.isFinite(n) || n < 5 || n > 3600) throw new Error('--tempo precisa ser de 5 a 3600 segundos.');
        o.tempoS = n;
      } else if (a === '--ajuda' || a === '-h' || a === '--help') o.ajuda = true;
      else throw new Error(`opção desconhecida: ${String(a).slice(0, 40)}`);
    }
  } catch (err) {
    return { ok: false, erro: err.message };
  }
  return { ok: true, opcoes: o };
}

/** Lê o JSON do cliente OAuth (tipo "installed"). Nunca devolve nem lança o conteúdo. */
export function lerClienteOAuth(arquivo) {
  let bruto;
  try { bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, '')); } catch (err) {
    return { ok: false, erro: err?.code === 'ENOENT' ? 'não achei o arquivo do cliente.' : 'não consegui ler o arquivo do cliente como JSON.' };
  }
  if (bruto?.web && !bruto?.installed) {
    return { ok: false, erro: 'este cliente é do tipo "Aplicativo da Web". Crie no console do Google um cliente do tipo "App para computador" (Desktop) e baixe o JSON dele.' };
  }
  const c = bruto?.installed;
  if (!c || typeof c.client_id !== 'string' || !c.client_id.trim() || typeof c.client_secret !== 'string' || !c.client_secret.trim()) {
    return { ok: false, erro: 'o arquivo não parece o JSON de um cliente "App para computador" (faltam client_id e client_secret).' };
  }
  return { ok: true, clientId: c.client_id.trim(), clientSecret: c.client_secret.trim() };
}

const PAGINA = (titulo, texto) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yui</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${titulo}</h1><p>${texto}</p></body></html>`;

/** Tenta abrir o link no navegador padrão, sem shell (o "&" do link não é interpretado). Falhar não é erro: o link já foi impresso. */
export function abrirNoNavegador(url) {
  try {
    let filho;
    if (process.platform === 'win32') filho = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true, detached: true });
    else filho = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    filho.on('error', () => {});
    filho.unref();
  } catch { /* o link está impresso */ }
}

/**
 * Espera o retorno do Google no servidor local. Resolve { codigo } ou { erro }.
 * Só uma requisição com o Host certo, a rota "/" e o `state` igual vale; qualquer outra recebe 400/404 e a espera continua.
 */
export function esperarRetorno(servidor, { porta, state, tempoS }) {
  return new Promise((resolve) => {
    let fim = false;
    const terminar = (r) => { if (fim) return; fim = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => terminar({ erro: 'tempo' }), tempoS * 1000);
    servidor.on('request', (req, res) => {
      const responder = (status, titulo, texto) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
        res.end(PAGINA(titulo, texto));
      };
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${porta}`) return responder(400, 'Pedido inválido', 'Esta página só recebe o retorno do Google.');
      let u;
      try { u = new URL(req.url ?? '/', `http://127.0.0.1:${porta}`); } catch { return responder(400, 'Pedido inválido', 'Endereço inválido.'); }
      if (u.pathname !== '/') return responder(404, 'Não encontrado', 'Nada aqui.');
      if (!iguais(u.searchParams.get('state'), state)) return responder(400, 'Retorno não reconhecido', 'Este retorno não pertence à autorização que está em andamento. Volte ao terminal e use o link que ele mostrou.');
      const erro = u.searchParams.get('error');
      if (erro) {
        responder(200, 'Autorização não concluída', 'O Google informou que a autorização não foi concluída. Pode fechar esta janela e voltar ao terminal.');
        return terminar({ erro: /^[a-z_]{1,40}$/.test(erro) ? erro : 'desconhecido' });
      }
      const codigo = u.searchParams.get('code') ?? '';
      if (!CODIGO_RE.test(codigo)) return responder(400, 'Retorno inválido', 'O retorno do Google veio sem um código válido.');
      responder(200, 'Pronto!', 'Autorização recebida. Pode fechar esta janela e voltar ao terminal.');
      return terminar({ codigo });
    });
  });
}

/**
 * O programa. `io` e os ganchos existem para o teste; no uso normal tudo vem dos padrões.
 * @returns {Promise<number>} o código de saída (0 = gravou o arquivo)
 */
export async function autorizar({
  argv = process.argv.slice(2), io = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) },
  hosts = null, abrir = abrirNoNavegador, fetchImpl = globalThis.fetch, restringir,
} = {}) {
  const lido = lerArgumentos(argv);
  if (!lido.ok) { io.err(`Erro: ${lido.erro}\n\n${AJUDA}`); return 1; }
  const o = lido.opcoes;
  if (o.ajuda) { io.out(AJUDA); return 0; }
  if (!o.cliente) { io.err(`Erro: informe o JSON do cliente com --cliente.\n\n${AJUDA}`); return 1; }
  const cliente = lerClienteOAuth(path.resolve(o.cliente));
  if (!cliente.ok) { io.err(`Erro: ${cliente.erro}`); return 1; }
  const saida = path.resolve(o.saida ?? arquivoDoTokenPadrao());
  const enderecos = hosts ?? hostsDoGoogle();
  const escopos = [ESCOPOS.agenda, ESCOPOS.tarefas, ...(o.gmail ? [ESCOPOS.gmail] : [])];

  const pkce = criarPkce();
  const state = crypto.randomBytes(24).toString('hex');
  const servidor = http.createServer();
  const porta = await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(o.porta, '127.0.0.1', () => resolve(servidor.address().port));
  }).catch(() => null);
  if (!porta) { io.err('Erro: não consegui abrir a porta local (127.0.0.1). Tente outra com --porta.'); return 1; }
  const redirectUri = `http://127.0.0.1:${porta}`;
  const fechar = () => { try { servidor.close(); servidor.closeAllConnections?.(); } catch { /* */ } };

  try {
    const url = montarUrlDeConsentimento({ hosts: enderecos, clientId: cliente.clientId, redirectUri, escopos, desafio: pkce.desafio, state });
    io.out('Autorização do Google para a Yui (somente leitura).');
    io.out(`Permissões pedidas: Agenda (eventos) e Tarefas${o.gmail ? ' e Gmail' : ''}, só para LER. Confira na tela do Google: ela mostra o que cada uma permite.`);
    io.out('Marque TODAS as caixas de permissão na tela do Google (ele deixa desmarcar uma por uma; sem elas a Yui não lê aquele recurso).');
    io.out('Se o Google mostrar "O Google não verificou este app": é esperado para um app seu em modo de teste. Clique em "Avançado" e depois em "Acessar ... (não seguro)". Só continue se o app e a conta forem os seus (a sua conta precisa estar na lista de usuários de teste do console).');
    io.out('\nAbra este link no navegador e autorize:\n');
    io.out(url);
    io.out(`\nEsperando a autorização (até ${Math.round(o.tempoS / 60 * 10) / 10} min). O retorno chega só neste computador (127.0.0.1).`);
    if (!o.semNavegador) abrir(url);

    const retorno = await esperarRetorno(servidor, { porta, state, tempoS: o.tempoS });
    if (retorno.erro === 'tempo') { io.err('\nErro: o tempo acabou sem a autorização. Rode o script de novo.'); return 1; }
    if (retorno.erro) { io.err(`\nA autorização não foi concluída (${retorno.erro}). Rode o script de novo e autorize.`); return 1; }

    const t = await trocarCodigoPorTokens({ hosts: enderecos, fetchImpl, clientId: cliente.clientId, clientSecret: cliente.clientSecret, codigo: retorno.codigo, verificador: pkce.verificador, redirectUri });
    if (!t.ok) {
      io.err(`\nErro: o Google recusou a troca do código${t.erro ? ` (${t.erro})` : t.motivo ? ` (${t.motivo})` : ''}. Confira se o cliente é do tipo "App para computador" e se a sua conta está na lista de usuários de teste; depois rode o script de novo.`);
      return 1;
    }
    if (!t.refreshToken) {
      io.err('\nErro: o Google não devolveu o refresh token. Remova o acesso do app em https://myaccount.google.com/permissions e rode o script de novo.');
      return 1;
    }
    const concedidos = t.escopos.filter(ehEscopoDoGoogle);
    const NOME = { agenda: 'a Agenda', tarefas: 'as Tarefas', gmail: 'o Gmail' };
    const faltam = ['agenda', 'tarefas', ...(o.gmail ? ['gmail'] : [])].filter((r) => !temEscopo(concedidos, r)).map((r) => NOME[r]);
    gravarArquivoDeToken(saida, {
      client_id: cliente.clientId, client_secret: cliente.clientSecret, refresh_token: t.refreshToken, escopos: concedidos, criadoEm: new Date().toISOString(),
    }, restringir ? { restringir } : undefined);

    io.out(`\nPronto! A autorização foi gravada em: ${saida}`);
    io.out('(o arquivo tem permissão só para o seu usuário; o conteúdo é um SEGREDO e não foi impresso)');
    if (faltam.length) {
      io.out(`\nAtenção: o Google NÃO concedeu a permissão d${faltam.length > 1 ? 'estes recursos' : 'este recurso'}: ${faltam.join(', ')}. A Yui não lerá ${faltam.length > 1 ? 'esses recursos' : 'esse recurso'} até você rodar o script de novo e marcar todas as caixas.`);
    }
    io.out('\nPróximos passos:');
    io.out(`  1. Copie esse arquivo para o servidor da Yui, no caminho de YUI_GOOGLE_TOKEN_ARQUIVO (padrão: secrets/google-token.json, dentro da pasta da Yui), por um meio seguro (cabo, pen drive ou scp pela rede privada). Nunca por Discord, e-mail ou nuvem aberta.`);
    io.out('  2. No .env do servidor: YUI_GOOGLE=true (o fuso da agenda é o do dono, YUI_FUSO, padrão America/Sao_Paulo; só ponha YUI_GOOGLE_FUSO=<seu fuso> se o da agenda for outro). Para o Gmail existe a chave YUI_GOOGLE_GMAIL, mas ele só funciona com a rota privada de IA validada.');
    io.out('  3. Reinicie a Yui.');
    io.out('  4. Depois de copiar, APAGUE o arquivo deste PC (ou guarde num lugar seguro): quem o tiver lê a sua agenda e as suas tarefas.');
    io.out('\nSe o projeto do Google estiver em modo de teste, o Google pode expirar a autorização depois de cerca de 7 dias. Quando isso acontecer a Yui te avisa uma vez, e você roda este script de novo.');
    return 0;
  } catch (err) {
    io.err(`\nErro: ${String(err?.message ?? 'falha inesperada').slice(0, 200)}`);
    return 1;
  } finally {
    fechar();
  }
}

// Rodado direto (node scripts/google-autorizar.mjs): `NODE_ENV=test` + `YUI_GOOGLE_FALSO_BASE` trocam os endereços por um Google FALSO em loopback (só para o teste).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let hosts = null;
  if (String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'test' && process.env.YUI_GOOGLE_FALSO_BASE) {
    try { hosts = hostsDeBaseLocal(process.env.YUI_GOOGLE_FALSO_BASE); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
  }
  autorizar({ hosts }).then((code) => { process.exitCode = code; });
}
