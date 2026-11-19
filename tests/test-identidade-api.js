// Testes da PROVA DE IDENTIDADE do servidor da Yui para o app: a rota pública GET /v1/identidade (assinatura Ed25519 de um desafio, com a chave PRIVADA que só o servidor
// tem), o gerador da identidade (scripts/gerar-identidade-yui.mjs) e as garantias de sigilo (a chave privada nunca vai no corpo, em log nem no repositório).
// Num processo só, servidor em 127.0.0.1:porta aleatória, banco/auditoria/logs em pasta temporária, chaves geradas por execução. Execução: npm run test:identidadeapi
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);
const raiz = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-identidade-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
delete process.env.YUI_API_IDENTIDADE_ARQUIVO;
process.chdir(tmp); // o logger grava em ./logs (relativo ao cwd): nada vai para os logs reais da Yui
// Mesmo se um teste falhar no meio, a pasta temporária (com as chaves geradas só para esta execução) não fica para trás.
process.on('exit', () => { try { process.chdir(raiz); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sobra em %TEMP%: inofensiva */ } });

const { createApiServer, parseTokens, startApi } = await import('../src/core/api/server.js');
const { criarIdentidade, criarLimitadorPorOrigem, lerIdentidade, arquivoDaIdentidade, assinarIdentidade, PREFIXO_IDENTIDADE, LIMITE_IDENTIDADE } = await import('../src/core/api/identidade.js');
const { gerarIdentidade, publicaDoArquivo, chavePublicaBase64 } = await import('../scripts/gerar-identidade-yui.mjs');
const { allowedSecretSids } = await import('../src/core/channel/secret.js');
const { readWindowsAcl } = await import('../src/database/snapshot.js');
const { logger } = await import('../src/utils/logger.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const TOKEN = 'token-do-teste-0123456789';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ───────────────────────── ajudantes ─────────────────────────

/** Gera uma identidade NOVA (par Ed25519) num arquivo da pasta temporária. Devolve o caminho, a chave pública (KeyObject e base64) e os pedaços SECRETOS (para provar que não vazam). */
function novaIdentidade(nome) {
  const arquivo = path.join(tmp, `${nome}.key`);
  const { publica } = gerarIdentidade({ arquivo });
  const privada = crypto.createPrivateKey(fs.readFileSync(arquivo, 'utf8'));
  const publicKey = crypto.createPublicKey(privada);
  const semente = Buffer.from(privada.export({ format: 'jwk' }).d, 'base64url');
  const pem = fs.readFileSync(arquivo, 'utf8');
  const segredos = [
    semente.toString('hex'), semente.toString('base64'), semente.toString('base64url'),
    pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), // o corpo do PEM (a chave inteira em base64)
    privada.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  ];
  return { arquivo, publica, publicKey, segredos };
}

// O texto assinado é escrito AQUI, por extenso (e não lido do módulo do servidor): o app e o servidor combinam este texto, e o teste não pode seguir uma mudança por engano.
const PREFIXO = 'yui-identidade-v1|';
const verifica = (publicKey, nonce, assinatura) => crypto.verify(null, Buffer.from(PREFIXO + nonce, 'utf8'), publicKey, Buffer.from(assinatura, 'base64'));
const nonceNovo = () => crypto.randomBytes(32).toString('hex');

