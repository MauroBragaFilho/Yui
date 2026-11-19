import { ApiError, normalizeBaseUrl, parseServerUrl, type FonteDeServidor } from './api/client.ts';
import { resolveServerUrl } from './serverUrl.ts';
import { lerChavePublica, verificarIdentidade } from './identidade.ts';

/**
 * Os endereços do servidor da Yui: a lista do build (rede local e Tailscale), a escolha do que responde e o texto da aba Status.
 * Arquivo SEM React e sem Expo, testado em Node (tests/servidores-logic.test.mjs e tests/identidade-servidor.test.mjs).
 *
 * Regras:
 *  - a lista vem do build (EXPO_PUBLIC_YUI_SERVER_URLS), em ordem de preferência; o primeiro é o preferido e os outros são reserva;
 *  - com UM só endereço (ou na web) nada muda: sem sonda, sem reserva, como sempre foi;
 *  - com dois ou mais, o app sonda `GET <endereço>/v1/health` (só leitura, SEM token) e usa o primeiro que responde `ok`; lembra o último que funcionou;
 *  - IDENTIDADE (quando o build tem EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY): depois da sonda de saúde o app confere a assinatura Ed25519 do servidor sobre um desafio novo
 *    (identidade.ts). Só com a assinatura válida o endereço é aceito: um servidor que responde `/v1/health` mas não tem a chave privada é REJEITADO, mesmo com um
 *    endereço só. Vale a cada escolha (inclusive a do "lembrado") e de novo depois de uma queda de rede ou de `VALIDADE_DA_PROVA_MS`. Falha FECHADA: sem prova, nada é enviado;
 *  - o token e a senha só vão a um endereço que passou pela sonda (e pela identidade, quando o build a exige) (ver `FonteDeServidor` em api/client.ts).
 */

/** No máximo quantos endereços o app aceita no build. */
export const MAX_ENDERECOS = 4;
/** Prazo da sonda: o primeiro endereço sondado, e os seguintes (mais folga para o reserva, que costuma ser mais lento). */
export const PRAZO_PRIMEIRO_MS = 2500;
export const PRAZO_DEMAIS_MS = 4000;

export const AVISO_TODOS_INVALIDOS = 'Os endereços do servidor configurados neste app são inválidos.';
export const MSG_NENHUM_RESPONDEU = 'Não foi possível conectar ao servidor. Nenhum dos endereços respondeu: verifique a rede, o Tailscale e se o PC está ligado.';
/** Um endereço respondeu, mas não provou ser a Yui (sem assinatura, assinatura inválida, 404...): nada foi enviado a ele. */
export const MSG_IDENTIDADE_NAO_CONFIRMADA = 'Não consegui confirmar que este servidor é a sua Yui.';
/** O build exige a prova de identidade, mas este app não tem como gerar um número aleatório seguro (veja `nonceAleatorio`): não conecta. */
export const MSG_SEM_ALEATORIO = 'Este app foi gerado sem a função que confirma o servidor (números aleatórios seguros). Peça uma versão nova.';
export const AVISO_IDENTIDADE_INVALIDA = 'A chave de identidade do servidor configurada neste app é inválida.';
/** Quanto tempo uma prova de identidade vale: depois disso a próxima requisição confere de novo (o celular pode ter trocado de rede sem que nada caísse). */
export const VALIDADE_DA_PROVA_MS = 60_000;

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
  /** Valor de EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY: a chave PÚBLICA Ed25519 do servidor (base64, 32 bytes). Só vale no Android/iOS; na web é ignorada. */
  identidadePubkey?: string | null;
}

export interface ConfigServidores {
  /** Em ordem de preferência. Vazio = servidor não configurado (ou todos inválidos, ou a chave de identidade do build é inválida). */
  enderecos: string[];
  origem: 'lista' | 'unico' | 'web' | 'nenhuma';
  /** Aviso curto para a tela quando o build trouxe endereços e NENHUM serve (ou a chave de identidade não serve). */
  aviso: string | null;
  /** Quantos itens da lista foram ignorados (inválidos, repetidos ou além do limite). */
  ignorados: number;
  /** A chave pública (32 bytes, já validada) com que o app confere a identidade do servidor. null = o build não exige a prova (como sempre foi). */
  chavePublica: Uint8Array | null;
}

