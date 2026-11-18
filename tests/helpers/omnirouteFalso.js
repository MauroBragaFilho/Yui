// O OMNIROUTE FALSO dos testes dos perfis de IA (etapa 9): um servidor HTTP em loopback, aberto pelo PRÓPRIO teste, que imita só o que a Yui usa do
// OmniRoute (POST /v1/chat/completions) e devolve o modelo pedido, o cabeçalho de decisão em variações e as falhas. Nada sai da máquina e nada do
// OmniRoute de verdade é tocado (nem combos, nem chaves, nem configuração): os nomes dos combos aqui são inventados pelo teste.
//
// Cada resposta de sucesso diz, no texto, o que o servidor VIU: o modelo pedido, o PAPEL da chave usada (geral, privada ou desconhecida: nunca a chave),
// o max_tokens, as marcas `tok-...` que estavam no corpo (o teste planta uma marca por pessoa para conferir que nada vaza entre pessoas) e quantas mensagens.
// O servidor guarda cada requisição (sem a chave: só o papel dela) para o teste conferir quem chamou o quê.
//
// As variações do cabeçalho `X-OmniRoute-Decision` (modo `decisao`):
//   'ausente'       sem o cabeçalho
//   'permitido'     provider=<provedorPermitido>;strategy=priority;latency=42         (o formato "pares")
//   'fora'          provider=<provedorFora>;strategy=priority;latency=42              (um provedor que NÃO está na lista permitida)
//   'estranho'      um texto que não segue nenhum formato
//   'segredo'       o formato certo com um SEGREDO plantado em outros campos
//   'segredo-no-provedor'  provider=<o segredo>
//   'json'          {"provider":"<provedorPermitido>","strategy":"priority","latency_ms":42}
//   'json-fora'     o mesmo JSON com um provedor fora da lista
//   'texto'         "served by <provedorPermitido> via priority in 42ms" (texto livre)
//   'bruto'         o valor exato de `valorBruto`
//   'duplicado'     provider=<permitido>;provider=<fora>  (o campo repetido)
// Falhas: `status` (429, 500...), `atrasoMs` (lentidão), `cair: true` (o servidor derruba a conexão), `vazio: true` (200 com texto vazio),
// `corpoInvalido: true` (200 que não é JSON), `falhasAntes: N` (as N primeiras requisições desse alvo respondem 500 e as seguintes seguem o resto da configuração).
import http from 'node:http';

export const CHAVE_GERAL = 'sk-omni-geral-teste-0123456789abcdef';
export const CHAVE_PRIVADA = 'sk-omni-privada-teste-0123456789abcdef';
export const SEGREDO_PLANTADO = 'sk-SEGREDO-PLANTADO-9f8e7d6c5b4a39281706';

const PADRAO = Object.freeze({
  decisao: 'permitido', status: 200, atrasoMs: 0, cair: false, vazio: false, corpoInvalido: false,
  provedorPermitido: 'groq', provedorFora: 'anonimo-x', segredo: SEGREDO_PLANTADO, valorBruto: '',
});

function valorDoCabecalho(c) {
  switch (c.decisao) {
    case 'ausente': return null;
    case 'permitido': return `provider=${c.provedorPermitido};strategy=priority;latency=42`;
    case 'fora': return `provider=${c.provedorFora};strategy=priority;latency=42`;
    case 'estranho': return '<<< decisão: ??? ### o melhor provedor foi escolhido pela prioridade >>>';
    case 'segredo': return `provider=${c.provedorPermitido};strategy=priority;api_key=${c.segredo};latency=7;nota=Bearer ${c.segredo}`;
    case 'segredo-no-provedor': return `provider=${c.segredo};strategy=priority`;
    case 'json': return JSON.stringify({ provider: c.provedorPermitido, strategy: 'priority', latency_ms: 42 });
    case 'json-fora': return JSON.stringify({ provider: c.provedorFora, strategy: 'priority', latency_ms: 42 });
    case 'texto': return `served by ${c.provedorPermitido} via priority in 42ms`;
    case 'bruto': return String(c.valorBruto);
    case 'duplicado': return `provider=${c.provedorPermitido};provider=${c.provedorFora}`;
    default: return null;
  }
}

