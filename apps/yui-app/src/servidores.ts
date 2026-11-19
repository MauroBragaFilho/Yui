import { ApiError, normalizeBaseUrl, parseServerUrl, type FonteDeServidor } from './api/client.ts';
import { resolveServerUrl } from './serverUrl.ts';

/**
 * Os endereços do servidor da Yui: a lista do build (rede local e Tailscale), a escolha do que responde e o texto da aba Status.
 * Arquivo SEM React e sem Expo, testado em Node (tests/servidores-logic.test.mjs).
 *
 * Regras:
 *  - a lista vem do build (EXPO_PUBLIC_YUI_SERVER_URLS), em ordem de preferência; o primeiro é o preferido e os outros são reserva;
 *  - com UM só endereço (ou na web) nada muda: sem sonda, sem reserva, como sempre foi;
 *  - com dois ou mais, o app sonda `GET <endereço>/v1/health` (só leitura, SEM token) e usa o primeiro que responde `ok`; lembra o último que funcionou;
 *  - o token e a senha só vão a um endereço que passou pela sonda (ver `FonteDeServidor` em api/client.ts).
 */

/** No máximo quantos endereços o app aceita no build. */
export const MAX_ENDERECOS = 4;
/** Prazo da sonda: o primeiro endereço sondado, e os seguintes (mais folga para o reserva, que costuma ser mais lento). */
export const PRAZO_PRIMEIRO_MS = 2500;
export const PRAZO_DEMAIS_MS = 4000;

export const AVISO_TODOS_INVALIDOS = 'Os endereços do servidor configurados neste app são inválidos.';
export const MSG_NENHUM_RESPONDEU = 'Não foi possível conectar ao servidor. Nenhum dos endereços respondeu: verifique a rede, o Tailscale e se o PC está ligado.';

// ───────────────────────── Lista de endereços do build ─────────────────────────

export interface ListaDeEnderecos {
  /** Endereços válidos, normalizados, sem repetidos, na ordem de preferência (no máximo MAX_ENDERECOS). */
  enderecos: string[];
  /** Itens inválidos que foram ignorados. */
  invalidos: number;
  /** Itens repetidos que foram ignorados. */
  repetidos: number;
  /** Itens válidos além do limite, ignorados. */
  excedentes: number;
}

/** O endereço normalizado (`http://host:porta`), ou null se o item não serve: só http/https, host e porta válidos, SEM usuário/senha. */
export function validarEndereco(item: string | null | undefined): string | null {
  const texto = String(item ?? '').trim();
  if (!texto) return null;
  try {
    const url = parseServerUrl(texto);
    if (url.username !== '' || url.password !== '') return null; // credenciais na URL: nunca (iriam parar em log e em tela)
    if (!url.hostname) return null;
    if (url.port !== '') {
      const porta = Number(url.port);
      if (!Number.isInteger(porta) || porta < 1 || porta > 65535) return null;
    }
    return normalizeBaseUrl(texto);
  } catch {
    return null;
  }
}

/** Lê a lista separada por vírgula (ordem de preferência). Item inválido é ignorado; repetido e excedente também. */
export function lerListaDeEnderecos(bruto: string | null | undefined): ListaDeEnderecos {
  const out: ListaDeEnderecos = { enderecos: [], invalidos: 0, repetidos: 0, excedentes: 0 };
  for (const parte of String(bruto ?? '').split(',')) {
    if (!parte.trim()) continue; // vírgula sobrando não é item
    const endereco = validarEndereco(parte);
    if (!endereco) { out.invalidos += 1; continue; }
    if (out.enderecos.includes(endereco)) { out.repetidos += 1; continue; }
    if (out.enderecos.length >= MAX_ENDERECOS) { out.excedentes += 1; continue; }
    out.enderecos.push(endereco);
  }
  return out;
}

// ───────────────────────── Configuração do app ─────────────────────────

export interface ConfigServidoresInput {
  /** Valor de EXPO_PUBLIC_YUI_SERVER_URLS (lista). */
  lista?: string | null;
  /** Valor de EXPO_PUBLIC_YUI_SERVER_URL (um só). */
  env?: string | null;
  /** EXPO_PUBLIC_YUI_API_PORT (só na web). */
  apiPort?: string | number | null;
  platform: string;
  location?: { protocol: string; hostname: string } | null;
}

export interface ConfigServidores {
  /** Em ordem de preferência. Vazio = servidor não configurado (ou todos inválidos). */
  enderecos: string[];
  origem: 'lista' | 'unico' | 'web' | 'nenhuma';
  /** Aviso curto para a tela quando o build trouxe endereços e NENHUM serve. */
  aviso: string | null;
  /** Quantos itens da lista foram ignorados (inválidos, repetidos ou além do limite). */
  ignorados: number;
}