async function abrir(opcoes = {}) {
  const server = createApiServer({ tokens: parseTokens(`${TOKEN}=111`), ...opcoes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (rota, { method = 'GET', token, headers = {} } = {}) => {
    const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* não é JSON */ }
    return { status: res.status, json, texto, headers: Object.fromEntries(res.headers) };
  };
  return { server, base, chamar, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Captura tudo o que o processo escreve (logger, console, stdout e stderr) enquanto `fn` roda. */
async function capturando(fn) {
  const linhas = [];
  const restaurar = [];
  for (const nivel of ['error', 'warn', 'info', 'debug', 'verbose', 'silly', 'log']) {
    const original = logger[nivel];
    logger[nivel] = (...a) => { linhas.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    restaurar.push(() => { logger[nivel] = original; });
  }
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[nivel];
    console[nivel] = (...a) => { linhas.push(a.map(String).join(' ')); };
    restaurar.push(() => { console[nivel] = original; });
  }
  for (const fluxo of [process.stdout, process.stderr]) {
    const original = fluxo.write;
    fluxo.write = (chunk, ...resto) => { linhas.push(String(chunk)); const cb = resto.find((r) => typeof r === 'function'); if (cb) cb(); return true; };
    restaurar.push(() => { fluxo.write = original; });
  }
  try {
    const retorno = await fn();
    return { retorno, saida: linhas.join('\n') };
  } finally {
    for (const r of restaurar.reverse()) r();
  }
}

console.log('Prova de identidade do servidor (Ed25519)');

// ───────────────────────── a rota desligada ─────────────────────────

await test('sem o arquivo da chave a rota está DESLIGADA: 404, sem token, mesmo com nonce válido; o /v1/health continua igual', async () => {
  const sem = await abrir(); // padrão do createApiServer: sem identidade
  const naoExiste = await abrir({ identidade: criarIdentidade({ arquivo: path.join(tmp, 'nao-existe.key') }) });
  try {
    for (const a of [sem, naoExiste]) {
      for (const rota of [`/v1/identidade?nonce=${nonceNovo()}`, '/v1/identidade', '/v1/identidade?nonce=curto']) {
        const r = await a.chamar(rota);
        assert.equal(r.status, 404, rota);
        assert.deepEqual(r.json, { error: 'rota não encontrada' });
      }
      assert.equal((await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`, { method: 'POST' })).status, 404);
      const h = await a.chamar('/v1/health');
      assert.equal(h.status, 200);
      assert.equal(h.json.ok, true);
      assert.equal('assinatura' in h.json || 'identidade' in h.json, false, 'o health não anuncia a prova');
      assert.equal((await a.chamar('/v1/me')).status, 401, 'as outras rotas continuam exigindo token');
    }
  } finally { await sem.fechar(); await naoExiste.fechar(); }
  const i = criarIdentidade({ arquivo: path.join(tmp, 'nao-existe.key'), env: {} });
  assert.deepEqual([i.ativa, i.aviso], [false, null], 'caminho padrão sem arquivo: só desligada, sem aviso');
});

await test('arquivo ausente num caminho que o dono configurou, arquivo ilegível ou que não é Ed25519: desligada, com um aviso que não traz o conteúdo nem o caminho', async () => {
  const configurado = criarIdentidade({ arquivo: path.join(tmp, 'sumiu.key'), env: { YUI_API_IDENTIDADE_ARQUIVO: path.join(tmp, 'sumiu.key') } });
  assert.equal(configurado.ativa, false);
  assert.match(configurado.aviso, /YUI_API_IDENTIDADE_ARQUIVO aponta para um arquivo que não existe/);
  assert.equal(configurado.aviso.includes(tmp), false);

  const lixo = path.join(tmp, 'lixo.key');
  fs.writeFileSync(lixo, 'SEGREDO-PLANTADO-NO-ARQUIVO-123 isto não é uma chave');
  const rsa = path.join(tmp, 'rsa.key');
  fs.writeFileSync(rsa, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const vazio = path.join(tmp, 'vazio.key');
  fs.writeFileSync(vazio, '');
  for (const arquivo of [lixo, rsa, vazio, tmp /* uma pasta */]) {
    const r = criarIdentidade({ arquivo });
    assert.equal(r.ativa, false, arquivo);
    assert.ok(r.aviso && /desligada/.test(r.aviso), 'avisa que ficou desligada');
    assert.equal(r.aviso.includes('SEGREDO-PLANTADO'), false, 'o aviso não repete o conteúdo do arquivo');
    assert.equal(r.aviso.includes(tmp), false, 'nem o caminho');
    assert.equal(r.responder({ method: 'GET', searchParams: new URLSearchParams(`nonce=${nonceNovo()}`), origem: 'x' }).status, 404);
  }
  assert.equal(lerIdentidade({ arquivo: lixo }).privada, null);
});

await test('o texto assinado é o combinado com o app: yui-identidade-v1| + o nonce', () => {
  assert.equal(PREFIXO_IDENTIDADE, 'yui-identidade-v1|');
});

await test('o caminho padrão é secrets/identidade-yui.key (pasta ignorada pelo git) e YUI_API_IDENTIDADE_ARQUIVO o troca', () => {
  assert.equal(path.relative(raiz, arquivoDaIdentidade({})).replaceAll('\\', '/'), 'secrets/identidade-yui.key');
  assert.equal(arquivoDaIdentidade({ YUI_API_IDENTIDADE_ARQUIVO: '  ' }), arquivoDaIdentidade({}));
  assert.equal(arquivoDaIdentidade({ YUI_API_IDENTIDADE_ARQUIVO: path.join(tmp, 'outra.key') }), path.join(tmp, 'outra.key'));
  const ignorado = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignorado.includes('secrets/'), 'secrets/ está no .gitignore');
});

// ───────────────────────── a rota ligada ─────────────────────────

const id1 = novaIdentidade('principal');
const id2 = novaIdentidade('outra');

await test('ligada: devolve { ok, assinatura } com a assinatura Ed25519 do desafio, verificável SÓ com a chave pública desta identidade', async () => {
  const a = await abrir({ identidade: criarIdentidade({ arquivo: id1.arquivo }) });
  try {
    for (const nonce of [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(24).toString('hex'), nonceNovo(), nonceNovo().toUpperCase()]) {
      const r = await a.chamar(`/v1/identidade?nonce=${nonce}`); // sem token
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['assinatura', 'ok']);
      assert.equal(r.json.ok, true);
      assert.match(r.json.assinatura, /^[A-Za-z0-9+/]{86}==$/, 'base64 de 64 bytes');
      assert.equal(verifica(id1.publicKey, nonce, r.json.assinatura), true, 'a chave pública confere a assinatura');
      assert.equal(verifica(id2.publicKey, nonce, r.json.assinatura), false, 'outra chave pública não confere');
      assert.equal(r.headers['cache-control'], 'no-store');
      const outra = await a.chamar(`/v1/identidade?nonce=${nonce}&extra=1`);
      assert.equal(outra.json.assinatura, r.json.assinatura, 'determinística: o mesmo desafio, a mesma assinatura (e parâmetros a mais são ignorados)');
    }
    // a assinatura de um nonce não vale para outro
    const n1 = nonceNovo();
    const n2 = nonceNovo();
    const s1 = (await a.chamar(`/v1/identidade?nonce=${n1}`)).json.assinatura;
    const s2 = (await a.chamar(`/v1/identidade?nonce=${n2}`)).json.assinatura;
    assert.notEqual(s1, s2);
    assert.equal(verifica(id1.publicKey, n2, s1), false);
    assert.equal(verifica(id1.publicKey, n1, s2), false);
    // o texto assinado leva o prefixo: a assinatura do nonce "cru" não passa
    assert.equal(crypto.verify(null, Buffer.from(n1, 'utf8'), id1.publicKey, Buffer.from(s1, 'base64')), false);
    // um bit trocado na assinatura devolvida não confere
    const adulterada = Buffer.from(s1, 'base64');
    adulterada[7] ^= 1;
    assert.equal(verifica(id1.publicKey, n1, adulterada.toString('base64')), false);
    // sem token e com token inválido a resposta é a mesma: a rota é pública
    assert.equal((await a.chamar(`/v1/identidade?nonce=${n1}`, { token: 'token-errado-0123456789' })).json.assinatura, s1);
  } finally { await a.fechar(); }
});

await test('nonce inválido (ausente, curto, longo, não hexadecimal, repetido, com espaço) é 400 e nunca vira assinatura; outro método é 405', async () => {
  const a = await abrir({ identidade: criarIdentidade({ arquivo: id1.arquivo, limitador: criarLimitadorPorOrigem({ max: 1000 }) }) });
  try {
    const ruins = [
      '/v1/identidade', '/v1/identidade?nonce=', '/v1/identidade?nonce=abc',
      `/v1/identidade?nonce=${'a'.repeat(31)}`, `/v1/identidade?nonce=${'a'.repeat(65)}`, `/v1/identidade?nonce=${'g'.repeat(32)}`,
      `/v1/identidade?nonce=0x${'a'.repeat(32)}`, `/v1/identidade?nonce=${'a'.repeat(31)}%20`, `/v1/identidade?nonce=%20${'a'.repeat(32)}`,
      `/v1/identidade?nonce=${'a'.repeat(32)}&nonce=${'b'.repeat(32)}`, `/v1/identidade?nonce=${'a'.repeat(32)}&nonce=`, `/v1/identidade?Nonce=${'a'.repeat(32)}`,
      `/v1/identidade?nonce=${'%C3%A9'.repeat(16)}`, `/v1/identidade?nonce=${'a'.repeat(31)}%00`,
    ];
    for (const rota of ruins) {
      const r = await a.chamar(rota);
      assert.equal(r.status, 400, rota);
      assert.deepEqual(r.json, { error: 'nonce inválido' }, rota);
    }
    for (const nonce of ['a'.repeat(32), 'A'.repeat(64), '0123456789abcdefABCDEF0123456789']) assert.equal((await a.chamar(`/v1/identidade?nonce=${nonce}`)).status, 200, nonce);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`, { method })).status, 405, method);
  } finally { await a.fechar(); }
});

await test('a rota pública NÃO conta como token inválido (não trava o app) e não abre nenhuma outra rota sem token', async () => {
  const a = await abrir({ identidade: criarIdentidade({ arquivo: id1.arquivo, limitador: criarLimitadorPorOrigem({ max: 1000 }) }) });
  try {
    for (let i = 0; i < 25; i += 1) assert.equal((await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`)).status, 200);
    const me = await a.chamar('/v1/me', { token: TOKEN });
    assert.equal(me.status, 200, 'o token válido continua passando depois de muitas provas');
    assert.equal((await a.chamar('/v1/me')).status, 401);
    assert.equal((await a.chamar('/v1/identidade/outra')).status, 401, 'o resto continua exigindo token');
  } finally { await a.fechar(); }
});

// ───────────────────────── limite de repetição ─────────────────────────

await test('limite de repetição por origem: passou do limite, 429 com Retry-After e sem assinatura; outra origem não é afetada', async () => {
  assert.deepEqual(LIMITE_IDENTIDADE, { max: 30, windowMs: 60_000 });
  const a = await abrir({ identidade: criarIdentidade({ arquivo: id1.arquivo, limitador: criarLimitadorPorOrigem({ max: 3, windowMs: 60_000 }) }) });
  try {
    const de = (ip) => ({ headers: { 'X-Forwarded-For': ip } }); // atrás do tailscale serve a origem real vem neste cabeçalho (a conexão é do 127.0.0.1)
    for (let i = 0; i < 3; i += 1) assert.equal((await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`, de('10.0.0.1'))).status, 200);
    const barrado = await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`, de('10.0.0.1'));
    assert.equal(barrado.status, 429);
    assert.equal(barrado.json.assinatura, undefined, 'barrado não recebe assinatura');
    assert.ok(Number(barrado.headers['retry-after']) >= 1, 'Retry-After em segundos');
    assert.equal(barrado.json.retryAfter, Number(barrado.headers['retry-after']));
    assert.equal((await a.chamar('/v1/identidade?nonce=curto', de('10.0.0.1'))).status, 429, 'o pedido ruim também é barrado (o limite vem antes da validação)');
    assert.equal((await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`, de('10.0.0.2'))).status, 200, 'outra origem tem a cota dela');
    assert.equal((await a.chamar('/v1/me', { ...de('10.0.0.1'), token: TOKEN })).status, 200, 'o limite é só da prova: o resto da API segue');
  } finally { await a.fechar(); }
});

