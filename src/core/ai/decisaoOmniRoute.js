// O cabeçalho `X-OmniRoute-Decision` que o OmniRoute devolve em cada resposta (diz qual estratégia, provedor e latência atenderam).
//
// ATENÇÃO: o FORMATO EXATO deste cabeçalho é DESCONHECIDO (lemos só o README da versão 3.8.52; ninguém conferiu uma resposta real). Por isso
// existem DOIS leitores, com papéis diferentes (decisão da Liz, etapa 9):
//
//  1. leitor TOLERANTE (lerDecisaoTolerante): serve SÓ para DIAGNÓSTICO. Aceita vários formatos plausíveis (JSON, pares chave=valor, texto livre
//     com o nome do provedor), guarda apenas palavras permitidas e números, joga o resto fora e NUNCA lança erro. Quando não acha o provedor,
//     devolve `confirmada: false` (o diagnóstico mostra "não confirmado"). Ele NÃO decide nada de segurança;
//  2. leitor ESTRITO (lerDecisaoEstrita): serve para a DECISÃO de segurança do perfil PRIVADO. Só entende UM formato, declarado de propósito
//     pelo dono na configuração do perfil (`decisao`: { formato: "pares" | "json", campoProvedor, ... }). Cabeçalho ausente, inválido, em formato
//     desconhecido ou sem o campo do provedor = não vale (o perfil privado falha fechado). Sem a definição do formato, o leitor estrito não lê
//     nada: o perfil privado simplesmente não habilita (é o esperado até o Braga confirmar o formato no OmniRoute real).
//
// Nenhum dos dois devolve o texto bruto do cabeçalho: só identificadores curtos já filtrados e números. Um segredo plantado no cabeçalho (uma
// chave, um token) nunca chega ao diagnóstico, ao log nem a uma mensagem de erro.

/** O nome do cabeçalho (comparação sem diferenciar maiúsculas). */
export const CABECALHO_DA_DECISAO = 'x-omniroute-decision';
const MAX_VALOR = 2048;

/** Palavra permitida para provedor ou estratégia: 2 a 40 caracteres, minúsculas, números, ponto, sublinhado e hífen. */
const PALAVRA_RE = /^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/;
/** Identificador de provedor da lista permitida: 1 a 40 caracteres (aceita um único caractere). */
export const ID_DE_PROVEDOR_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Parece um segredo (chave de API, token, senha, texto longo sem separador)? Valor assim nunca passa. */
export function pareceSegredo(texto) {
  const s = String(texto ?? '');
  return /(?:^|[^a-z0-9])(?:sk|gsk|hf|rk|pk|ak|xox[bpa]?|ghp|glpat)[-_]/i.test(s)
    || /aiza[0-9a-z_-]{10,}|bearer|eyj[a-z0-9_-]{8,}|secret|senha|passw|api[-_]?key|authorization|token/i.test(s)
    || /[a-z0-9]{24,}/i.test(s)
    || /^[0-9a-f]{16,}$/i.test(s);
}

/** Uma palavra permitida (provedor ou estratégia) ou null. Nunca devolve algo que pareça segredo. */
export function palavraPermitida(valor) {
  const s = String(valor ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!PALAVRA_RE.test(s) || pareceSegredo(s)) return null;
  return s;
}

const CHAVES_PROVEDOR = new Set(['provider', 'provider_id', 'providerid', 'provedor', 'upstream', 'selected_provider', 'selectedprovider', 'served_by', 'servedby', 'connection']);
const CHAVES_ESTRATEGIA = new Set(['strategy', 'estrategia', 'routing', 'routing_strategy', 'combo_strategy', 'mode']);
const CHAVES_LATENCIA = new Set(['latency', 'latency_ms', 'latencyms', 'duration_ms', 'durationms', 'elapsed', 'elapsed_ms', 'ms', 'took']);

/** Estratégias que o OmniRoute costuma citar (só como palavras reconhecidas no texto livre). */
export const ESTRATEGIAS_CONHECIDAS = Object.freeze(['priority', 'round-robin', 'roundrobin', 'least-used', 'random', 'weighted', 'fill-first', 'lowest-latency', 'cost', 'latency', 'fallback', 'failover', 'sticky']);
/** Provedores que o texto livre pode citar (mais os do cadastro da Yui e os das listas do dono, que quem chama acrescenta). */
export const PROVEDORES_CONHECIDOS = Object.freeze(['groq', 'gemini', 'huggingface', 'openrouter', 'cloudflare', 'together', 'pollinations', 'openai', 'anthropic', 'mistral', 'deepseek', 'cohere', 'perplexity', 'xai', 'nvidia', 'cerebras', 'sambanova', 'fireworks', 'ollama', 'lmstudio', 'antigravity', 'qwen', 'kiro', 'copilot']);

const chaveNormal = (k) => String(k ?? '').trim().toLowerCase().replace(/-/g, '_');