/**
 * Qual(is) servidor(es) o app usa.
 *  - Web: como sempre foi (o mesmo computador que serviu a página; ou EXPO_PUBLIC_YUI_SERVER_URL, se vier). A lista NÃO vale na web.
 *  - Android/iOS: a lista, se existir; senão o endereço único; senão nenhum.
 */
export function lerConfigServidores(input: ConfigServidoresInput): ConfigServidores {
  const { lista, env, apiPort, platform, location } = input;
  if (platform === 'web') {
    const url = resolveServerUrl({ env, apiPort, platform, location });
    const configurouEnv = String(env ?? '').trim() !== '';
    return { enderecos: url ? [url] : [], origem: 'web', aviso: !url && configurouEnv ? AVISO_TODOS_INVALIDOS : null, ignorados: 0 };
  }
  if (String(lista ?? '').trim()) {
    const l = lerListaDeEnderecos(lista);
    return {
      enderecos: l.enderecos,
      origem: 'lista',
      aviso: l.enderecos.length === 0 ? AVISO_TODOS_INVALIDOS : null,
      ignorados: l.invalidos + l.repetidos + l.excedentes,
    };
  }
  const configurouEnv = String(env ?? '').trim() !== '';
  const url = resolveServerUrl({ env, apiPort, platform, location });
  if (url) return { enderecos: [url], origem: 'unico', aviso: null, ignorados: 0 };
  return { enderecos: [], origem: 'nenhuma', aviso: configurouEnv ? AVISO_TODOS_INVALIDOS : null, ignorados: 0 };
}

// ───────────────────────── Texto da aba Status ─────────────────────────

export const ROTULO_PREFERIDO = 'rede local';
export const ROTULO_RESERVA = 'reserva';

export interface Escolha {
  url: string;
  /** Posição na lista do build (0 = o preferido). */
  indice: number;
  /** Quantos endereços o build tem. */
  total: number;
  preferido: boolean;
}

