// PONTO DE LIGAÇÃO DA IA LOCAL (perfil `local`, RESERVADO) (docs/PREPARO_ITEM_7.md). PREPARADO e DESLIGADO: sem YUI_IA_LOCAL_URL (o padrão: vazio) nada aqui toca a rede.
//
// O que existe: UMA função que testa um servidor compatível com a API da OpenAI (LM Studio, Ollama, llama.cpp...) pedindo a lista de modelos (GET <base>/models) e devolve
// o ESTADO para o diagnóstico: "desligado" (a chave está vazia), "sem resposta" ou "ok, N modelos".
// O que NÃO existe: ativação. O perfil `local` continua RESERVADO e RECUSADO em src/core/ai/perfis.js (`habilitado: true` dá erro; `perfisAtivos` nunca o devolve), e nenhuma chamada
// de conversa passa por aqui. Estar "ok" aqui NÃO liga nada: só diz que o endereço responde. A IA local fica adiada (por enquanto só provedores externos); os critérios de entrada
// estão em docs/PREPARO_ITEM_7.md.
// Segurança: o endereço precisa ser da PRÓPRIA máquina ou da rede local (127.x, localhost, 10.x, 172.16 a 31.x, 192.168.x, 100.64 a 127.x do Tailscale), sem usuário e senha e sem
// parâmetros; nada de nome de computador (um nome pode apontar para fora). Não segue redirecionamento (poderia levar para fora). Nenhuma chave de API é lida nem enviada (o
// teste é um GET simples de leitura). A resposta é lida com limite de tamanho. O resultado nunca traz o endereço nem o conteúdo de uma resposta: só o estado, a contagem e
// os ids dos modelos (curtos e limpos).
export const VAR_URL = 'YUI_IA_LOCAL_URL';
/** O perfil `local` NUNCA está ativo nesta fase (reservado). Constante de propósito: ligar a IA local é uma etapa futura, com os critérios do docs/PREPARO_ITEM_7.md. */
export const PERFIL_LOCAL_ATIVO = false;
export const TIMEOUT_PADRAO_MS = 3000;
export const RESPOSTA_MAX_CARACTERES = 256 * 1024;
const MODELOS_MOSTRADOS = 8;

/** O que está em YUI_IA_LOCAL_URL (vazio = desligado). */
export const urlLocalConfigurada = (env = process.env) => String(env?.YUI_IA_LOCAL_URL ?? '').trim();

/** O perfil `local` está ativo? Nunca (veja PERFIL_LOCAL_ATIVO). */
export const perfilLocalAtivo = () => PERFIL_LOCAL_ATIVO;

function ehEnderecoLocal(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // nome de computador: pode apontar para fora
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * O endereço é aceito? Devolve a URL do GET /models. Sem "/v1" no endereço, a Yui acrescenta (o padrão dos servidores compatíveis com a API da OpenAI).
 * @returns {{ ok: true, modelosUrl: string } | { ok: false, codigo: 'url-invalida'|'protocolo-nao-permitido'|'endereco-nao-local'|'url-com-credencial-ou-parametro' }}
 */
export function validarUrlLocal(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return { ok: false, codigo: 'url-invalida' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, codigo: 'protocolo-nao-permitido' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, codigo: 'url-com-credencial-ou-parametro' };
  if (!ehEnderecoLocal(u.hostname)) return { ok: false, codigo: 'endereco-nao-local' };
  const caminho = u.pathname.replace(/\/+$/, '');
  if (caminho && !/^\/[\w./-]{0,100}$/.test(caminho)) return { ok: false, codigo: 'url-invalida' };
  return { ok: true, modelosUrl: `${u.origin}${caminho || '/v1'}/models` };
}

const plural = (n) => `${n} ${n === 1 ? 'modelo' : 'modelos'}`;
const resultado = (estado, texto, extra = {}) => ({ estado, texto, modelos: 0, nomes: [], perfilAtivo: false, codigo: null, ...extra });

/**
 * Testa o servidor local. Só chama a rede quando YUI_IA_LOCAL_URL está preenchida. Nunca lança.
 * @returns {Promise<{ estado: 'desligado'|'invalido'|'sem-resposta'|'ok', texto: string, modelos: number, nomes: string[], perfilAtivo: false, codigo: string|null }>}
 *   `texto`: "desligado", "endereço inválido", "sem resposta" ou "ok, N modelos".
 */
export async function testarIaLocal({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_PADRAO_MS } = {}) {
  const url = urlLocalConfigurada(env);
  if (!url) return resultado('desligado', 'desligado');
  const v = validarUrlLocal(url);
  if (!v.ok) return resultado('invalido', 'endereço inválido', { codigo: v.codigo });
  const semResposta = (codigo) => resultado('sem-resposta', 'sem resposta', { codigo });
  if (typeof fetchImpl !== 'function') return semResposta('sem-fetch');
  let res;
  try {
    res = await fetchImpl(v.modelosUrl, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return semResposta(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'rede');
  }
  if (!res.ok) return semResposta(`http-${res.status}`);
  const declarado = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declarado) && declarado > RESPOSTA_MAX_CARACTERES) return semResposta('resposta-grande');
  let texto;
  try { texto = await res.text(); } catch { return semResposta('leitura'); }
  if (texto.length > RESPOSTA_MAX_CARACTERES) return semResposta('resposta-grande');
  let json;
  try { json = JSON.parse(texto); } catch { return semResposta('json-invalido'); }
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) return semResposta('formato-invalido'); // não parece um servidor compatível com a API da OpenAI
  const nomes = json.data
    .map((m) => (typeof m?.id === 'string' ? m.id.replace(/[^\w.:@/ -]/g, '').slice(0, 80) : ''))
    .filter(Boolean)
    .slice(0, MODELOS_MOSTRADOS);
  return resultado('ok', `ok, ${plural(json.data.length)}`, { modelos: json.data.length, nomes });
}

/**
 * Uma sonda com memória curta (o diagnóstico é consultado com frequência e não pode bater no servidor a cada vez). Muda o endereço, esquece o resultado.
 * @param {{ env?: object, fetchImpl?: typeof fetch, timeoutMs?: number, ttlMs?: number, agora?: () => number }} [o]
 */
export function criarSondaLocal({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_PADRAO_MS, ttlMs = 30_000, agora = Date.now } = {}) {
  let guardado = null; // { url, em, valor }
  let andando = null;
  return {
    async verificar({ forcar = false } = {}) {
      const url = urlLocalConfigurada(env);
      if (!url) return testarIaLocal({ env, fetchImpl, timeoutMs }); // desligado: não há o que guardar nem rede
      if (!forcar && guardado && guardado.url === url && agora() - guardado.em < ttlMs) return guardado.valor;
      if (andando) return andando;
      andando = testarIaLocal({ env, fetchImpl, timeoutMs }).then((valor) => { guardado = { url, em: agora(), valor }; return valor; }).finally(() => { andando = null; });
      return andando;
    },
  };
}

/** O que o diagnóstico mostra (lista de permitidos: estado, texto e contagem; nunca o endereço, e o perfil nunca ativo). */
export function diagnosticoDaIaLocal(r) {
  return { estado: String(r?.estado ?? 'desligado'), texto: String(r?.texto ?? 'desligado'), modelos: Number.isInteger(r?.modelos) ? r.modelos : 0, perfilAtivo: PERFIL_LOCAL_ATIVO };
}
