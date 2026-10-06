// Serve a versão web exportada (dist/) com fallback de SPA.
//   npm run web:build   (gera dist/)
//   npm run web:serve   (http://localhost:8081)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const port = Number(process.env.PORT || 8081);
const host = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ não encontrado. Rode "npm run web:build" primeiro.');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, urlPath);
    // Impede sair de dist/ (path traversal).
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, host, () => console.log(`Yui web em http://${host}:${port}`));