/** "Servidor: <host> (rede local)" para o preferido e "(reserva)" para os demais. O rótulo vem da ORDEM da lista, não de adivinhar a rede. Com um só endereço, sem rótulo. */
export function textoDoServidor(escolha: Escolha | null, procurando = false): string {
  if (!escolha) return procurando ? 'Servidor: procurando…' : 'Servidor: sem resposta';
  const host = escolha.url.replace(/^https?:\/\//i, '');
  if (escolha.total < 2) return `Servidor: ${host}`;
  return `Servidor: ${host} (${escolha.indice === 0 ? ROTULO_PREFERIDO : ROTULO_RESERVA})`;
}

// ───────────────────────── A sonda ─────────────────────────

export interface OpcoesDaSonda {
  fetchImpl?: typeof fetch;
  prazoMs: number;
  /** O relógio (setTimeout). Só os testes trocam. */
  agendar?: typeof setTimeout;
}

/**
 * `GET <endereço>/v1/health`: só leitura e SEM nenhum cabeçalho de login. Responde "sim" só com HTTP 2xx e `{ "ok": true }`; qualquer falha, resposta de outro tipo
 * ou prazo esgotado é "não". Nunca lança.
 */
export async function sondarEndereco(url: string, { fetchImpl, prazoMs, agendar }: OpcoesDaSonda): Promise<boolean> {
  const doFetch: typeof fetch = fetchImpl ?? ((...args) => fetch(...args));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<boolean>((resolve) => {
    timer = (agendar ?? setTimeout)(() => { controller.abort(); resolve(false); }, prazoMs);
  });
  const sonda = (async () => {
    try {
      const res = await doFetch(`${url}/v1/health`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* sem corpo para soltar */ }
        return false;
      }
      const data: unknown = await res.json();
      return Boolean(data && typeof data === 'object' && (data as { ok?: unknown }).ok === true);
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([sonda, prazo]);
  } finally {
    clearTimeout(timer);
  }
}

/** A ordem da sonda: o último que funcionou primeiro (se ainda está na lista do build); depois os outros, na ordem de preferência. */
export function ordemDaSonda(enderecos: string[], lembrado: string | null | undefined): string[] {
  if (lembrado && enderecos.includes(lembrado)) return [lembrado, ...enderecos.filter((e) => e !== lembrado)];
  return [...enderecos];
}

// ───────────────────────── O gerenciador ─────────────────────────

/** Onde o app guarda o último endereço que funcionou (só o endereço, nada mais). */
export interface ArmazemDoLembrado {
  carregar(): Promise<string | null>;
  salvar(url: string): Promise<void>;
}

export interface OpcoesDoGerenciador {
  /** Os endereços do build, em ordem de preferência. */
  enderecos: string[];
  fetchImpl?: typeof fetch;
  lembrado?: ArmazemDoLembrado;
  prazoPrimeiroMs?: number;
  prazoDemaisMs?: number;
  /** O relógio (setTimeout). Só os testes trocam. */
  agendar?: typeof setTimeout;
}

export interface GerenciadorDeServidor extends FonteDeServidor {
  readonly enderecos: string[];
  /** Há mais de um endereço (sonda e reserva). Com um só, tudo é fixo. */
  readonly alterna: boolean;
  /** A escolha de agora (null = ainda não escolheu, ou nenhum respondeu). */
  escolha(): Escolha | null;
  /** Está sondando neste momento. */
  procurando(): boolean;
  /** Sonda na ordem e escolhe o primeiro que responde. Chamadas ao mesmo tempo dividem a mesma sonda. */
  escolher(): Promise<Escolha | null>;
  /** Avisa quando a escolha muda (para a tela). Devolve a função que cancela o aviso. */
  aoMudar(ouvinte: () => void): () => void;
}

export function criarGerenciadorDeServidor(opcoes: OpcoesDoGerenciador): GerenciadorDeServidor {
  const enderecos = [...opcoes.enderecos];
  if (enderecos.length === 0) throw new ApiError(0, 'Nenhum endereço de servidor configurado.');
  const total = enderecos.length;
  const alterna = total > 1;
  const prazoPrimeiro = opcoes.prazoPrimeiroMs ?? PRAZO_PRIMEIRO_MS;
  const prazoDemais = opcoes.prazoDemaisMs ?? PRAZO_DEMAIS_MS;
  const ouvintes = new Set<() => void>();
  const fixa: Escolha = { url: enderecos[0], indice: 0, total, preferido: true };
  let escolhaAtual: Escolha | null = alterna ? null : fixa;
  let emAndamento: Promise<Escolha | null> | null = null;
  let ultimoSalvo: string | null = null;

  function avisar() {
    for (const o of [...ouvintes]) {
      try { o(); } catch { /* um ouvinte com defeito não derruba a escolha */ }
    }
  }

  async function lembradoDoArmazem(): Promise<string | null> {
    try {
      const guardado = (await opcoes.lembrado?.carregar()) ?? null;
      if (guardado) ultimoSalvo = guardado; // já está guardado: escolher o mesmo não regrava
      return guardado;
    } catch { return null; }
  }

  async function lembrar(url: string) {
    if (!opcoes.lembrado || ultimoSalvo === url) return;
    ultimoSalvo = url;
    try { await opcoes.lembrado.salvar(url); } catch { /* sem armazenamento: só não lembra */ }
  }

  function escolher(): Promise<Escolha | null> {
    if (!alterna) return Promise.resolve(fixa);
    if (emAndamento) return emAndamento;
    const trabalho = (async (): Promise<Escolha | null> => {
      const ordem = ordemDaSonda(enderecos, await lembradoDoArmazem());
      for (let i = 0; i < ordem.length; i += 1) {
        // A sonda NÃO leva token; só depois dela o cliente pode usar o endereço.
        if (await sondarEndereco(ordem[i], { fetchImpl: opcoes.fetchImpl, agendar: opcoes.agendar, prazoMs: i === 0 ? prazoPrimeiro : prazoDemais })) {
          const indice = enderecos.indexOf(ordem[i]);
          escolhaAtual = { url: ordem[i], indice, total, preferido: indice === 0 };
          await lembrar(ordem[i]);
          return escolhaAtual;
        }
      }
      escolhaAtual = null;
      return null;
    })().finally(() => {
      emAndamento = null;
      avisar();
    });
    emAndamento = trabalho;
    avisar();
    return trabalho;
  }

  return {
    enderecos,
    alterna,
    escolha: () => escolhaAtual,
    procurando: () => emAndamento !== null,
    escolher,
    aoMudar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => { ouvintes.delete(ouvinte); };
    },
    async baseUrl() {
      if (escolhaAtual) return escolhaAtual.url;
      const e = await escolher();
      if (!e) throw new ApiError(0, MSG_NENHUM_RESPONDEU, 'conexao');
      return e.url;
    },
    async refazer(falhou) {
      if (!alterna) return null; // sem reserva: não há o que escolher
      if (emAndamento) return (await emAndamento)?.url ?? null; // outra falha já está refazendo: divide o resultado
      if (escolhaAtual && escolhaAtual.url !== falhou) return escolhaAtual.url; // outro pedido já refez a escolha
      escolhaAtual = null;
      return (await escolher())?.url ?? null;
    },
    atual: () => (escolhaAtual ?? fixa).url,
  };
}