await test('o limitador é uma janela deslizante por origem, com tamanho limitado', () => {
  let agora = 1_000;
  const l = criarLimitadorPorOrigem({ max: 2, windowMs: 1000, now: () => agora, maxOrigens: 3 });
  assert.equal(l.tentar('a').ok, true);
  assert.equal(l.tentar('a').ok, true);
  const barrado = l.tentar('a');
  assert.deepEqual([barrado.ok, barrado.retryAfter], [false, 1]);
  agora += 999;
  assert.equal(l.tentar('a').ok, false, 'ainda dentro da janela');
  agora += 1;
  assert.equal(l.tentar('a').ok, true, 'a janela passou');
  // memória limitada: com 3 origens no máximo, a mais antiga sai e começa de novo
  const m = criarLimitadorPorOrigem({ max: 1, windowMs: 60_000, now: () => agora, maxOrigens: 3 });
  for (const o of ['a', 'b', 'c', 'd', 'e']) assert.equal(m.tentar(o).ok, true);
  assert.equal(m.tentar('e').ok, false, 'a mais recente continua limitada');
  assert.equal(m.tentar('a').ok, true, 'a mais antiga foi esquecida (memória limitada)');
});

// ───────────────────────── sigilo da chave privada ─────────────────────────

await test('a chave privada NUNCA aparece no corpo, nos cabeçalhos nem no log (subida da API, pedidos bons, ruins e barrados)', async () => {
  const { saida, retorno } = await capturando(async () => {
    const respostas = [];
    const a = await abrir({ identidade: criarIdentidade({ arquivo: id1.arquivo, limitador: criarLimitadorPorOrigem({ max: 4 }) }) });
    try {
      for (let i = 0; i < 4; i += 1) respostas.push(await a.chamar(`/v1/identidade?nonce=${nonceNovo()}`));
      respostas.push(await a.chamar('/v1/identidade?nonce=curto'), await a.chamar('/v1/identidade', { method: 'POST' }), await a.chamar('/v1/health'));
    } finally { await a.fechar(); }
    // a subida de verdade (startApi) com a chave e com um arquivo estragado
    Object.assign(process.env, { YUI_API_ENABLED: 'true', YUI_API_TOKENS: `${TOKEN}=111`, YUI_API_HOST: '127.0.0.1', YUI_API_PORT: '0' });
    for (const arquivo of [id1.arquivo, path.join(tmp, 'lixo.key')]) {
      process.env.YUI_API_IDENTIDADE_ARQUIVO = arquivo;
      const server = startApi(null, { approvalChannel: false });
      await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
      respostas.push(await (await fetch(`http://127.0.0.1:${server.address().port}/v1/identidade?nonce=${nonceNovo()}`)).text());
      await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    }
    for (const k of ['YUI_API_IDENTIDADE_ARQUIVO', 'YUI_API_ENABLED', 'YUI_API_TOKENS', 'YUI_API_HOST', 'YUI_API_PORT']) delete process.env[k];
    return respostas;
  });
  const tudo = `${saida}\n${JSON.stringify(retorno)}`;
  for (const segredo of id1.segredos) assert.equal(tudo.includes(segredo), false, `um pedaço da chave privada vazou: ${segredo.slice(0, 12)}…`);
  assert.equal(/PRIVATE KEY/.test(tudo), false);
  assert.match(saida, /prova de identidade ATIVA/, 'a subida diz que a prova está ligada');
  assert.match(saida, /prova de identidade desligada/, '…e, com o arquivo estragado, que ficou desligada');
  assert.match(saida, /não tem uma chave privada Ed25519 válida/);
  assert.equal(saida.includes('SEGREDO-PLANTADO'), false, 'o conteúdo do arquivo estragado não vai para o log');
});