/** "123", "123ms", "1.5s" -> milissegundos inteiros (0 a 10 minutos) ou null. */
function milissegundos(valor) {
  const m = /^\s*(\d{1,7}(?:\.\d{1,3})?)\s*(ms|s)?\s*$/i.exec(String(valor ?? ''));
  if (!m) return null;
  const n = Number(m[1]) * (String(m[2] ?? '').toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(n) && n >= 0 && n <= 600_000 ? Math.round(n) : null;
}

/** Anda pelo objeto (até 3 níveis) e devolve o primeiro valor de texto ou número achado para as chaves de cada categoria. */
function colherDoJson(objeto) {
  const achado = { provedor: null, estrategia: null, latencia: null };
  const fila = [{ valor: objeto, nivel: 0 }];
  while (fila.length) {
    const { valor, nivel } = fila.shift();
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) continue;
    for (const [k, v] of Object.entries(valor)) {
      const chave = chaveNormal(k);
      const comoTexto = typeof v === 'string' || typeof v === 'number' ? String(v) : (v && typeof v === 'object' && !Array.isArray(v) ? (typeof v.id === 'string' ? v.id : typeof v.name === 'string' ? v.name : null) : null);
      if (achado.provedor === null && CHAVES_PROVEDOR.has(chave)) achado.provedor = palavraPermitida(comoTexto);
      else if (achado.estrategia === null && CHAVES_ESTRATEGIA.has(chave)) achado.estrategia = palavraPermitida(comoTexto);
      else if (achado.latencia === null && CHAVES_LATENCIA.has(chave)) achado.latencia = milissegundos(comoTexto);
      else if (v && typeof v === 'object' && !Array.isArray(v) && nivel < 2) fila.push({ valor: v, nivel: nivel + 1 });
    }
  }
  return achado;
}

/**
 * Leitor TOLERANTE (só diagnóstico). Nunca lança.
 * @param {unknown} valor  o texto do cabeçalho (ou null/undefined quando faltou)
 * @param {{ conhecidos?: Iterable<string> }} [o]  provedores a reconhecer no texto livre (além dos embutidos)
 * @returns {{ formato: 'ausente'|'json'|'pares'|'texto'|'ilegivel', confirmada: boolean, provedor: string|null, estrategia: string|null, latenciaMs: number|null }}
 */
export function lerDecisaoTolerante(valor, { conhecidos = [] } = {}) {
  const vazio = (formato) => ({ formato, confirmada: false, provedor: null, estrategia: null, latenciaMs: null });
  try {
    if (valor === null || valor === undefined) return vazio('ausente');
    const texto = String(valor).trim().slice(0, MAX_VALOR);
    if (!texto) return vazio('ausente');
    let formato = 'texto';
    let achado = { provedor: null, estrategia: null, latencia: null };
    if (texto.startsWith('{')) {
      try { achado = colherDoJson(JSON.parse(texto)); formato = 'json'; } catch { formato = 'texto'; }
    }
    if (formato !== 'json') {
      // pares chave=valor (ou chave:valor), separados por ; , | & ou espaço
      for (const m of texto.matchAll(/([A-Za-z_][\w.-]{0,30})\s*[=:]\s*("[^"]{0,80}"|[^\s;,|&]{1,80})/g)) {
        const chave = chaveNormal(m[1]);
        if (achado.provedor === null && CHAVES_PROVEDOR.has(chave)) { achado.provedor = palavraPermitida(m[2]); formato = 'pares'; }
        else if (achado.estrategia === null && CHAVES_ESTRATEGIA.has(chave)) { achado.estrategia = palavraPermitida(m[2]); formato = 'pares'; }
        else if (achado.latencia === null && CHAVES_LATENCIA.has(chave)) { achado.latencia = milissegundos(String(m[2]).replace(/^"|"$/g, '')); formato = 'pares'; }
      }
      // texto livre: só as palavras que a Yui conhece (nunca "qualquer palavra")
      if (achado.provedor === null || achado.estrategia === null) {
        const provedores = new Set([...PROVEDORES_CONHECIDOS, ...[...conhecidos].map((c) => String(c ?? '').toLowerCase())]);
        const estrategias = new Set(ESTRATEGIAS_CONHECIDAS);
        for (const t of texto.toLowerCase().matchAll(/[a-z][a-z0-9._-]{1,38}/g)) {
          const w = t[0].replace(/[._-]+$/, '');
          if (achado.provedor === null && provedores.has(w)) achado.provedor = palavraPermitida(w);
          if (achado.estrategia === null && estrategias.has(w)) achado.estrategia = palavraPermitida(w);
        }
      }
    }
    const provedor = achado.provedor ?? null;
    if (provedor === null && achado.estrategia === null && achado.latencia === null) return { ...vazio('ilegivel') };
    return { formato, confirmada: provedor !== null, provedor, estrategia: achado.estrategia ?? null, latenciaMs: achado.latencia ?? null };
  } catch {
    return vazio('ilegivel');
  }
}

// ── O leitor ESTRITO (a decisão de segurança do perfil privado) ──────────────────────────────────────────────────────────────────────

const CAMPO_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const SEPARADORES = new Set([';', ',', '|']);
const CABECALHO_RE = /^[a-z][a-z0-9-]{1,60}$/;

/**
 * Confere a definição do formato estrito (o campo `decisao` do perfil privado). Só as chaves conhecidas; formato fechado: "pares" ou "json".
 * @returns {{ ok: true, formato: { cabecalho: string, formato: 'pares'|'json', campoProvedor: string, separador: string } } | { ok: false, codigo: string }}
 */
export function validarFormatoEstrito(bruto) {
  if (bruto === undefined || bruto === null) return { ok: false, codigo: 'formato-nao-definido' };
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, codigo: 'formato-invalido' };
  const permitidas = new Set(['formato', 'campoProvedor', 'separador', 'cabecalho']);
  if (Object.keys(bruto).some((k) => !permitidas.has(k))) return { ok: false, codigo: 'formato-invalido' };
  if (bruto.formato !== 'pares' && bruto.formato !== 'json') return { ok: false, codigo: 'formato-invalido' };
  if (typeof bruto.campoProvedor !== 'string' || !CAMPO_RE.test(bruto.campoProvedor)) return { ok: false, codigo: 'formato-invalido' };
  const separador = bruto.separador === undefined ? ';' : bruto.separador;
  if (!SEPARADORES.has(separador)) return { ok: false, codigo: 'formato-invalido' };
  if (bruto.separador !== undefined && bruto.formato === 'json') return { ok: false, codigo: 'formato-invalido' };
  const cabecalho = bruto.cabecalho === undefined ? CABECALHO_DA_DECISAO : String(bruto.cabecalho).toLowerCase();
  if (!CABECALHO_RE.test(cabecalho)) return { ok: false, codigo: 'formato-invalido' };
  return { ok: true, formato: { cabecalho, formato: bruto.formato, campoProvedor: bruto.campoProvedor, separador } };
}