/**
 * Qual(is) servidor(es) o app usa e se o build exige a prova de identidade.
 *  - Web: como sempre foi (o mesmo computador que serviu a página; ou EXPO_PUBLIC_YUI_SERVER_URL, se vier). A lista e a chave de identidade NÃO valem na web.
 *  - Android/iOS: a lista, se existir; senão o endereço único; senão nenhum. Com EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY, a prova de identidade é exigida; se a chave
 *    do build não serve (base64 ruim, tamanho errado, ponto fora da curva ou de ordem pequena), o app NÃO conecta em lugar nenhum (falha fechada).
 */
export function lerConfigServidores(input: ConfigServidoresInput): ConfigServidores {
  const base = lerEnderecos(input);
  if (input.platform === 'web') return { ...base, chavePublica: null };
  const bruto = String(input.identidadePubkey ?? '').trim();
  if (!bruto) return { ...base, chavePublica: null };
  const chavePublica = lerChavePublica(bruto);
  if (!chavePublica) return { ...base, enderecos: [], aviso: AVISO_IDENTIDADE_INVALIDA, chavePublica: null };
  return { ...base, chavePublica };
}

function lerEnderecos(input: ConfigServidoresInput): Omit<ConfigServidores, 'chavePublica'> {
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
  /** A identidade do servidor foi conferida (assinatura Ed25519 válida). Só existe quando o build exige a prova. */
  confirmado?: boolean;
}

/**
 * "Servidor: <host> (rede local)" para o preferido e "(reserva)" para os demais. O rótulo vem da ORDEM da lista, não de adivinhar a rede. Com um só endereço, sem rótulo.
 * Quando a identidade foi conferida, acrescenta "confirmado". `naoConfirmado`: o último endereço que respondeu não provou ser a Yui (diferente de "sem resposta").
 */