// ───────────────────────── o gerador da identidade ─────────────────────────

await test('o gerador grava a chave privada com a permissão restrita ao dono e devolve SÓ a chave pública (a que vai no build do app)', () => {
  const arquivo = path.join(tmp, 'gerada.key');
  const r = gerarIdentidade({ arquivo });
  assert.deepEqual(Object.keys(r).sort(), ['arquivo', 'publica']);
  const bruta = Buffer.from(r.publica, 'base64');
  assert.equal(bruta.length, 32, 'a pública crua tem 32 bytes');
  assert.equal(r.publica, publicaDoArquivo(arquivo));
  const privada = crypto.createPrivateKey(fs.readFileSync(arquivo, 'utf8'));
  assert.equal(privada.asymmetricKeyType, 'ed25519');
  assert.equal(chavePublicaBase64(crypto.createPublicKey(privada)), r.publica);
  const seed = Buffer.from(privada.export({ format: 'jwk' }).d, 'base64url');
  const dados = JSON.stringify(r);
  for (const forma of [seed.toString('hex'), seed.toString('base64'), seed.toString('base64url')]) assert.equal(dados.includes(forma), false, 'a privada não volta no retorno');
  assert.equal(/PRIVATE/.test(dados), false);
  // a assinatura da rota confere com a pública que o gerador devolveu
  const nonce = nonceNovo();
  const i = lerIdentidade({ arquivo });
  assert.ok(i.privada);
  assert.equal(verifica(crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bruta]), format: 'der', type: 'spki' }), nonce, assinarIdentidade(i.privada, nonce)), true);
  // permissão restrita ao dono (a mesma regra do segredo do canal local)
  if (process.platform === 'win32') {
    const acl = readWindowsAcl(arquivo);
    const permitidos = allowedSecretSids();
    assert.equal(acl.protected, true, 'sem herança');
    assert.deepEqual([...new Set(acl.aces.map((a) => a.sid))].sort(), [...permitidos].sort(), 'só o usuário, o SYSTEM e os Administradores');
    assert.ok(acl.aces.every((a) => a.type === 'A' && !a.flags.includes('ID')));
  } else {
    assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(`${arquivo}.novo`), false, 'não sobra arquivo temporário');
});

