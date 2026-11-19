// O OMNIROUTE FALSO DO CABEÇALHO DE DECISÃO (etapa 13): um servidor HTTP em loopback, aberto pelo PRÓPRIO teste, que imita só o que importa para o
// teste do `X-OmniRoute-Decision`: POST /v1/chat/completions com a chave certa, o cabeçalho no formato REAL lido no código do OmniRoute 3.8.52
//   X-OmniRoute-Decision: strategy=<nome ou single>; provider=<APELIDO do OmniRoute>; latency_ms=<n>
// e as variações que o teste precisa (cabeçalho ausente, sem o campo provider, campo repetido, JSON, texto estranho, segredo plantado, rodízio de provedores
// entre as chamadas) e as falhas (HTTP 401/500..., queda, lentidão, travar sem responder, corpo inválido, resposta vazia). Nada sai da máquina e nada do
// OmniRoute de verdade é tocado: os apelidos e as chaves aqui são inventados pelo teste.
//
// Este arquivo é DIFERENTE de tests/helpers/omnirouteFalso.js (o das etapas 9 e 10, que imita outro formato de cabeçalho): nenhum dos dois depende do outro.
//
// O servidor guarda cada requisição (sem a chave: só o papel dela e o que veio no corpo) para o teste conferir o que o script ou a Yui mandou.
// Modos do cabeçalho (`modo`):
//   'real'          strategy=<estrategia>; provider=<provedor>; latency_ms=<latenciaMs>      (o formato real; o padrão)
//   'rodizio'       o mesmo, mas o provedor roda pela lista `provedores` a cada chamada (o combo com fallback)
//   'ausente'       sem o cabeçalho
//   'sem-provider'  strategy=<estrategia>; latency_ms=<latenciaMs>                          (sem o campo do provedor)
//   'duplicado'     o campo provider repetido (um dos dois fora da lista)
//   'json'          {"strategy":..., "provider":..., "latency_ms":...}
//   'estranho'      um texto que não segue nenhum formato
//   'segredo'       o formato real com um SEGREDO plantado em outros campos
//   'segredo-no-provedor'  provider=<o segredo>
//   'bruto'         o valor exato de `valorBruto`
// Outras opções: `cabecalhoProvider` (manda também o X-OmniRoute-Provider; `provedorDoCabecalho` muda o valor dele), `ecoaChave` (um servidor mal comportado que
// REPETE a chave recebida no cabeçalho, no corpo e nos erros: o script e a Yui nunca podem imprimir isso), `status`, `atrasoMs`, `cair`, `travar`, `vazio`,
// `corpoInvalido`.
import http from 'node:http';

export const CHAVE_DE_TESTE = 'sk-omni-teste-7f3a9c1e5b2d48a6f0e1c3b5a7d9f2e4';
export const SEGREDO_NO_CABECALHO = 'sk-SEGREDO-NO-CABECALHO-0a1b2c3d4e5f6a7b8c9d';

const PADRAO = Object.freeze({
  modo: 'real', provedor: 'gemini-cli', provedores: ['gemini-cli', 'groq'], estrategia: 'single', latenciaMs: 120, valorBruto: '',
  cabecalhoProvider: true, provedorDoCabecalho: null, ecoaChave: false,
  status: 200, atrasoMs: 0, cair: false, travar: false, vazio: false, corpoInvalido: false,
});

function valorDoCabecalho(c, n, chaveRecebida) {
  let valor;
  switch (c.modo) {
    case 'real': valor = `strategy=${c.estrategia}; provider=${c.provedor}; latency_ms=${c.latenciaMs}`; break;
    case 'rodizio': valor = `strategy=${c.estrategia}; provider=${c.provedores[(n - 1) % c.provedores.length]}; latency_ms=${c.latenciaMs}`; break;
    case 'ausente': return null;
    case 'sem-provider': valor = `strategy=${c.estrategia}; latency_ms=${c.latenciaMs}`; break;
    case 'duplicado': valor = `strategy=${c.estrategia}; provider=${c.provedor}; provider=anonimo-x; latency_ms=${c.latenciaMs}`; break;
    case 'json': valor = JSON.stringify({ strategy: c.estrategia, provider: c.provedor, latency_ms: c.latenciaMs }); break;
    case 'estranho': valor = '<<< o melhor provedor foi escolhido pela prioridade >>>'; break;
    case 'segredo': valor = `strategy=${c.estrategia}; provider=${c.provedor}; latency_ms=7; api_key=${SEGREDO_NO_CABECALHO}; nota=Bearer ${SEGREDO_NO_CABECALHO}`; break;
    case 'segredo-no-provedor': valor = `strategy=${c.estrategia}; provider=${SEGREDO_NO_CABECALHO}; latency_ms=7`; break;
    case 'bruto': valor = String(c.valorBruto); break;
    default: return null;
  }
  return c.ecoaChave && chaveRecebida ? `${valor}; chave=${chaveRecebida}` : valor;
}

