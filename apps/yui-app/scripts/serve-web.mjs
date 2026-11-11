// Serve a versão web exportada (dist/) com fallback de SPA.
//   npm run web:build   (gera dist/)
//   npm run web:serve   (http://localhost:8081)
//
// Variáveis (todas opcionais):
//   DIST_DIR           pasta do painel (padrão dist)
//   HOST               endereço (padrão 127.0.0.1; no notebook 0.0.0.0, para abrir pelo IP)
//   PORT / PORTS       porta (padrão 8081) ou lista separada por vírgula (ex.: 80,8081)
//   BDS_API_UPSTREAM   endereço do BDS Server (ex.: http://127.0.0.1:8090). Quando definido, as rotas /api/* são repassadas a ele,
//                      para que o painel abra na porta 80 (http://IP/) e a API do BDS Server (BDS desktop, chaves de API) siga no
//                      mesmo endereço de antes. O repasse é em fluxo (arquivo grande e Range passam direto).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// Cabeçalhos que não atravessam um repasse (RFC 7230, 6.1).
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyTo(upstream, req, res) {
  const target = new URL(req.url, upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v; // o Host original segue (o BDS Server confere o nome)
  const ip = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${ip}` : ip;
  const up = http.request(target, { method: req.method, headers }, (ur) => {
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    res.writeHead(ur.statusCode || 502, out);
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'O BDS Server não respondeu.' }));
  });
  res.on('close', () => { if (!res.writableEnded) up.destroy(); }); // o navegador desistiu: fecha a conexão com o BDS Server
  req.pipe(up);
}

/** Servidor do painel. `upstream` (opcional) é o endereço do BDS Server para as rotas /api/*. */
export function createWebServer({ root, upstream = '' } = {}) {
  const base = path.resolve(root);
  const up = upstream ? new URL(upstream).origin : '';
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (up && (pathname === '/api' || pathname.startsWith('/api/'))) return proxyTo(up, req, res);
    let file = path.join(base, pathname);
    // Impede sair da pasta do painel (path traversal).
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(base, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

export function parsePorts(env = process.env) {
  const raw = String(env.PORTS || env.PORT || '8081');
  const ports = [...new Set(raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))];
  return ports.length ? ports : [8081];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..', process.env.DIST_DIR || 'dist');
  const host = process.env.HOST || '127.0.0.1';
  const upstream = String(process.env.BDS_API_UPSTREAM || '').trim();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    console.error('dist/ não encontrado. Rode "npm run web:build" primeiro.');
    process.exit(1);
  }
  for (const port of parsePorts()) {
    createWebServer({ root, upstream })
      .on('error', (e) => { console.error(`Porta ${port}: ${e.message}`); if (port === parsePorts()[0]) process.exit(1); })
      .listen(port, host, () => console.log(`Yui web em http://${host}:${port}${upstream ? ` (a API do BDS Server em /api vai para ${upstream})` : ''}`));
  }
}