await test('nunca sobrescreve uma identidade existente sem --forcar; com forcar troca por uma NOVA; se a restrição falhar nada é gravado e a antiga continua', () => {
  const arquivo = path.join(tmp, 'protegida.key');
  const primeira = gerarIdentidade({ arquivo });
  const antes = sha(fs.readFileSync(arquivo));
  assert.throws(() => gerarIdentidade({ arquivo }), (e) => e.codigo === 'JA_EXISTE' && /--forcar/.test(e.message));
  assert.equal(sha(fs.readFileSync(arquivo)), antes, 'o arquivo ficou byte a byte igual');
  assert.equal(publicaDoArquivo(arquivo), primeira.publica);
  // a restrição falha: nada é gravado, nem o arquivo temporário, e a identidade antiga continua valendo
  assert.throws(() => gerarIdentidade({ arquivo, forcar: true, restrict: () => { throw new Error('icacls falhou'); } }), /nada foi gravado/);
  assert.equal(sha(fs.readFileSync(arquivo)), antes);
  assert.equal(fs.existsSync(`${arquivo}.novo`), false);
  const nova = path.join(tmp, 'so-nova.key');
  assert.throws(() => gerarIdentidade({ arquivo: nova, restrict: () => { throw new Error('icacls falhou'); } }), /nada foi gravado/);
  assert.equal(fs.existsSync(nova) || fs.existsSync(`${nova}.novo`), false, 'sem restrição não nasce arquivo nenhum');
  // com forcar: outra identidade
  const trocada = gerarIdentidade({ arquivo, forcar: true });
  assert.notEqual(trocada.publica, primeira.publica);
  assert.notEqual(sha(fs.readFileSync(arquivo)), antes);
  assert.equal(publicaDoArquivo(arquivo), trocada.publica);
  assert.equal(fs.existsSync(`${arquivo}.novo`), false);
  assert.throws(() => gerarIdentidade({}), /informe o arquivo/);
});

