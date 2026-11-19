// Etapa 15: o SCRIPT de autorização única do Google (scripts/google-autorizar.mjs) rodando DE VERDADE (um processo do Node), contra um Google FALSO em 127.0.0.1 aberto por
// este teste (tests/helpers/googleFalso.js). Este teste faz o papel do NAVEGADOR: lê o link de consentimento que o script imprime, "autoriza" no Google falso (que confere o
// PKCE de verdade: sha256(verificador) == desafio) e segue o redirecionamento para o servidor local do script. Cobre:
//  - o link: client_id, redirect_uri em 127.0.0.1, PKCE S256, state, access_type=offline, prompt=consent e SÓ os escopos de leitura (Agenda e Tarefas; o Gmail só com --gmail);
//  - o retorno: só vale com o state certo e o Host certo (um retorno com o state errado não troca nada e não derruba a espera); o código é trocado com o verificador do PKCE;
//  - o arquivo: o cliente, o refresh token e os escopos que o Google CONCEDEU, com a permissão restrita ao dono, gravado de forma atômica (sem temporário), substituindo o anterior;
//  - nunca imprime segredo, código, verificador nem token; ignora o endereço de token que vem dentro do JSON do cliente (só os endereços do endpoints.js valem);
//  - os caminhos de falha: autorização negada, escopo desmarcado, sem refresh token, cliente do tipo errado, tempo esgotado, opções inválidas.
// Os processos filhos rodam sob o bloqueio de integração externa (só o Google falso do teste, em loopback, é alcançável).
// Execução: npm run test:googleautorizar   (node tests/test-google-autorizar.js)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { criarBloqueio } from './helpers/bloqueioExternoTeste.js';
import { criarGoogleFalso, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } from './helpers/googleFalso.js';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-google-autorizar-'));
const SCRIPT = path.join(repoRoot, 'scripts', 'google-autorizar.mjs');

// Os filhos rodam sob o bloqueio de integração externa; as únicas exceções são os programas do Windows que restringem a permissão do arquivo (registro: tests/externos.json).
const BLOQUEIO = criarBloqueio(path.join(tmp, 'bloqueio'), {
  teste: 'test:googleautorizar',
  liberar: {
    'programa:icacls': 'o script restringe a permissão do arquivo de token ao dono (sem rede)',
    'programa:whoami': 'a permissão restrita descobre o usuário atual por SID (sem rede)',
  },
});

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const E = await imp('src/integrations/google/endpoints.js');
const arq = await imp('src/integrations/google/arquivoToken.js');
const cfg = await imp('src/integrations/google/config.js');
const script = await imp('scripts/google-autorizar.mjs');
const { readWindowsAcl, SID_SYSTEM, SID_ADMINISTRATORS, currentUserSid } = await imp('src/database/snapshot.js');

