// Aprova ou nega, NO COMPUTADOR DA YUI, as ações críticas que ela pediu (gravar código, rodar comando).
//
//   node scripts/yui-aprovar.mjs                 lista o que está pendente e pergunta uma a uma
//   node scripts/yui-aprovar.mjs aprovar <id>    aprova uma (use o id inteiro ou o começo dele)
//   node scripts/yui-aprovar.mjs negar <id>      nega uma
//   node scripts/yui-aprovar.mjs lista           só mostra
//   (npm run aprovar -- ...)
//
// Fala com o canal local (127.0.0.1:3940), com o segredo que a Yui gravou em secrets/approval-channel.json
// (só quem tem acesso a esse arquivo no disco consegue aprovar). Pedidos expiram em 60 s: seja rápido.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';

const root = path.resolve(import.meta.dirname, '..');
const file = process.env.YUI_APPROVAL_NONCE_FILE ? path.resolve(process.env.YUI_APPROVAL_NONCE_FILE) : path.join(root, 'secrets', 'approval-channel.json');

let channel;
try {
  channel = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Não consegui ler ${file} (${err.code || err.message}).`);
  console.error('A Yui está ligada, com YUI_DEV_ENABLED=true, e você está rodando como um usuário com acesso a esse arquivo?');
  process.exit(2);
}

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: channel.port, path: route, method, timeout: 8000, headers: { 'X-Yui-Local-Nonce': channel.nonce, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }); } catch { resolve({ status: res.statusCode, body: { error: text.slice(0, 200) } }); } });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const secs = (t) => Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000));
function show(t, i) {
  console.log(`\n[${i + 1}] ${t.levelRequired}  id ${t.id}  (expira em ${secs(t)} s)`);
  console.log(`    ${t.summary}`);
  if (t.canonicalTarget) console.log(`    alvo: ${t.canonicalTarget}`);
  console.log(`    hash dos parâmetros: ${t.paramsHash.slice(0, 16)}…  origem do pedido: ${t.requesterOrigin ?? '?'}`);
  if (t.preview) console.log(t.preview.split('\n').slice(0, 12).map((l) => `    | ${l}`).join('\n'));
}

async function pending() {
  const r = await call('GET', '/v1/local/pending');
  if (r.status !== 200) throw new Error(r.body.error || `HTTP ${r.status}`);
  return r.body.approvals;
}

async function decide(id, approve) {
  const r = await call('POST', '/v1/local/decide', { id, approve });
  if (r.status !== 200) { console.error(`Falhou: ${r.body.error || `HTTP ${r.status}`}`); return false; }
  console.log(approve ? 'Aprovado.' : 'Negado.');
  return true;
}

function resolveId(list, prefix) {
  const found = list.filter((t) => t.id.startsWith(prefix));
  if (found.length !== 1) { console.error(found.length ? 'O começo do id é ambíguo.' : 'Nenhum pedido pendente com esse id.'); return null; }
  return found[0].id;
}

try {
  const [cmd, arg] = process.argv.slice(2);
  const list = await pending();
  if (cmd === 'aprovar' || cmd === 'negar') {
    const id = arg ? resolveId(list, arg) : null;
    process.exit(id && (await decide(id, cmd === 'aprovar')) ? 0 : 1);
  }
  if (!list.length) { console.log('Nada pendente.'); process.exit(0); }
  list.forEach(show);
  if (cmd === 'lista') process.exit(0);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const t of list) {
    const answer = (await rl.question(`\nAprovar "${t.summary.slice(0, 70)}"? [s/N] `)).trim().toLowerCase();
    await decide(t.id, answer === 's' || answer === 'sim');
  }
  rl.close();
} catch (err) {
  console.error(`Não consegui falar com a Yui em 127.0.0.1:${channel.port}: ${err.message}`);
  process.exit(1);
}