await test('o script de linha de comando: a saída padrão é SÓ a chave pública, as mensagens vão para o erro, não sobrescreve sem --forcar e --publica mostra de novo', async () => {
  const arquivo = path.join(tmp, 'cli.key');
  const roda = (...args) => run(process.execPath, [...process.execArgv, 'scripts/gerar-identidade-yui.mjs', ...args], { cwd: raiz, env: { ...process.env, YUI_API_IDENTIDADE_ARQUIVO: '' } });
  const ok = await roda(`--arquivo=${arquivo}`);
  assert.match(ok.stdout, /^[A-Za-z0-9+/]{43}=\n$/, 'só a pública (base64 de 32 bytes) e uma quebra de linha');
  assert.equal(Buffer.from(ok.stdout.trim(), 'base64').length, 32);
  assert.match(ok.stderr, /Chave PRIVADA gravada em/);
  assert.match(ok.stderr, /EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY/);
  const seed = Buffer.from(crypto.createPrivateKey(fs.readFileSync(arquivo, 'utf8')).export({ format: 'jwk' }).d, 'base64url');
  for (const forma of [seed.toString('hex'), seed.toString('base64'), seed.toString('base64url')]) assert.equal(`${ok.stdout}${ok.stderr}`.includes(forma), false, 'a privada nunca é impressa');
  assert.equal(/PRIVATE KEY/.test(`${ok.stdout}${ok.stderr}`), false);
  const antes = sha(fs.readFileSync(arquivo));
  await assert.rejects(roda(`--arquivo=${arquivo}`), (e) => e.code === 1 && e.stdout === '' && /já existe uma identidade/.test(e.stderr));
  assert.equal(sha(fs.readFileSync(arquivo)), antes, 'não sobrescreveu');
  assert.equal((await roda(`--arquivo=${arquivo}`, '--publica')).stdout, ok.stdout, '--publica mostra a mesma pública');
  const nova = await roda(`--arquivo=${arquivo}`, '--forcar');
  assert.notEqual(nova.stdout, ok.stdout);
  await assert.rejects(roda(`--arquivo=${path.join(tmp, 'sem-nada.key')}`, '--publica'), (e) => e.code === 1 && e.stdout === '');
});

