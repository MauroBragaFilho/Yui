// Sobe a Yui API para DESENVOLVER/TESTAR os apps, sem o bot do Discord.
//
//   npm run dev:api                  IA real (cadeia atual), banco temporário
//   npm run dev:api -- --fake        IA simulada + ferramentas de demonstração
//   opções: --port 3939 --host 127.0.0.1 --cors http://localhost:8081 --as owner|member --real-db
//
// Por padrão usa um BANCO TEMPORÁRIO e o papel "member", então nada do seu
// dado pessoal é tocado. O token impresso é descartável (vale só nesta execução).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const asOwner = opt('as', 'member') === 'owner';
if (!flag('real-db')) process.env.DATABASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dev-api-'));
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_API_ENABLED = 'true';
process.env.YUI_API_HOST = opt('host', '127.0.0.1');
process.env.YUI_API_PORT = opt('port', '3939');
process.env.YUI_API_CORS_ORIGINS = opt('cors', 'http://localhost:8081,http://localhost:19006');

const userId = asOwner ? process.env.YUI_OWNER_ID || process.env.OWNER_ID || '111' : '222';
if (asOwner) process.env.YUI_OWNER_ID = userId;
const token = process.env.DEV_API_TOKEN || crypto.randomBytes(18).toString('hex');
process.env.YUI_API_TOKENS = `${token}=${userId}`;

const { initMemory } = await import('../src/core/index.js');
const ai = await import('../src/core/ai/manager.js');
const { registerTool } = await import('../src/core/agent/tools.js');
const { startApi } = await import('../src/core/api/server.js');

await initMemory();

if (flag('fake')) {
  registerTool({
    name: 'demo.ping', description: 'Responde pong (demonstração).', minRole: 'MEMBER', access: 'read', privateOnly: false,
    async run() { return 'pong 🏓'; },
  });
  registerTool({
    name: 'demo.limpar_cache', description: 'Ação sensível de demonstração.', minRole: 'MEMBER', access: 'open', privateOnly: false, confirm: true,
    async run() { return 'Cache limpo (simulação).'; },
  });
  ai.registerBackend({
    name: 'fake', local: false,
    async chat({ prompt }) {
      // O Agent manda o pedido do usuário depois de "MENSAGEM DO USUÁRIO:".
      const text = (prompt.split('MENSAGEM DO USUÁRIO:\n').pop() || prompt).toLowerCase();
      if (text.includes('ping')) return '{"tool":"demo.ping","args":{}}';
      if (text.includes('limpar') || text.includes('apaga')) return '{"tool":"demo.limpar_cache","args":{}}';
      if (text.includes('formata')) return '{"tool":"pc.formatar_disco","args":{}}';
      return JSON.stringify({ reply: `Oi! Você disse: “${text.trim().slice(0, 200)}”. (IA simulada)` });
    },
  }, { activate: true });
}

const server = startApi();
if (!server) {
  console.error('A API não iniciou (verifique YUI_API_TOKENS).');
  process.exit(1);
}

console.log('\n──────── Yui API (desenvolvimento) ────────');
console.log(`URL:    http://${process.env.YUI_API_HOST}:${process.env.YUI_API_PORT}`);
console.log(`Token:  ${token}`);
console.log(`Papel:  ${asOwner ? 'OWNER (memória pessoal)' : 'MEMBER (memória temporária)'}  |  IA: ${flag('fake') ? 'simulada' : 'real'}`);
console.log(`Banco:  ${process.env.DATABASE_DIR || './database (REAL)'}`);
console.log('CORS:  ', process.env.YUI_API_CORS_ORIGINS);
console.log('Ctrl+C para encerrar.\n');
