#!/usr/bin/env node
// AUTORIZAÇÃO ÚNICA da conta do CANAL DA YUI no YouTube (docs/GUIA_YOUTUBE_LIVE.md). O dono roda num computador com navegador; o arquivo vai para secrets/.
//
//   node scripts/youtube-autorizar.mjs --cliente caminho/do/cliente.json [--saida arquivo] [--porta N] [--sem-navegador] [--tempo segundos]
//
// Fluxo de "app para computador": retorno só em 127.0.0.1, PKCE e `state`. Um escopo só (youtube.force-ssl, o menor que escreve no chat ao vivo).
// Grava um arquivo SEPARADO do Google da Agenda, com permissão restrita. Nunca imprime segredo, código nem token.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostsDoGoogle, ESCOPO_DO_YOUTUBE } from '../src/integrations/google/endpoints.js';
import { trocarCodigoPorTokens } from '../src/integrations/google/troca.js';
import { arquivoDaCredencial, gravarCredencial } from '../src/core/live/credencial.js';
import { BASE_PADRAO, validarBaseUrl } from '../src/adaptadores/youtube/api.js';
import { lerArgumentos, lerClienteOAuth, criarPkce, montarUrlDeConsentimento, abrirNoNavegador, esperarRetorno } from './google-autorizar.mjs';

const AJUDA = `Autorização da conta do canal da Yui no YouTube (ler e escrever no chat ao vivo).

Uso:
  node scripts/youtube-autorizar.mjs --cliente <cliente.json> [--saida arquivo] [--porta N] [--sem-navegador] [--tempo segundos]
`;

/** O canal da conta que autorizou (channels.list mine=true, 1 unidade). */
async function canalDaConta({ base, token, fetchImpl }) {
  const b = validarBaseUrl(base);
  if (!b.ok) return null;
  try {
    const res = await fetchImpl(`${b.base}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Só o código e o motivo da API (sem token): diz se a API está desligada no projeto, se falta permissão etc.
      const motivo = String(corpo?.error?.errors?.[0]?.reason ?? corpo?.error?.status ?? '').slice(0, 60);
      process.stderr.write(`\n(o YouTube respondeu ${res.status}${motivo ? `: ${motivo}` : ''})\n`);
      return null;
    }
    const item = corpo?.items?.[0];
    if (!item) process.stderr.write('\n(o YouTube respondeu, mas essa conta não tem canal: na tela do Google, escolha o CANAL da Yui na lista de contas e canais)\n');
    return typeof item?.id === 'string' ? { id: item.id, titulo: String(item.snippet?.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100) } : null;
  } catch (e) {
    process.stderr.write(`\n(não consegui falar com o YouTube: ${String(e?.name ?? 'erro').slice(0, 40)})\n`);
    return null;
  }
}

/** @returns {Promise<number>} o código de saída (0 = gravou o arquivo) */
export async function autorizar({
  argv = process.argv.slice(2), io = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) },
  hosts = null, base = BASE_PADRAO, abrir = abrirNoNavegador, fetchImpl = globalThis.fetch, restringir,
} = {}) {
  const lido = lerArgumentos(argv);
  if (!lido.ok || lido.opcoes.gmail) { io.err(`Erro: ${lido.erro ?? 'opção desconhecida: --gmail'}\n\n${AJUDA}`); return 1; }
  const o = lido.opcoes;
  if (o.ajuda) { io.out(AJUDA); return 0; }
  if (!o.cliente) { io.err(`Erro: informe o JSON do cliente com --cliente.\n\n${AJUDA}`); return 1; }
  const cliente = lerClienteOAuth(path.resolve(o.cliente));
  if (!cliente.ok) { io.err(`Erro: ${cliente.erro}`); return 1; }
  const saida = path.resolve(o.saida ?? arquivoDaCredencial());
  const enderecos = hosts ?? hostsDoGoogle();
  const pkce = criarPkce();
  const state = crypto.randomBytes(24).toString('hex');
  const servidor = http.createServer();
  const porta = await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(o.porta, '127.0.0.1', () => resolve(servidor.address().port));
  }).catch(() => null);
  if (!porta) { io.err('Erro: não consegui abrir a porta local (127.0.0.1). Tente outra com --porta.'); return 1; }
  const redirectUri = `http://127.0.0.1:${porta}`;

  try {
    const url = montarUrlDeConsentimento({ hosts: enderecos, clientId: cliente.clientId, redirectUri, escopos: [ESCOPO_DO_YOUTUBE], desafio: pkce.desafio, state });
    io.out('Autorização da conta do canal da Yui no YouTube.');
    io.out('ATENÇÃO: entre com a conta (e escolha o canal) DA YUI, não o seu. A permissão deixa ver, editar e apagar coisas desse canal; a Yui só usa o chat ao vivo.');
    io.out('Se o Google mostrar "O Google não verificou este app": é esperado para um app seu. Clique em "Avançado" e em "Acessar ...".');
    io.out('\nAbra este link no navegador e autorize:\n');
    io.out(url);
    io.out('\nEsperando a autorização. O retorno chega só neste computador (127.0.0.1).');
    if (!o.semNavegador) abrir(url);

    const retorno = await esperarRetorno(servidor, { porta, state, tempoS: o.tempoS });
    if (retorno.erro) { io.err(`\nA autorização não foi concluída (${retorno.erro}). Rode o script de novo.`); return 1; }
    const t = await trocarCodigoPorTokens({ hosts: enderecos, fetchImpl, clientId: cliente.clientId, clientSecret: cliente.clientSecret, codigo: retorno.codigo, verificador: pkce.verificador, redirectUri });
    if (!t.ok || !t.refreshToken || !t.accessToken) {
      io.err('\nErro: o Google não entregou a autorização completa. Confira o tipo do cliente ("App para computador"), remova o acesso antigo em https://myaccount.google.com/permissions e rode de novo.');
      return 1;
    }
    if (Array.isArray(t.escopos) && t.escopos.length && !t.escopos.includes(ESCOPO_DO_YOUTUBE)) { io.err('\nErro: a permissão do YouTube não foi marcada. Rode de novo e marque a caixa.'); return 1; }
    const canal = await canalDaConta({ base, token: t.accessToken, fetchImpl });
    if (!canal) { io.err('\nErro: não achei o canal do YouTube dessa conta. Crie o canal, confira se a "YouTube Data API v3" está ativada no projeto e rode de novo.'); return 1; }
    gravarCredencial(saida, { client_id: cliente.clientId, client_secret: cliente.clientSecret, refresh_token: t.refreshToken, canalId: canal.id, canalTitulo: canal.titulo, criadoEm: new Date().toISOString() }, restringir ? { restringir } : undefined);

    io.out(`\nPronto! Canal autorizado: "${canal.titulo}". Confira se é o canal da Yui; se não for, rode de novo e escolha o certo.`);
    io.out(`Gravado em: ${saida}`);
    io.out('(o conteúdo é um SEGREDO e não foi impresso). Siga o guia: docs/GUIA_YOUTUBE_LIVE.md.');
    return 0;
  } catch (err) {
    io.err(`\nErro: ${String(err?.message ?? 'falha inesperada').slice(0, 200)}`);
    return 1;
  } finally {
    try { servidor.close(); servidor.closeAllConnections?.(); } catch { /* */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  autorizar().then((code) => { process.exitCode = code; });
}