/**
 * Leitor ESTRITO: só vale se o cabeçalho segue EXATAMENTE o formato declarado. Nunca lança.
 * @param {unknown} valor  o texto do cabeçalho
 * @param {ReturnType<typeof validarFormatoEstrito>['formato']|null} formato  a definição conferida (null = não definido)
 * @returns {{ ok: true, provedor: string } | { ok: false, motivo: 'formato-nao-definido'|'cabecalho-ausente'|'cabecalho-invalido'|'formato-desconhecido'|'campo-ausente'|'provedor-invalido' }}
 */
export function lerDecisaoEstrita(valor, formato) {
  try {
    if (!formato) return { ok: false, motivo: 'formato-nao-definido' };
    if (valor === null || valor === undefined) return { ok: false, motivo: 'cabecalho-ausente' };
    if (typeof valor !== 'string') return { ok: false, motivo: 'cabecalho-invalido' };
    if (!valor.trim()) return { ok: false, motivo: 'cabecalho-ausente' };
    if (valor.length > MAX_VALOR || /[\u0000-\u001f\u007f]/.test(valor)) return { ok: false, motivo: 'cabecalho-invalido' };
    let candidato;
    if (formato.formato === 'pares') {
      const segmentos = valor.split(formato.separador).map((s) => s.trim());
      const campos = new Map();
      for (const seg of segmentos) {
        const m = /^([A-Za-z][A-Za-z0-9_.-]{0,40})=([A-Za-z0-9_.:@+/-]{1,80})$/.exec(seg);
        if (!m) return { ok: false, motivo: 'formato-desconhecido' };
        const chave = m[1].toLowerCase();
        if (campos.has(chave)) return { ok: false, motivo: 'formato-desconhecido' };
        campos.set(chave, m[2]);
      }
      if (!campos.has(formato.campoProvedor.toLowerCase())) return { ok: false, motivo: 'campo-ausente' };
      candidato = campos.get(formato.campoProvedor.toLowerCase());
    } else {
      if (!valor.trim().startsWith('{')) return { ok: false, motivo: 'formato-desconhecido' };
      let objeto;
      try { objeto = JSON.parse(valor); } catch { return { ok: false, motivo: 'formato-desconhecido' }; }
      if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return { ok: false, motivo: 'formato-desconhecido' };
      let atual = objeto;
      for (const parte of formato.campoProvedor.split('.')) {
        if (!atual || typeof atual !== 'object' || Array.isArray(atual) || !Object.hasOwn(atual, parte)) return { ok: false, motivo: 'campo-ausente' };
        atual = atual[parte];
      }
      if (typeof atual !== 'string') return { ok: false, motivo: 'provedor-invalido' };
      candidato = atual;
    }
    const provedor = String(candidato).trim().toLowerCase();
    if (!ID_DE_PROVEDOR_RE.test(provedor) || pareceSegredo(provedor)) return { ok: false, motivo: 'provedor-invalido' };
    return { ok: true, provedor };
  } catch {
    return { ok: false, motivo: 'cabecalho-invalido' };
  }
}