// ───────────────────────── a chave privada fora do repositório ─────────────────────────

await test('nenhuma chave privada no repositório: nem no código, nem nos testes, nem nos docs, nem no painel web versionado', () => {
  // um bloco PEM de chave privada de verdade (cabeçalho + corpo em base64); montado em pedaços para este arquivo não casar consigo mesmo. Um texto solto como
  // '-----BEGIN RSA PRIVATE KEY-----' (o teste de mascaramento de segredos do test-research-fixes) não é uma chave.
  const marca = new RegExp(['-----BEGIN [A-Z ]*PRIV', 'ATE KEY-----\\s+[A-Za-z0-9+/=]{40,}'].join(''));
  const achados = [];
  const ignorar = new Set(['node_modules', '.git', 'logs', 'dist', 'database', 'secrets', '.expo', '.claude']);
  const ler = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignorar.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) ler(p);
      else if (/\.(js|mjs|ts|tsx|json|md|html|cmd|ps1|bat|example|env_example)$|^\.env_example$/i.test(e.name) || e.name === '.env_example') {
        if (marca.test(fs.readFileSync(p, 'utf8'))) achados.push(path.relative(raiz, p));
      }
    }
  };
  ler(raiz);
  assert.deepEqual(achados, [], `chave privada em arquivo versionável: ${achados.join(', ')}`);
});

process.chdir(raiz);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sobra em %TEMP%: inofensiva */ }
console.log(`\n${passed} testes OK`);
