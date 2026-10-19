// Testes da leitura segura de páginas (src/search/safeFetch.js): SSRF, DNS rebinding, redirecionamento,
// tamanho do corpo, prazo total e tipo de conteúdo. SEM rede: só servidores em 127.0.0.1 (porta 0) e DNS falso.
// Execução: npm run test:safefetch
import assert from 'assert';
import { EventEmitter } from 'events';
import http from 'http';
import { Readable } from 'stream';
import zlib from 'zlib';

const { safeFetchText, fetchPage, fetchPageContent, extractPageText, extractPageTextIsolated, shutdownParseWorker, isBlockedAddress, UNTRUSTED_WEB_MARK } = await import('../src/search/safeFetch.js');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FALHA  ${name}\n${err.stack}`);
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
};

const PAGE = `<html><head><title>t</title><script>var x = 'nao deve aparecer';</script></head><body>
<nav><p>menu de navegação que não importa nada para o texto principal do artigo</p></nav>
<article><h1>Título do artigo</h1><p>${'Este é um parágrafo longo do artigo principal com informação útil. '.repeat(3)}</p><li>${'Item de lista bem comprido para passar do mínimo de caracteres. '.repeat(2)}</li></article>
<footer><p>rodapé que também deve sair do texto final da página lida pelo bot</p></footer></body></html>`;

// ---------------------------------------------------------------------------------------------
// Servidor local de teste
// ---------------------------------------------------------------------------------------------
const hits = {};
const state = { bigSent: 0, bigClosed: false, dripClosed: false, hangClosed: false, otherHits: 0 };
let portB = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  hits[url] = (hits[url] ?? 0) + 1;
  const html = { 'content-type': 'text/html; charset=utf-8' };
  switch (url) {
    case '/ok':
      res.writeHead(200, html);
      return res.end(PAGE);
    case '/plain':
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('texto   simples\n\n  da página');
    case '/big': {
      res.writeHead(200, html);
      const chunk = Buffer.alloc(65536, 'a');
      const pump = () => {
        while (!res.destroyed && state.bigSent < 300 * 1024 * 1024) {
          const ok = res.write(chunk);
          state.bigSent += chunk.length;
          if (!ok) return void res.once('drain', pump);
        }
        return undefined;
      };
      res.on('close', () => { state.bigClosed = true; });
      return pump();
    }
    case '/exact':
      res.writeHead(200, html);
      return res.end('b'.repeat(1000));
    case '/drip': {
      res.writeHead(200, html);
      const timer = setInterval(() => res.write('x'), 40);
      res.on('close', () => { clearInterval(timer); state.dripClosed = true; });
      return undefined;
    }
    case '/hang':
      res.on('close', () => { state.hangClosed = true; });
      return undefined; // nunca responde
    case '/bin':
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.alloc(1000));
    case '/json':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"a":1}');
    case '/pdf':
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end('%PDF-1.4');
    case '/nottype':
      res.writeHead(200, {});
      return res.end('<p>sem content-type</p>');
    case '/404':
      res.writeHead(404, html);
      return res.end('nada aqui');
    case '/gzip':
      res.writeHead(200, { ...html, 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(Buffer.from(PAGE)));
    case '/bomb':
      res.writeHead(200, { ...html, 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(Buffer.alloc(60 * 1024 * 1024, 'z')));
    case '/latin1':
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      return res.end(Buffer.from('<html><body><p>Ação rápida de coração: informação com acentuação suficiente para passar do mínimo.</p></body></html>', 'latin1'));
    case '/r1':
      res.writeHead(302, { location: '/r2' });
      return res.end();
    case '/r2':
      res.writeHead(301, { location: '/r3' });
      return res.end();
    case '/r3':
      res.writeHead(307, { location: '/ok' });
      return res.end();
    case '/loop':
      res.writeHead(302, { location: '/loop' });
      return res.end();
    case '/to-private':
      res.writeHead(302, { location: 'http://192.168.0.10:1/segredo' });
      return res.end();
    case '/to-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    case '/to-other-ip':
      res.writeHead(302, { location: `http://127.0.0.2:${portB}/hit` });
      return res.end();
    case '/to-b':
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/hit` });
      return res.end();
    case '/to-ftp':
      res.writeHead(302, { location: 'ftp://exemplo.com/arquivo' });
      return res.end();
    case '/to-cred':
      res.writeHead(302, { location: `http://user:senha@127.0.0.1:${portB}/hit` });
      return res.end();
    default:
      res.writeHead(404, html);
      return res.end();
  }
});