const fake = await criarGoogleFalso();
BLOQUEIO.portaDoTeste(fake.porta);

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 10).join('\n        ')}`);
  }
};
const section = (t) => console.log(`\n${t}`);

let seq = 0;
const pasta = () => { const p = path.join(tmp, `c${++seq}`); fs.mkdirSync(p, { recursive: true }); return p; };
const escreve = (dir, nome, conteudo) => { const f = path.join(dir, nome); fs.writeFileSync(f, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo)); return f; };
/** O JSON do cliente "App para computador" (com um token_uri que NÃO pode ser usado). */
const clienteJson = (dir, extra = {}) => escreve(dir, 'cliente.json', { installed: { client_id: CLIENT_ID, project_id: 'projeto-falso', auth_uri: 'https://auth.evil.example/o', token_uri: 'https://token.evil.example/token', client_secret: CLIENT_SECRET, redirect_uris: ['http://localhost'], ...extra } });
function resetaFalso() {
  fake.limpar();
  Object.assign(fake.estado, { modoToken: 'ok', consentimento: 'ok', escoposDoCodigo: null, semRefreshNaTroca: false });
  fake.estado.codigos.clear();
}
const pedidosToken = () => fake.pedidos.filter((p) => p.caminho === '/token');

/** Abre o script de verdade (handle guardado; só ele é encerrado, nunca por PID achado em varredura). */
const abertos = new Set();
function iniciar(args) {
  const filho = spawn(process.execPath, [...BLOQUEIO.argv, SCRIPT, ...args], {
    cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', YUI_GOOGLE_FALSO_BASE: fake.base, ...BLOQUEIO.env('autorizar') },
  });
  abertos.add(filho);
  const r = { filho, out: '', err: '', fim: null };
  filho.stdout.setEncoding('utf8'); filho.stderr.setEncoding('utf8');
  const ouvintes = new Set();
  filho.stdout.on('data', (d) => { r.out += d; for (const f of ouvintes) f(); });
  filho.stderr.on('data', (d) => { r.err += d; });
  r.fim = new Promise((resolve) => filho.on('close', (code) => { abertos.delete(filho); resolve({ code, out: r.out, err: r.err }); }));
  /** Espera a linha do link de consentimento (a única linha que começa com http). */
  r.url = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`o link não apareceu: ${r.out.slice(0, 300)} ${r.err.slice(0, 300)}`)), 20_000);
    const checa = () => { const m = /^(http\S+)$/m.exec(r.out); if (m) { clearTimeout(timer); ouvintes.delete(checa); resolve(m[1]); } };
    ouvintes.add(checa); checa();
  });
  return r;
}
/** O papel do navegador: abre o link no Google falso (sem seguir o redirecionamento) e segue o Location para o servidor local do script. */
async function navegador(url) {
  const r1 = await fetch(url, { redirect: 'manual' });
  assert.equal(r1.status, 302, `o Google falso recusou o link (${r1.status}): ${await r1.text()}`);
  const destino = r1.headers.get('location');
  const r2 = await fetch(destino);
  return { destino, status: r2.status, texto: await r2.text() };
}
const naoPodeTerSegredo = (r) => {
  const tudo = `${r.out}\n${r.err}`;
  for (const s of [CLIENT_SECRET, REFRESH_TOKEN, 'ya29.', '4/falso-']) assert.ok(!tudo.includes(s), `o script imprimiu um segredo: ${s}`);
  for (const p of pedidosToken()) assert.ok(!tudo.includes(p.campos.code_verifier ?? 'sem-verificador') && !tudo.includes(p.campos.code ?? 'sem-codigo'), 'o script imprimiu o código ou o verificador');
};
const permissaoRestrita = (f) => {
  if (process.platform === 'win32') {
    const acl = readWindowsAcl(f);
    const permitidos = [currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS];
    assert.equal(acl.protected, true, 'a herança de permissões tem de estar cortada');
    assert.ok(acl.aces.length > 0 && acl.aces.every((a) => a.type === 'A' && permitidos.includes(a.sid)), `ACL fora do esperado: ${acl.sddl}`);
  } else assert.equal(fs.statSync(f).mode & 0o777, 0o600);
};

try {
  // ═════════════════════════════════════════════════════════════════════════════════════
  section('A. As peças do script (importadas)');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('os argumentos: obrigatório, opções, valores inválidos e opção desconhecida', () => {
    const ok = script.lerArgumentos(['--cliente', 'c.json', '--gmail', '--sem-navegador', '--porta', '8123', '--tempo', '60', '--saida', 'x.json']);
    assert.deepEqual(ok, { ok: true, opcoes: { cliente: 'c.json', saida: 'x.json', gmail: true, porta: 8123, semNavegador: true, tempoS: 60, ajuda: false } });
    assert.equal(script.lerArgumentos([]).ok, true);
    assert.equal(script.lerArgumentos(['--porta', 'abc']).ok, false);
    assert.equal(script.lerArgumentos(['--porta', '70000']).ok, false);
    assert.equal(script.lerArgumentos(['--tempo', '1']).ok, false);
    assert.equal(script.lerArgumentos(['--cliente']).ok, false);
    assert.equal(script.lerArgumentos(['--cliente', '--gmail']).ok, false);
    assert.equal(script.lerArgumentos(['--apagar-tudo']).ok, false);
  });

  await test('o PKCE: verificador aleatório (43 a 128 caracteres) e desafio = base64url(sha256(verificador)); nunca repete', () => {
    const a = script.criarPkce(); const b = script.criarPkce();
    assert.match(a.verificador, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(a.desafio, crypto.createHash('sha256').update(a.verificador).digest('base64url'));
    assert.notEqual(a.verificador, b.verificador);
  });

  await test('o JSON do cliente: só o tipo "App para computador"; o da Web, o quebrado e o sem campos são recusados com uma mensagem útil (sem repetir o conteúdo)', () => {
    const d = pasta();
    assert.deepEqual(script.lerClienteOAuth(clienteJson(d)), { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    assert.match(script.lerClienteOAuth(escreve(d, 'web.json', { web: { client_id: 'x', client_secret: 'y' } })).erro, /Aplicativo da Web.*App para computador/);
    assert.match(script.lerClienteOAuth(escreve(d, 'ruim.json', '{{{')).erro, /JSON/);
    assert.match(script.lerClienteOAuth(escreve(d, 'vazio.json', { installed: { client_id: 'x' } })).erro, /client_id e client_secret/);
    assert.match(script.lerClienteOAuth(path.join(d, 'nao-existe.json')).erro, /não achei/);
    const r = script.lerClienteOAuth(escreve(d, 'segredo.json', { installed: { client_id: '', client_secret: 'SEGREDO-NO-ARQUIVO-RUIM' } }));
    assert.ok(!JSON.stringify(r).includes('SEGREDO-NO-ARQUIVO-RUIM'));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('B. O script de verdade: o fluxo completo');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('fluxo completo: o link certo (PKCE, state, só leitura), o retorno em 127.0.0.1, a troca com o verificador e o arquivo restrito e atômico, sem imprimir segredo', async () => {
    resetaFalso();
    const d = pasta();
    const saida = path.join(d, 'sub', 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    const url = await r.url();
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, `${fake.base}/o/oauth2/v2/auth`, 'o endereço vem do endpoints.js (o auth_uri do JSON é ignorado)');
    const q = Object.fromEntries(u.searchParams.entries());
    assert.equal(q.client_id, CLIENT_ID);
    assert.equal(q.response_type, 'code');
    assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.state, /^[0-9a-f]{48}$/);
    assert.equal(q.access_type, 'offline');
    assert.equal(q.prompt, 'consent');
    assert.deepEqual(q.scope.split(' '), [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], 'Agenda e Tarefas, só leitura; sem Gmail por padrão');
    assert.ok(!q.client_secret && !url.includes(CLIENT_SECRET), 'o segredo do cliente não vai no link');
    const nav = await navegador(url);
    assert.equal(nav.status, 200);
    assert.match(nav.texto, /Pronto/);
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    // a troca: uma só, com o verificador que casa com o desafio do link, o cliente e o mesmo redirect_uri
    assert.equal(pedidosToken().length, 1);
    const c = pedidosToken()[0].campos;
    assert.equal(c.grant_type, 'authorization_code');
    assert.equal(c.client_id, CLIENT_ID);
    assert.equal(c.client_secret, CLIENT_SECRET);
    assert.equal(c.redirect_uri, q.redirect_uri);
    assert.equal(crypto.createHash('sha256').update(c.code_verifier).digest('base64url'), q.code_challenge);
    // o arquivo
    const lido = arq.lerArquivoDeToken(saida);
    assert.equal(lido.ok, true);
    assert.equal(lido.dados.refresh_token, REFRESH_TOKEN);
    assert.equal(lido.dados.client_id, CLIENT_ID);
    assert.equal(lido.dados.client_secret, CLIENT_SECRET);
    assert.deepEqual(lido.dados.escopos, [E.ESCOPOS.agenda, E.ESCOPOS.tarefas]);
    assert.ok(Date.now() - Date.parse(lido.dados.criadoEm) < 60_000);
    permissaoRestrita(saida);
    assert.deepEqual(fs.readdirSync(path.dirname(saida)), ['google-token.json'], 'nada de temporário sobrando');
    // o que o script diz
    naoPodeTerSegredo(fim);
    assert.match(fim.out, /Pronto! A autorização foi gravada em:/);
    assert.match(fim.out, /Copie esse arquivo para o servidor/);
    assert.match(fim.out, /YUI_GOOGLE=true/);
    assert.match(fim.out, /não verificou este app/);
    assert.match(fim.out, /Avançado/);
    assert.match(fim.out, /APAGUE o arquivo/);
    assert.match(fim.out, /7 dias/);
    assert.equal(fs.existsSync(path.join(tmp, 'logs')), false, 'o script é leve: não carrega o log da Yui (nem cria a pasta logs/)');
    BLOQUEIO.conferir('fluxo completo');
  });

  await test('o retorno só vale com o STATE certo e o Host certo: um retorno forjado não troca nada, não derruba a espera e o fluxo certo termina depois', async () => {
    resetaFalso();
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    const url = await r.url();
    const q = Object.fromEntries(new URL(url).searchParams.entries());
    const redir = q.redirect_uri;
    const porta = Number(new URL(redir).port);
    const forjado = await fetch(`${redir}/?code=4/FORJADO-0123456789&state=estado-errado`);
    assert.equal(forjado.status, 400, 'state errado');
    assert.equal((await fetch(`${redir}/?code=4/FORJADO-0123456789`)).status, 400, 'sem state');
    assert.equal((await fetch(`${redir}/outra-rota?code=4/FORJADO-0123456789&state=${q.state}`)).status, 404, 'outra rota');
    const hostErrado = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: porta, path: `/?code=4/FORJADO-0123456789&state=${q.state}`, headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostErrado, 400, 'Host de outro nome (DNS rebinding)');
    const postado = await fetch(`${redir}/`, { method: 'POST', body: '{}' });
    assert.equal(postado.status, 400, 'só GET');
    assert.equal(pedidosToken().length, 0, 'nenhum retorno forjado chegou a trocar um código');
    assert.equal(fs.existsSync(saida), false);
    // o retorno VERDADEIRO ainda é aceito
    const nav = await navegador(url);
    assert.equal(nav.status, 200);
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    assert.equal(pedidosToken().length, 1);
    assert.ok(!pedidosToken()[0].campos.code.includes('FORJADO'));
    assert.equal(arq.lerArquivoDeToken(saida).ok, true);
    BLOQUEIO.conferir('state e host');
  });

  await test('--gmail acrescenta o escopo do Gmail (só leitura) e o arquivo guarda o que o Google concedeu; o endereço de token do JSON do cliente é IGNORADO (nenhuma conexão a ele)', async () => {
    resetaFalso();
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador', '--gmail']);
    const url = await r.url();
    assert.deepEqual(new URL(url).searchParams.get('scope').split(' '), [E.ESCOPOS.agenda, E.ESCOPOS.tarefas, E.ESCOPOS.gmail]);
    await navegador(url);
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    assert.deepEqual(arq.lerArquivoDeToken(saida).dados.escopos, [E.ESCOPOS.agenda, E.ESCOPOS.tarefas, E.ESCOPOS.gmail]);
    assert.match(fim.out, /rota privada de IA validada/, 'avisa que o Gmail só funciona com a rota privada');
    BLOQUEIO.conferir('gmail e token_uri do JSON'); // qualquer conexão a token.evil.example ou auth.evil.example teria ficado registrada e falharia aqui
  });

  await test('substitui o arquivo anterior de forma atômica (o velho some inteiro, sem temporário)', async () => {
    resetaFalso();
    const d = pasta();
    const saida = escreve(d, 'google-token.json', 'CONTEÚDO ANTIGO QUE NÃO É JSON');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    await navegador(await r.url());
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    assert.equal(arq.lerArquivoDeToken(saida).ok, true);
    assert.ok(!fs.readFileSync(saida, 'utf8').includes('ANTIGO'));
    assert.deepEqual(fs.readdirSync(d).sort(), ['cliente.json', 'google-token.json']);
    permissaoRestrita(saida);
    BLOQUEIO.conferir('substituição');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('C. Os caminhos de falha');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('autorização NEGADA no Google: o script diz, sai com erro, não troca nada e não grava arquivo', async () => {
    resetaFalso(); fake.estado.consentimento = 'negar';
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    const nav = await navegador(await r.url());
    assert.equal(nav.status, 200);
    const fim = await r.fim;
    assert.equal(fim.code, 1);
    assert.match(fim.err, /não foi concluída \(access_denied\)/);
    assert.equal(pedidosToken().length, 0);
    assert.equal(fs.existsSync(saida), false);
    BLOQUEIO.conferir('negada');
  });

  await test('o Google concede MENOS escopos (uma caixa desmarcada): grava só o que foi concedido e AVISA qual recurso falta', async () => {
    resetaFalso(); fake.estado.escoposDoCodigo = [E.ESCOPOS.tarefas];
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    await navegador(await r.url());
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    assert.deepEqual(arq.lerArquivoDeToken(saida).dados.escopos, [E.ESCOPOS.tarefas]);
    assert.match(fim.out, /NÃO concedeu a permissão deste recurso: a Agenda/);
    BLOQUEIO.conferir('escopo desmarcado');
  });

  await test('o Google não devolve o refresh token: erro claro, sem arquivo', async () => {
    resetaFalso(); fake.estado.semRefreshNaTroca = true;
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador']);
    await navegador(await r.url());
    const fim = await r.fim;
    assert.equal(fim.code, 1);
    assert.match(fim.err, /refresh token/);
    assert.equal(fs.existsSync(saida), false);
    naoPodeTerSegredo(fim);
  });

  await test('cliente errado: o Google recusa a troca (invalid_client) e o script explica sem imprimir o segredo; o JSON do tipo Web e o arquivo ausente nem chegam ao Google', async () => {
    resetaFalso();
    const d = pasta();
    const r = iniciar(['--cliente', clienteJson(d, { client_secret: 'SEGREDO-DE-OUTRO-CLIENTE' }), '--saida', path.join(d, 'x.json'), '--sem-navegador']);
    const url = await r.url();
    // o Google falso só conhece o client_id certo; o do arquivo (o mesmo id) com outro segredo falha na TROCA
    await navegador(url);
    const fim = await r.fim;
    assert.equal(fim.code, 1);
    assert.match(fim.err, /invalid_client/);
    assert.ok(!`${fim.out}${fim.err}`.includes('SEGREDO-DE-OUTRO-CLIENTE'));
    assert.equal(fs.existsSync(path.join(d, 'x.json')), false);
    fake.limpar();
    const web = iniciar(['--cliente', escreve(d, 'web.json', { web: { client_id: 'a', client_secret: 'b' } }), '--sem-navegador']);
    const fw = await web.fim;
    assert.equal(fw.code, 1);
    assert.match(fw.err, /App para computador/);
    const ausente = iniciar(['--cliente', path.join(d, 'nao-existe.json')]);
    assert.equal((await ausente.fim).code, 1);
    assert.equal(fake.pedidos.length, 0, 'nada disso chegou ao Google');
  });

  await test('tempo esgotado sem a autorização: erro claro, sem arquivo e o servidor local fecha (o processo termina sozinho)', async () => {
    resetaFalso();
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida, '--sem-navegador', '--tempo', '5']);
    await r.url();
    const t0 = Date.now();
    const fim = await r.fim;
    assert.equal(fim.code, 1);
    assert.match(fim.err, /o tempo acabou/);
    assert.ok(Date.now() - t0 < 15_000);
    assert.equal(fs.existsSync(saida), false);
  });

  await test('opções: --ajuda (sai com 0), sem --cliente e opção desconhecida (saem com 1 e mostram a ajuda); nada chega ao Google', async () => {
    resetaFalso();
    const ajuda = await iniciar(['--ajuda']).fim;
    assert.equal(ajuda.code, 0);
    assert.match(ajuda.out, /Uso:/);
    const sem = await iniciar([]).fim;
    assert.equal(sem.code, 1);
    assert.match(sem.err, /--cliente/);
    const desconhecida = await iniciar(['--cliente', 'x.json', '--facao']).fim;
    assert.equal(desconhecida.code, 1);
    assert.match(desconhecida.err, /opção desconhecida/);
    assert.equal(fake.pedidos.length, 0);
  });

  await test('sem --sem-navegador o script TENTA abrir o navegador (aqui o bloqueio impede o programa e fica registrado), mas o link já está impresso e o fluxo segue', async () => {
    resetaFalso();
    const d = pasta();
    const saida = path.join(d, 'google-token.json');
    const r = iniciar(['--cliente', clienteJson(d), '--saida', saida]);
    const url = await r.url();
    await navegador(url);
    const fim = await r.fim;
    assert.equal(fim.code, 0, `${fim.out}\n${fim.err}`);
    assert.equal(arq.lerArquivoDeToken(saida).ok, true);
    const tentativas = BLOQUEIO.conferir('abrir o navegador', { esperados: [{ tipo: 'processo', alvo: /rundll32|xdg-open|open/, motivo: 'o script tenta abrir o navegador padrão sem shell' }] });
    assert.equal(tentativas.length, 1);
  });

  await test('o caminho padrão do arquivo é secrets/google-token.json (pasta ignorada pelo git) e é o que a Yui lê', () => {
    assert.equal(cfg.arquivoDoTokenPadrao(), path.join(repoRoot, 'secrets', 'google-token.json'));
    assert.equal(cfg.arquivoDoToken({}), cfg.arquivoDoTokenPadrao());
    assert.match(fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), /^secrets\/$/m);
  });

  await test('nenhuma tentativa de integração externa em todo o teste (só o Google falso em loopback) e nenhum processo do script sobrou', () => {
    BLOQUEIO.conferir('fim');
    assert.equal(abertos.size, 0);
    const usos = BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ');
    console.log(`  exceções declaradas: ${usos}`);
  });

  console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
} finally {
  for (const f of abertos) { try { f.kill(); } catch { /* */ } }
  try { await fake.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