/**
 * Abre o OmniRoute falso numa porta livre do loopback.
 * @param {{ chaves?: Record<string, string> }} [o]  chave -> papel (padrão: a geral e a privada deste arquivo)
 * @returns {Promise<{ url: string, endpoint: string, port: number, requisicoes: object[], definir: Function, limpar: Function, doModelo: Function, close: Function }>}
 */
export async function criarOmniRouteFalso({ chaves = { [CHAVE_GERAL]: 'geral', [CHAVE_PRIVADA]: 'privada' } } = {}) {
  const requisicoes = [];
  const porModelo = new Map();
  let global = { ...PADRAO };
  const sockets = new Set();
  const restantes = new Map(); // alvo ('*' ou o modelo) -> quantas falhas ainda faltam (falhasAntes)

  const server = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const corpoTexto = Buffer.concat(pedacos).toString('utf8');
      let corpo = null;
      try { corpo = JSON.parse(corpoTexto); } catch { corpo = null; }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(String(req.url).split('?')[0]) || !corpo) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"rota desconhecida"}}'); return; }
      const auth = String(req.headers.authorization ?? '');
      const chave = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const papel = Object.hasOwn(chaves, chave) ? chaves[chave] : (chave ? 'desconhecida' : 'sem-chave');
      const modelo = String(corpo.model ?? '');
      const c = { ...(porModelo.has(modelo) ? { ...PADRAO, ...porModelo.get(modelo) } : global) };
      const alvo = porModelo.has(modelo) ? modelo : '*';
      if ((restantes.get(alvo) ?? 0) > 0) { restantes.set(alvo, restantes.get(alvo) - 1); c.status = 500; }
      const marcas = [...new Set(corpoTexto.match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
      const registro = {
        n: requisicoes.length + 1, quando: Date.now(), modelo, papel, maxTokens: corpo.max_tokens ?? null, mensagens: Array.isArray(corpo.messages) ? corpo.messages.length : 0,
        papeis: Array.isArray(corpo.messages) ? corpo.messages.map((m) => m?.role) : [], marcas, stream: corpo.stream === true,
        chaves: Object.keys(corpo).sort(), sonda: Array.isArray(corpo.messages) && corpo.messages.length === 1 && /Responda apenas com a palavra: ok/.test(String(corpo.messages[0]?.content ?? '')),
      };
      requisicoes.push(registro);
      if (papel === 'desconhecida' || papel === 'sem-chave') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"chave inválida"}}'); return; }
      const responder = () => {
        if (c.cair) { req.socket.destroy(); return; }
        if (c.status !== 200) { res.writeHead(c.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `erro simulado ${c.status}` } })); return; }
        const cabecalhos = { 'Content-Type': 'application/json' };
        const valor = valorDoCabecalho(c);
        if (valor !== null) cabecalhos['X-OmniRoute-Decision'] = valor;
        if (c.corpoInvalido) { res.writeHead(200, cabecalhos); res.end('isto não é JSON'); return; }
        const texto = c.vazio ? '' : `OMNI-FALSO modelo=${modelo} chave=${papel} max=${registro.maxTokens} marcas=[${marcas.join(',')}] mensagens=${registro.mensagens}`;
        res.writeHead(200, cabecalhos);
        res.end(JSON.stringify({ id: 'omni-falso', object: 'chat.completion', model: modelo, choices: [{ index: 0, message: { role: 'assistant', content: texto }, finish_reason: 'stop' }] }));
      };
      if (c.atrasoMs > 0) setTimeout(responder, c.atrasoMs); else responder();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    port,
    requisicoes,
    /** Muda o comportamento (SUBSTITUI o anterior desse alvo): para todos os modelos (`modelo` = '*') ou só para um modelo. */
    definir(modelo, parcial) {
      if (modelo === '*') global = { ...PADRAO, ...parcial };
      else porModelo.set(modelo, { ...parcial });
      restantes.set(modelo, Number(parcial?.falhasAntes) || 0);
    },
    /** Volta ao comportamento padrão e esquece as requisições. */
    limpar() { global = { ...PADRAO }; porModelo.clear(); restantes.clear(); requisicoes.length = 0; },
    /** As requisições de um modelo (e, se quiser, de um papel de chave). */
    doModelo(modelo, papel = null) { return requisicoes.filter((r) => r.modelo === modelo && (!papel || r.papel === papel)); },
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
    },
  };
}