const serverB = http.createServer((req, res) => {
  state.otherHits++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<p>servidor B</p>');
});

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const port = await listen(server);
portB = await listen(serverB);
const base = `http://127.0.0.1:${port}`;
const onlyLoopback = { allowPrivate: (ip) => ip === '127.0.0.1' };

// Dublê de http.request (sem rede) para o caminho "DNS público".
function fakeRequest(body, { status = 200, headers = { 'content-type': 'text/html' } } = {}) {
  const calls = [];
  const impl = (options, cb) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => process.nextTick(() => {
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = status;
      res.headers = headers;
      cb(res);
    });
    return req;
  };
  impl.calls = calls;
  return impl;
}

try {
  console.log('Endereços bloqueados');
  await test('isBlockedAddress: faixas privadas, locais, CGNAT, link-local, multicast e IPv6 (inclusive IPv4 embutido)', () => {
    const blocked = [
      '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.9', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '192.0.0.5', '198.18.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:c0a8:1',
      '64:ff9b::7f00:1', '2002:7f00:1::', '2002:c0a8:101::', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::127.0.0.1', '[::1]', 'nao-e-ip', '', null,
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `deveria bloquear ${ip}`);
    const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '11.0.0.1', '223.255.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::', '64:ff9b::808:808'];
    for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `deveria permitir ${ip}`);
  });

  await test('IP privado/local é recusado SEM abrir conexão (allowPrivate=false é o padrão)', async () => {
    const before = hits['/ok'] ?? 0;
    const urls = [
      `${base}/ok`, 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://172.16.5.4:8080/',
      `http://[::1]:${port}/ok`, `http://[::ffff:127.0.0.1]:${port}/ok`, `http://0.0.0.0:${port}/ok`, `http://2130706433:${port}/ok`, `http://0x7f.1:${port}/ok`, 'http://100.64.0.1/', 'http://[fe80::1]/', 'http://[fd00::1]/',
    ];
    for (const url of urls) {
      const r = await safeFetchText(url);
      assert.equal(r.ok, false, url);
      assert.equal(r.code, 'BLOCKED', `${url} -> ${r.code} ${r.error}`);
      assert.equal(r.text, '');
    }
    assert.equal(hits['/ok'] ?? 0, before, 'o servidor local não pode ter recebido nenhuma conexão');
  });

  await test('só http/https, sem credenciais, URL válida', async () => {
    for (const url of ['ftp://exemplo.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,oi', 'gopher://x/', 'não é url', '', null, undefined, 'http://user:senha@exemplo.com/', 'http://user@exemplo.com/']) {
      const r = await safeFetchText(url, { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: fakeRequest('x') });
      assert.equal(r.ok, false, String(url));
      assert.equal(r.code, 'INVALID_URL', `${url} -> ${r.code}`);
    }
  });

  console.log('DNS e rebinding');
  await test('DNS que resolve para IP privado é recusado (inclusive se SÓ UM dos endereços for privado)', async () => {
    let calls = 0;
    const lookupImpl = async () => { calls++; return [{ address: '10.1.2.3', family: 4 }]; };
    const r = await safeFetchText('http://exemplo.test/pagina', { lookupImpl, requestImpl: fakeRequest('x') });
    assert.equal(r.code, 'BLOCKED');
    assert.equal(calls, 1);
    const mixed = await safeFetchText('http://exemplo.test/', { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], requestImpl: fakeRequest('x') });
    assert.equal(mixed.code, 'BLOCKED');
    const v6 = await safeFetchText('http://exemplo.test/', { lookupImpl: async () => [{ address: '::ffff:127.0.0.1', family: 6 }], requestImpl: fakeRequest('x') });
    assert.equal(v6.code, 'BLOCKED');
    const nodns = await safeFetchText('http://nao-existe.test/', { lookupImpl: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(nodns.ok, false);
    assert.equal(nodns.code, 'DNS');
  });

  await test('prazo TOTAL cobre o DNS: lookup que nunca resolve (ou demora) estoura em totalDeadlineMs', async () => {
    let started = Date.now();
    const never = await safeFetchText('http://dns-lento.test/', { lookupImpl: () => new Promise(() => {}), requestImpl: fakeRequest('x'), totalDeadlineMs: 300 });
    assert.equal(never.ok, false);
    assert.equal(never.code, 'TIMEOUT', `${never.code}: ${never.error}`);
    assert.ok(Date.now() - started < 1500, `demorou ${Date.now() - started} ms`);
    started = Date.now();
    const slow = await safeFetchText('http://dns-lento.test/', { lookupImpl: async () => { await sleep(1500); return [{ address: '93.184.216.34', family: 4 }]; }, requestImpl: fakeRequest('x'), totalDeadlineMs: 300 });
    assert.equal(slow.code, 'TIMEOUT', `${slow.code}: ${slow.error}`);
    assert.ok(Date.now() - started < 1200, `não pode esperar o DNS terminar (${Date.now() - started} ms)`);
    // cancelamento externo também interrompe o DNS pendente
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    started = Date.now();
    const cancelled = await safeFetchText('http://dns-lento.test/', { lookupImpl: () => new Promise(() => {}), requestImpl: fakeRequest('x'), totalDeadlineMs: 5000, signal: ctrl.signal });
    assert.equal(cancelled.code, 'ABORTED');
    assert.ok(Date.now() - started < 1500);
  });

  await test('DNS público passa (caminho feliz sem rede, com requisição falsa)', async () => {
    const fake = fakeRequest(PAGE);
    const r = await safeFetchText('https://exemplo.test/artigo?x=1', { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: fake });
    assert.equal(r.ok, true);
    assert.ok(r.text.includes('Título do artigo'));
    assert.equal(fake.calls[0].protocol, 'https:');
    assert.equal(fake.calls[0].hostname, 'exemplo.test');
    assert.equal(fake.calls[0].path, '/artigo?x=1');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(typeof fake.calls[0].lookup, 'function');
  });

  await test('rebinding: o DNS devolve IP público na validação e IP privado na hora de conectar -> bloqueado', async () => {
    let calls = 0;
    const lookupImpl = async () => { calls++; return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
    const before = hits['/ok'] ?? 0;
    const r = await safeFetchText(`http://rebind.test:${port}/ok`, { lookupImpl });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BLOCKED', `${r.code}: ${r.error}`);
    assert.equal(calls, 2, 'o lookup da conexão revalida');
    assert.equal(hits['/ok'] ?? 0, before, 'nenhuma conexão com o servidor local');
  });

  await test('o lookup da conexão devolve o endereço certo quando permitido (controle positivo do rebinding)', async () => {
    const r = await safeFetchText(`http://rebind.test:${port}/ok`, { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], ...onlyLoopback });
    assert.equal(r.ok, true, `${r.code}: ${r.error}`);
    assert.ok(r.text.includes('Título do artigo'));
  });

  console.log('Redirecionamentos');
  await test('segue até 3 redirecionamentos (relativos) e informa a URL final', async () => {
    const r = await safeFetchText(`${base}/r1`, { allowPrivate: true });
    assert.equal(r.ok, true);
    assert.equal(r.url, `${base}/ok`);
    assert.equal(r.status, 200);
  });

  await test('mais de 3 redirecionamentos, ou laço, dá erro', async () => {
    const tooMany = await safeFetchText(`${base}/r1`, { allowPrivate: true, maxRedirects: 2 });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, 'REDIRECTS');
    const loop = await safeFetchText(`${base}/loop`, { allowPrivate: true });
    assert.equal(loop.code, 'REDIRECTS');
  });

  await test('CADA salto é revalidado: 302 de servidor local para IP privado/metadados/outro IP local é bloqueado', async () => {
    for (const path of ['/to-private', '/to-metadata']) {
      const r = await safeFetchText(`${base}${path}`, onlyLoopback);
      assert.equal(r.ok, false, path);
      assert.equal(r.code, 'BLOCKED', `${path}: ${r.code} ${r.error}`);
    }
    state.otherHits = 0;
    const other = await safeFetchText(`${base}/to-other-ip`, onlyLoopback);
    assert.equal(other.code, 'BLOCKED');
    assert.equal(state.otherHits, 0, 'o servidor de destino do redirecionamento não pode ser contatado');
    // controle: redirecionamento para outro servidor no IP permitido é seguido (e só então o destino é contatado)
    const freed = await safeFetchText(`${base}/to-b`, onlyLoopback);
    assert.equal(freed.ok, true, `${freed.code}: ${freed.error}`);
    assert.ok(freed.text.includes('servidor B'));
    assert.equal(state.otherHits, 1);
    // com o padrão (allowPrivate=false) o primeiro salto já é bloqueado
    assert.equal((await safeFetchText(`${base}/r1`)).code, 'BLOCKED');
  });

  await test('redirecionamento para esquema não http ou com credenciais é recusado', async () => {
    assert.equal((await safeFetchText(`${base}/to-ftp`, { allowPrivate: true })).code, 'INVALID_URL');
    assert.equal((await safeFetchText(`${base}/to-cred`, { allowPrivate: true })).code, 'INVALID_URL');
  });

  console.log('Corpo, prazo e tipo de conteúdo');
  await test('corpo gigante é cortado em maxBytes e a conexão é fechada', async () => {
    const r = await safeFetchText(`${base}/big`, { allowPrivate: true, maxBytes: 100_000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(Buffer.byteLength(r.text), 100_000);
    assert.ok(await waitFor(() => state.bigClosed), 'o servidor deveria ver a conexão fechada');
    assert.ok(state.bigSent < 100 * 1024 * 1024, `o servidor enviou ${state.bigSent} bytes: a leitura não parou`);
  });

  await test('corpo com exatamente maxBytes não é marcado como cortado', async () => {
    const r = await safeFetchText(`${base}/exact`, { allowPrivate: true, maxBytes: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, false);
    assert.equal(r.text.length, 1000);
  });

  await test('corpo comprimido enorme (bomba gzip) também é cortado em maxBytes', async () => {
    const r = await safeFetchText(`${base}/bomb`, { allowPrivate: true, maxBytes: 200_000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(Buffer.byteLength(r.text), 200_000);
  });

  await test('gzip normal é descomprimido; charset iso-8859-1 é respeitado', async () => {
    const gz = await safeFetchText(`${base}/gzip`, { allowPrivate: true });
    assert.equal(gz.ok, true);
    assert.ok(gz.text.includes('Título do artigo'));
    const latin = await safeFetchText(`${base}/latin1`, { allowPrivate: true });
    assert.equal(latin.ok, true);
    assert.ok(latin.text.includes('Ação rápida de coração'));
  });

  await test('corpo que goteja estoura o prazo TOTAL (e a conexão é fechada)', async () => {
    const started = Date.now();
    const r = await safeFetchText(`${base}/drip`, { allowPrivate: true, totalDeadlineMs: 400, timeoutMs: 5000 });
    const ms = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(r.error, 'tempo esgotado');
    assert.ok(ms >= 350 && ms < 2000, `demorou ${ms} ms`);
    assert.ok(await waitFor(() => state.dripClosed), 'a conexão deveria ter sido fechada');
  });

  await test('servidor que nunca responde: timeout de conexão e prazo total', async () => {
    const a = await safeFetchText(`${base}/hang`, { allowPrivate: true, timeoutMs: 250, totalDeadlineMs: 5000 });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'TIMEOUT');
    const started = Date.now();
    const b = await safeFetchText(`${base}/hang`, { allowPrivate: true, timeoutMs: 5000, totalDeadlineMs: 300 });
    assert.equal(b.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 2000);
    assert.ok(await waitFor(() => state.hangClosed));
  });

  await test('cancelamento externo (AbortSignal) interrompe a leitura', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const started = Date.now();
    const r = await safeFetchText(`${base}/drip`, { allowPrivate: true, signal: controller.signal });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ABORTED');
    assert.ok(Date.now() - started < 2000);
    const pre = new AbortController();
    pre.abort();
    assert.equal((await safeFetchText(`${base}/ok`, { allowPrivate: true, signal: pre.signal })).code, 'ABORTED');
  });

  await test('content-type binário, JSON, PDF ou ausente é rejeitado; text/plain é aceito', async () => {
    for (const path of ['/bin', '/json', '/pdf', '/nottype']) {
      const r = await safeFetchText(`${base}${path}`, { allowPrivate: true });
      assert.equal(r.ok, false, path);
      assert.equal(r.code, 'CONTENT_TYPE', `${path}: ${r.code}`);
      assert.equal(r.text, '');
    }
    const plain = await safeFetchText(`${base}/plain`, { allowPrivate: true });
    assert.equal(plain.ok, true);
    assert.equal(plain.contentType, 'text/plain');
    const onlyHtml = await safeFetchText(`${base}/plain`, { allowPrivate: true, allowedContentTypes: ['text/html'] });
    assert.equal(onlyHtml.code, 'CONTENT_TYPE');
  });

  await test('status HTTP de erro vira ok:false com o código, sem lançar', async () => {
    const r = await safeFetchText(`${base}/404`, { allowPrivate: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, 'HTTP 404');
    const refused = await safeFetchText('http://127.0.0.1:1/', { allowPrivate: true, timeoutMs: 1000 });
    assert.equal(refused.ok, false);
    assert.ok(refused.error);
  });

  console.log('Extração de texto');
  await test('extractPageText: tira script/nav/rodapé, usa o artigo e respeita maxChars', () => {
    const text = extractPageText(PAGE);
    assert.ok(text.includes('Título do artigo') && text.includes('parágrafo longo'));
    assert.ok(!text.includes('nao deve aparecer') && !text.includes('menu de navegação') && !text.includes('rodapé'));
    assert.ok(extractPageText(PAGE, { maxChars: 50 }).length <= 50);
    assert.equal(extractPageText(''), '');
  });

  await test('fetchPage / fetchPageContent: texto pronto para o modelo, null em falha', async () => {
    const page = await fetchPage(`${base}/ok`, { allowPrivate: true, maxChars: 300 });
    assert.equal(page.ok, true);
    assert.ok(page.content.length > 0 && page.content.length <= 300);
    assert.equal('text' in page, false, 'o HTML bruto não sai de fetchPage');
    assert.equal(typeof page.ms, 'number');
    const plain = await fetchPageContent(`${base}/plain`, { allowPrivate: true });
    assert.equal(plain, 'texto simples da página');
    assert.equal(await fetchPageContent(`${base}/404`, { allowPrivate: true }), null);
    assert.equal(await fetchPageContent(`${base}/ok`), null, 'sem allowPrivate o servidor local é recusado');
    assert.match(UNTRUSTED_WEB_MARK, /DADOS EXTERNOS NÃO CONFIÁVEIS/);
  });

  await test('extractPageTextIsolated (worker) dá o mesmo texto do síncrono; fetchPage informa como foi o parse', async () => {
    assert.equal(await extractPageTextIsolated(PAGE), extractPageText(PAGE));
    assert.equal(await extractPageTextIsolated(''), '');
    assert.equal((await fetchPage(`${base}/ok`, { allowPrivate: true })).parse, 'ok');
    assert.equal((await fetchPage(`${base}/plain`, { allowPrivate: true })).parse, '', 'text/plain não passa pelo parse de HTML');
    assert.equal((await fetchPage(`${base}/404`, { allowPrivate: true })).parse, '', 'falha de download: sem parse');
  });
} finally {
  shutdownParseWorker();
  server.closeAllConnections?.();
  serverB.closeAllConnections?.();
  server.close();
  serverB.close();
}

console.log(`\n${passed} testes OK`);
process.exit(0);