export function textoDoServidor(escolha: Escolha | null, procurando = false, naoConfirmado = false): string {
  if (!escolha) return procurando ? 'Servidor: procurando…' : naoConfirmado ? 'Servidor: não confirmado' : 'Servidor: sem resposta';
  const host = escolha.url.replace(/^https?:\/\//i, '');
  const selo = escolha.confirmado ? 'confirmado' : '';
  if (escolha.total < 2) return `Servidor: ${host}${selo ? ` (${selo})` : ''}`;
  return `Servidor: ${host} (${[escolha.indice === 0 ? ROTULO_PREFERIDO : ROTULO_RESERVA, selo].filter(Boolean).join(', ')})`;
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
  /**
   * Exige a prova de identidade (Ed25519) de cada endereço, depois da sonda de saúde. Sem isto, o comportamento é o de sempre.
   * `gerarNonce`: a fonte do desafio (padrão: `nonceAleatorio`, que usa só `getRandomValues`; sem fonte segura a prova falha fechada).
   */
  identidade?: { chavePublica: Uint8Array; gerarNonce?: () => string };
  /** O horário de agora, em ms (para a validade da prova). Só os testes trocam. */
  agora?: () => number;
}

export interface GerenciadorDeServidor extends FonteDeServidor {
  readonly enderecos: string[];
  /** Há mais de um endereço (sonda e reserva). Com um só, tudo é fixo (a menos que o build exija a prova de identidade). */
  readonly alterna: boolean;
  /** O build exige a prova de identidade: nenhum endereço recebe senha nem token sem ela. */
  readonly exigeIdentidade: boolean;
  /** A última escolha falhou porque um endereço respondeu mas não provou ser a Yui (e não porque ninguém respondeu). */
  naoConfirmado(): boolean;
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
  const identidade = opcoes.identidade ?? null;
  const exigeIdentidade = identidade !== null;
  const alterna = total > 1;
  // Sonda (e prova) antes de usar um endereço: com mais de um endereço, ou com UM só quando o build exige a prova de identidade. Sem nenhum dos dois, tudo é fixo, como sempre foi.
  const verifica = alterna || exigeIdentidade;
  const prazoPrimeiro = opcoes.prazoPrimeiroMs ?? PRAZO_PRIMEIRO_MS;
  const prazoDemais = opcoes.prazoDemaisMs ?? PRAZO_DEMAIS_MS;
  const agora = opcoes.agora ?? (() => Date.now());
  const ouvintes = new Set<() => void>();
  const fixa: Escolha = { url: enderecos[0], indice: 0, total, preferido: true };
  let escolhaAtual: Escolha | null = verifica ? null : fixa;
  let emAndamento: Promise<Escolha | null> | null = null;
  let ultimoSalvo: string | null = null;
  let confirmadaEm = 0;
  let motivoDaFalha: 'sem-resposta' | 'identidade' | 'sem-aleatorio' = 'sem-resposta';

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

  /** A prova de identidade tem validade: passado o prazo, a próxima requisição confere de novo antes de enviar qualquer coisa. */
  const provaVencida = () => exigeIdentidade && agora() - confirmadaEm >= VALIDADE_DA_PROVA_MS;

  function mensagemDaFalha(): string {
    if (motivoDaFalha === 'sem-aleatorio') return MSG_SEM_ALEATORIO;
    if (motivoDaFalha === 'identidade') return MSG_IDENTIDADE_NAO_CONFIRMADA;
    return MSG_NENHUM_RESPONDEU;
  }

  function escolher(): Promise<Escolha | null> {
    if (!verifica) return Promise.resolve(fixa);
    if (emAndamento) return emAndamento;
    const trabalho = (async (): Promise<Escolha | null> => {
      motivoDaFalha = 'sem-resposta';
      const ordem = ordemDaSonda(enderecos, await lembradoDoArmazem());
      for (let i = 0; i < ordem.length; i += 1) {
        const prazoMs = i === 0 ? prazoPrimeiro : prazoDemais;
        // A sonda NÃO leva token; só depois dela (e da prova de identidade, quando o build a exige) o cliente pode usar o endereço.
        if (!(await sondarEndereco(ordem[i], { fetchImpl: opcoes.fetchImpl, agendar: opcoes.agendar, prazoMs }))) continue;
        if (identidade) {
          const prova = await verificarIdentidade(ordem[i], { chavePublica: identidade.chavePublica, gerarNonce: identidade.gerarNonce, fetchImpl: opcoes.fetchImpl, agendar: opcoes.agendar, prazoMs });
          if (prova === 'sem-aleatorio') { motivoDaFalha = 'sem-aleatorio'; break; } // sem fonte segura não há prova possível: nem adianta tentar os outros
          if (prova !== 'ok') { motivoDaFalha = 'identidade'; continue; } // respondeu, mas não provou ser a Yui: rejeitado como se não respondesse
        }
        const indice = enderecos.indexOf(ordem[i]);
        escolhaAtual = { url: ordem[i], indice, total, preferido: indice === 0, ...(exigeIdentidade ? { confirmado: true } : {}) };
        confirmadaEm = agora();
        await lembrar(ordem[i]);
        return escolhaAtual;
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
    exigeIdentidade,
    naoConfirmado: () => escolhaAtual === null && motivoDaFalha !== 'sem-resposta',
    escolha: () => escolhaAtual,
    procurando: () => emAndamento !== null,
    escolher,
    aoMudar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => { ouvintes.delete(ouvinte); };
    },
    async baseUrl() {
      if (escolhaAtual && !provaVencida()) return escolhaAtual.url;
      const e = await escolher();
      if (!e) throw new ApiError(0, mensagemDaFalha(), 'conexao');
      return e.url;
    },
    async refazer(falhou) {
      if (!alterna) {
        // sem reserva não há outro endereço, mas depois de uma queda a identidade vale de novo: a próxima requisição confere antes de enviar qualquer coisa
        if (exigeIdentidade) escolhaAtual = null;
        return null;
      }
      if (emAndamento) return (await emAndamento)?.url ?? null; // outra falha já está refazendo: divide o resultado
      if (escolhaAtual && escolhaAtual.url !== falhou) return escolhaAtual.url; // outro pedido já refez a escolha
      escolhaAtual = null;
      return (await escolher())?.url ?? null;
    },
    atual: () => (escolhaAtual ?? fixa).url,
  };
}