/**
 * Abre o OmniRoute falso numa porta livre do loopback.
 * @param {{ chave?: string }} [o]  a chave que o servidor aceita (a de teste deste arquivo por padrão)
 * @returns {Promise<{ url: string, endpoint: string, port: number, requisicoes: object[], definir: Function, limpar: Function, close: Function }>}
 */
export async function criarOmniRouteCabecalhoFalso({ chave = CHAVE_DE_TESTE } = {}) {
  const requisicoes = [];
  const sockets = new Set();
  let config = { ...PADRAO };

  const server = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const corpoTexto = Buffer.concat(pedacos).toString('utf8');
      let corpo = null;
      try { corpo = JSON.parse(corpoTexto); } catch { corpo = null; }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(String(req.url).split('?')[0]) || !corpo) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"rota desconhecida"}}');
        return;
      }
      const auth = String(req.headers.authorization ?? '');
      const recebida = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const papel = !recebida ? 'sem-chave' : (recebida === chave ? 'chave-certa' : 'chave-errada');
      const c = { ...config };
      const n = requisicoes.length + 1;
      const mensagens = Array.isArray(corpo.messages) ? corpo.messages.map((m) => ({ role: m?.role, content: String(m?.content ?? '') })) : [];
      requisicoes.push({
        n, quando: Date.now(), metodo: req.method, caminho: String(req.url), papel, modelo: String(corpo.model ?? ''), maxTokens: corpo.max_tokens ?? null,
        stream: corpo.stream === true, mensagens, chavesDoCorpo: Object.keys(corpo).sort(), temCabecalhoDeCookie: Boolean(req.headers.cookie),
      });
      const eco = c.ecoaChave && recebida ? ` (recebi a chave ${recebida})` : '';
      const responder = () => {
        if (c.travar) return; // nunca responde: o cliente desiste pelo prazo
        if (c.cair) { req.socket.destroy(); return; }
        if (papel !== 'chave-certa') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `chave inválida${eco}` } })); return; }
        if (c.status !== 200) { res.writeHead(c.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `erro simulado ${c.status}${eco}` } })); return; }
        const cabecalhos = { 'Content-Type': 'application/json' };
        const valor = valorDoCabecalho(c, n, c.ecoaChave ? recebida : '');
        if (valor !== null) cabecalhos['X-OmniRoute-Decision'] = valor;
        if (c.cabecalhoProvider) {
          const provedor = c.provedorDoCabecalho ?? (c.modo === 'rodizio' ? c.provedores[(n - 1) % c.provedores.length] : c.provedor);
          cabecalhos['X-OmniRoute-Provider'] = c.ecoaChave && recebida ? recebida : provedor;
        }
        if (c.corpoInvalido) { res.writeHead(200, cabecalhos); res.end('isto não é JSON'); return; }
        const texto = c.vazio ? '' : `ok${eco}`;
        res.writeHead(200, cabecalhos);
        res.end(JSON.stringify({ id: 'omni-cabecalho-falso', object: 'chat.completion', model: String(corpo.model ?? ''), choices: [{ index: 0, message: { role: 'assistant', content: texto }, finish_reason: 'stop' }] }));
      };
      if (c.atrasoMs > 0) setTimeout(responder, c.atrasoMs); else responder();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    port,
    requisicoes,
    /** Muda o comportamento (SUBSTITUI o anterior). */
    definir(parcial) { config = { ...PADRAO, ...parcial }; },
    /** Volta ao comportamento padrão e esquece as requisições. */
    limpar() { config = { ...PADRAO }; requisicoes.length = 0; },
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
    },
  };
}
