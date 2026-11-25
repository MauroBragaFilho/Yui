// Voz unificada, lado do BOT (Fase 1, desenho em docs/DESENHO_FASE1_YUI_PERSONAL_AI.md, parecer da Liz).
//
// Toda a lógica nova da voz mora AQUI para o voiceHandler.js e o llmHandler.js (arquivos enormes) mudarem pouco: eles só chamam
// este módulo atrás de YUI_VOZ_UNIFICADA. Com a chave desligada nada daqui roda e o comportamento é o de sempre.
//
// O que o bot faz (e o cérebro NÃO consegue fazer sozinho): ver o Discord. Ele MEDE quem está na call (humanos, dono, falante),
// manda só FATOS ao cérebro (nunca um "nível" pronto) e confere de novo, com fatos recontados AGORA, antes de entregar a resposta,
// executar uma ferramenta ou deixar o texto sair. Dúvida = público. A decisão é por CÓDIGO, antes da IA; o prompt nunca decide.
//
// Sem texto de conversa, nomes ou ids de pessoa em log, auditoria e métricas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    decidirAudiencia,
    revalidar,
    ferramentaPermitida,
    fatosDaVoz,
    lerChavesVoz,
    NIVEL
} from '../core/politicaAudiencia.js';
import { registrarAudiencia } from '../core/auditoriaAudiencia.js';
import { criarMedidor } from '../core/latenciaVoz.js';
import { isOwnerId } from '../core/permissions.js';
import { wakeWordInFirstWords } from '../services/tts/policy.js';
import { logger } from '../utils/logger.js';

// ── Textos fixos (nunca derivados de conversa) ──
export const FRASE_MUDOU_CALL = 'Mudou quem está na call, então não respondo isso agora.';
export const FRASE_PRAZO = 'Demorei demais para responder isso.';
export const AVISO_DM_PRIVADA = 'Respondi por mensagem privada.';
export const AVISO_DM_FALHOU = 'Não consegui te responder por mensagem privada.';

/**
 * Lista FECHADA de ferramentas de leitura que a voz privada pode usar (YUI_VOZ_TOOLS). Constante de código: nem o modelo nem a
 * transcrição acrescentam nada. Fora dela (download, imagem, ban, entrar/sair da call, interruptores, escrita) nada roda por voz.
 *  - convert_currency/gta_online/check_game_info/check_steam: consulta pública, nada gravado e nada do usuário;
 *  - listar_lembretes: dado PESSOAL, só quando a decisão tem memória e contexto pessoais (voz privada).
 */
export const FERRAMENTAS_LEITURA_VOZ = Object.freeze(['gta_online', 'convert_currency', 'check_game_info', 'check_steam']);
export const FERRAMENTAS_PESSOAIS_VOZ = Object.freeze(['listar_lembretes']);

export const vozUnificadaOn = (env = process.env) => lerChavesVoz(env).unificada === true;

/** 12 hex aleatórios por turno: NUNCA o id da mensagem nem o do usuário. */
export const novoTurnoId = () => crypto.randomBytes(6).toString('hex');

// ──────────────────────────────────────────────────────────────────────────────
// Medição da call (contrato A). Funções puras: recebem o client e leem o CACHE do discord.js.
// ──────────────────────────────────────────────────────────────────────────────

function membrosDoCanal(client, guildId, voiceChannelId) {
    const canal = client?.channels?.cache?.get?.(voiceChannelId);
    if (!canal || !canal.members || typeof canal.members.values !== 'function') return null;
    // Canal de outro servidor (id trocado) não vale: falha fechado.
    const donoDoCanal = canal.guild?.id ?? canal.guildId ?? null;
    if (guildId && donoDoCanal && String(donoDoCanal) !== String(guildId)) return null;
    return canal.members;
}

/**
 * Os estados de voz do servidor que estão neste canal (guild.voiceStates.cache). O `canal.members` do discord.js é montado a partir
 * deles, MAS descarta quem não tem GuildMember no cache (usuário invisível, servidor grande, bot reiniciado com gente já na call):
 * esse humano ficaria fora da contagem e a call pareceria mais vazia (mais PRIVADA) do que é. Daí contar os estados também.
 * @returns {Array|null} null se não há como ler os estados (aí vale só o canal.members, como antes)
 */
function estadosDoCanal(client, guildId, voiceChannelId) {
    const canal = client?.channels?.cache?.get?.(voiceChannelId);
    const guild = canal?.guild?.voiceStates ? canal.guild : client?.guilds?.cache?.get?.(guildId);
    const cache = guild?.voiceStates?.cache;
    if (!cache || typeof cache.values !== 'function') return null;
    const estados = [];
    for (const st of cache.values()) if (st && String(st.channelId ?? '') === String(voiceChannelId)) estados.push(st);
    return estados;
}

/**
 * Humanos no canal de voz AGORA. Mutados e ensurdecidos CONTAM (ouvem do mesmo jeito); bots confirmados (member.user.bot === true) não.
 * Membro sem a marca de bot, ou estado de voz sem membro resolvido (dado parcial), conta como humano: contar a mais só deixa a
 * audiência mais pública, nunca mais privada. Se a contagem por estados de voz e a de canal.members diferem, vale a MAIOR.
 * Decisão do desenho (risco aceito): bots NÃO contam, mas o bot não distingue os que escutam/gravam a call (gravador, STT); um bot
 * assim ouviria a fala privada. Distinguir exigiria uma lista de bots permitidos (YUI_VOZ_BOTS_OK), fora do escopo desta fase.
 * @returns {{ humanos: number } | null} null se o canal não está no cache (audiência desconhecida = pública)
 */
export function contarHumanosNaCall(client, guildId, voiceChannelId) {
    try {
        const membros = membrosDoCanal(client, guildId, voiceChannelId);
        if (!membros) return null;
        let porCanal = 0;
        for (const m of membros.values()) if (m?.user?.bot !== true) porCanal += 1;
        let porEstados = 0;
        for (const st of estadosDoCanal(client, guildId, voiceChannelId) ?? []) if (st?.member?.user?.bot !== true) porEstados += 1;
        return { humanos: Math.max(porCanal, porEstados) };
    } catch {
        return null;
    }
}

/** O dono (mesmo helper isOwnerId do projeto) está entre os membros ou estados de voz do canal? Falha = false. */
export function donoNaCall(client, guildId, voiceChannelId, ehDono = isOwnerId) {
    try {
        const membros = membrosDoCanal(client, guildId, voiceChannelId);
        if (!membros) return false;
        for (const [chave, m] of membros.entries()) {
            const id = m?.id ?? m?.user?.id ?? chave;
            if (m?.user?.bot !== true && ehDono(String(id)) === true) return true;
        }
        // O dono pode estar só nos estados de voz (sem GuildMember no cache): a contagem já o conta como humano.
        for (const st of estadosDoCanal(client, guildId, voiceChannelId) ?? []) {
            const id = st?.id ?? st?.member?.id ?? st?.userId;
            if (id != null && st?.member?.user?.bot !== true && ehDono(String(id)) === true) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * O bloco `call.audiencia` (contrato A). `falanteVerificado` = o userId veio do receiver.speaking NESTA captura E a Discord confirma
 * que é humano. Isso prova "a conta Discord que abriu o microfone", não "de quem é a voz".
 */
export function medirAudiencia({ client, guildId, voiceChannelId, userId, falanteDoReceiver, dirigida, turnoId, agora = Date.now, confirmarHumano, ehDono = isOwnerId }) {
    let falanteVerificado = false;
    try { falanteVerificado = falanteDoReceiver === true && confirmarHumano?.(client, guildId, voiceChannelId, userId) === true; } catch { falanteVerificado = false; }
    const contagem = contarHumanosNaCall(client, guildId, voiceChannelId);
    return {
        v: 1,
        falanteId: String(userId ?? ''),
        falanteVerificado,
        donoPresente: donoNaCall(client, guildId, voiceChannelId, ehDono),
        humanosNaCall: contagem ? contagem.humanos : null,
        dirigida: dirigida === true,
        medidoEm: Number(agora()),
        turnoId: String(turnoId ?? ''),
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Gatilho (item 5): só com a chave ligada.
// ──────────────────────────────────────────────────────────────────────────────

/** Gatilho FRACO: nomes de gente comuns ("falei pro Ricardo") que o STT também erra no lugar de "Yui". */
const GATILHOS_FRACOS = new Set(['ricardo', 'ricard', 'ricardin', 'ricardinho', 'icaro', 'icaros']);

/** minúsculas e sem acento, com o MESMO tamanho do original (os índices servem para cortar o texto original e manter os acentos). */
export function dobrarTexto(text) {
    let out = '';
    for (const ch of String(text ?? '')) {
        const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
        out += f.length === ch.length ? f : ch.toLowerCase();
    }
    return out;
}

const palavrasAntes = (folded, index) => folded.slice(0, index).trim().split(/\s+/).filter(Boolean).length;

/**
 * Acha a palavra de ativação na fala. Gatilho forte (yui e variações) vale em qualquer posição; ricardo/ícaro só se estiverem nas
 * 2 primeiras palavras (e "Yui" junto deles já é um gatilho forte). @returns {{ index, length, folded, fraco, antes } | null} (antes = palavras antes do gatilho)
 */
export function localizarGatilho(text, regex) {
    try {
        const folded = dobrarTexto(text);
        const re = new RegExp(regex.source, 'gi');
        const fracos = [];
        for (const m of folded.matchAll(re)) {
            if (!GATILHOS_FRACOS.has(m[0].trim())) return { index: m.index, length: m[0].length, folded, fraco: false, antes: palavrasAntes(folded, m.index) };
            fracos.push(m);
        }
        for (const m of fracos) {
            const antes = palavrasAntes(folded, m.index);
            if (antes < 2) return { index: m.index, length: m[0].length, folded, fraco: true, antes };
        }
        return null;
    } catch {
        return null;
    }
}

/** Há gatilho FORTE no texto? (anti-eco do TTS: "ricardo"/"ícaro" numa resposta legítima não a calam.) */
export function temGatilhoForte(text, regex) {
    try {
        const re = new RegExp(regex.source, 'gi');
        for (const m of dobrarTexto(text).matchAll(re)) if (!GATILHOS_FRACOS.has(m[0].trim())) return true;
        return false;
    } catch {
        return true; // na dúvida, trata como eco (comportamento antigo: calar é o lado seguro)
    }
}

const FRASES_FALE_COM = ['fale com a', 'falar com a', 'fale com o', 'falar com o'];

/**
 * Filtro de alucinação do STT no modo unificado. As frases curtas "fale/falar com a/o" só valem se a transcrição INTEIRA for essa
 * frase (até 6 palavras e sem a palavra de ativação abrindo a frase): "Yui, fale com a minha mãe" é um pedido de verdade.
 * As demais entradas da lista seguem como sempre (trecho em qualquer parte).
 */
export function alucinacaoSttUnificada(text, lista, regex) {
    const folded = dobrarTexto(text);
    for (const h of lista) {
        const hf = dobrarTexto(h);
        if (!folded.includes(hf)) continue;
        if (!FRASES_FALE_COM.includes(hf)) return true;
        const palavras = folded.trim().split(/\s+/).filter(Boolean).length;
        if (palavras <= 6 && !wakeWordInFirstWords(folded, regex, 3)) return true;
    }
    return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fila (item 4): prioridade da voz por inserção. Sem segundo consumidor; o item em andamento já saiu do array e nunca é tocado.
// ──────────────────────────────────────────────────────────────────────────────

const ehItemVoz = (it) => it?.options?.voice === true && it?.interaction?.isVoice === true;

/** Insere o item de voz antes dos itens que NÃO são de voz ainda não iniciados, mantendo a ordem entre os de voz. Devolve o índice. */
export function inserirItemVoz(fila, item) {
    let i = 0;
    while (i < fila.length && ehItemVoz(fila[i])) i += 1;
    fila.splice(i, 0, item);
    return i;
}

// ──────────────────────────────────────────────────────────────────────────────
// Ferramentas (item 6): bloqueio efetivo deny-by-default.
// ──────────────────────────────────────────────────────────────────────────────

let definicoesCache = null;
function definicoesDeFerramentas() {
    if (definicoesCache) return definicoesCache;
    const arquivo = fileURLToPath(new URL('../data/mcp_tools.json', import.meta.url));
    const lista = JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, ''));
    const mapa = new Map();
    for (const t of Array.isArray(lista) ? lista : []) {
        const nome = t?.function?.name;
        if (typeof nome === 'string') mapa.set(nome, t.function.parameters ?? { type: 'object', properties: {} });
    }
    definicoesCache = mapa;
    return mapa;
}

const objetoSimples = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
};

function tipoConfere(valor, esquema) {
    switch (esquema?.type) {
        case 'string':
            if (typeof valor !== 'string' || valor.length > 300) return false;
            return !Array.isArray(esquema.enum) || esquema.enum.includes(valor);
        case 'number': return typeof valor === 'number' && Number.isFinite(valor);
        case 'integer': return Number.isInteger(valor);
        case 'boolean': return typeof valor === 'boolean';
        default: return false; // tipo que a lista fechada não usa: não confere, não passa
    }
}

/**
 * Os argumentos têm que ser um objeto simples com SÓ as chaves da definição (src/data/mcp_tools.json), tipos conferidos e as
 * obrigatórias presentes. Chave sobrando, protótipo estranho ou tipo errado = não passa.
 */
export function argumentosValidos(nome, args, definicoes = definicoesDeFerramentas()) {
    try {
        const esquema = definicoes.get(nome);
        if (!esquema || !objetoSimples(args)) return false;
        const props = esquema.properties ?? {};
        for (const chave of Object.keys(args)) {
            if (!Object.prototype.hasOwnProperty.call(props, chave)) return false;
            if (!tipoConfere(args[chave], props[chave])) return false;
        }
        for (const obrigatoria of esquema.required ?? []) {
            if (!Object.prototype.hasOwnProperty.call(args, obrigatoria)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/** Só caracteres de nome de ferramenta vão para a auditoria: o nome pode vir de uma transcrição hostil. */
const nomeSeguro = (nome) => (typeof nome === 'string' && /^[a-z0-9_]{1,40}$/.test(nome) ? nome : 'desconhecida');

// ──────────────────────────────────────────────────────────────────────────────
// Controle de UM turno de voz (audiência, entrega, prazo, latência)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {object} p.client                       discord.js client (cache de canais e membros)
 * @param {string} p.guildId
 * @param {string} p.voiceChannelId
 * @param {string} p.userId                       falante (veio do receiver.speaking)
 * @param {boolean} p.falanteDoReceiver           o userId veio do receiver.speaking nesta captura
 * @param {boolean} p.dirigida                    a palavra de ativação abre a frase
 * @param {Function} p.confirmarHumano            (client, guildId, voiceChannelId, userId) => boolean (isConfirmedHuman)
 * @param {Function} [p.enviarDM]                 async (payload) => mensagem | null
 * @param {Function} [p.enviarAviso]              async (frase) => void: frase FIXA no canal de texto
 */
export function criarControleAudiencia({
    client, guildId, voiceChannelId, userId, falanteDoReceiver = false, dirigida = false, confirmarHumano,
    env = process.env, relogio = Date.now, turnoId = novoTurnoId(), ehDono = isOwnerId,
    enviarDM = null, enviarAviso = null, registrar = registrarAudiencia,
    setTimer = setTimeout, clearTimer = clearTimeout, log = logger, medidor = null,
} = {}) {
    const chaves = lerChavesVoz(env);
    const medirCru = () => medirAudiencia({ client, guildId, voiceChannelId, userId, falanteDoReceiver, dirigida, turnoId, agora: relogio, confirmarHumano, ehDono });
    const fatosAgora = (aud) => fatosDaVoz(aud, { autorId: String(userId ?? ''), autorEhDono: ehDono(String(userId ?? '')) === true, chaves, agora: relogio() });

    const audiencia = medirCru();
    // Decisão do bot (código puro, a mesma função do cérebro): serve para REVALIDAR antes de entregar e para recusar uma resposta
    // "privada" quando o próprio bot enxerga público. O nível que vale para o texto vem do cérebro (contrato B).
    const inicial = decidirAudiencia(fatosAgora(audiencia));
    const medida = medidor ?? criarMedidor({ turnoId, relogio });
    const t0 = Number(relogio());

    const estado = {
        nivelCerebro: null, invalidada: false, motivo: null,
        avisoEnviado: false, entregando: false, finalizado: false, dmFalhou: false, dmAvisou: false,
        opcoes: null, timer: null,
    };
    const seguro = (fn) => { try { return fn(); } catch { return undefined; } };
    try { registrar(inicial, { turnId: turnoId, env }); } catch { /* auditar nunca atrapalha */ }

    const nivel = () => (!estado.invalidada && estado.nivelCerebro === NIVEL.PRIVADO ? NIVEL.PRIVADO : NIVEL.PUBLICO);

    const invalidar = (motivo) => {
        if (estado.invalidada) return;
        estado.invalidada = true;
        estado.motivo = String(motivo ?? 'audiencia_mudou').slice(0, 40);
        // UM registro por turno invalidado, sem texto: só os códigos da decisão e o recurso bloqueado ("resposta").
        seguro(() => registrar(inicial, { turnId: turnoId, bloqueio: 'invalidada', env }));
    };

    /** Reavalia a audiência AGORA (fatos recontados). Só o turno privado pode ser invalidado; o público nunca é promovido. */
    const reavaliar = () => {
        if (estado.invalidada || estado.nivelCerebro !== NIVEL.PRIVADO) return null;
        try {
            const r = revalidar(inicial, fatosAgora(medirCru()));
            if (!r.mantem) invalidar(r.motivo);
            return r;
        } catch {
            invalidar('erro_revalidacao'); // qualquer exceção = invalida (falha fechado)
            return null;
        }
    };

    /**
     * A medição que viaja ao cérebro (callAgora). Se a decisão INICIAL do turno aqui no bot não foi privada, junta
     * `promocaoProibida: true`: um convidado que SAI no meio da geração nunca promove o turno a privado (o desenho proíbe), e o
     * cérebro já decide público no passo 1 em vez de montar contexto privado à toa. A revalidação do bot usa a medição crua.
     */
    const medirAgora = () => {
        const a = medirCru();
        if (inicial.nivel !== NIVEL.PRIVADO) a.promocaoProibida = true;
        return a;
    };

    const controle = {
        turnoId, audiencia, inicial, medirAgora, medidor: medida,
        get invalidada() { return estado.invalidada; },
        get motivo() { return estado.motivo; },
        get avisoEnviado() { return estado.avisoEnviado; },
        get dmFalhou() { return estado.dmFalhou; },
        nivel,

        /** Liga as options do item da fila (o prazo marca `options.avisoEnviado`, como o contrato pede). */
        ligarOpcoes(opcoes) { estado.opcoes = opcoes; },

        /** Contrato B: o que o cérebro devolveu no passo. Qualquer coisa fora de forma = público. Invalidação é pegajosa. */
        registrarResultado(aud) {
            const a = aud && typeof aud === 'object' ? aud : {};
            const n = a.nivel === NIVEL.PRIVADO ? NIVEL.PRIVADO : NIVEL.PUBLICO;
            if (a.turnoId != null && String(a.turnoId) !== turnoId) invalidar('turno_diferente');
            if (n === NIVEL.PRIVADO && inicial.nivel !== NIVEL.PRIVADO) invalidar('inconsistente'); // o cérebro diz privado e o bot não
            if (a.invalidada === true) invalidar(typeof a.motivo === 'string' && a.motivo ? a.motivo : 'audiencia_mudou');
            estado.nivelCerebro = n;
            return nivel();
        },

        /** Última porta antes do texto sair (ou de a fala começar). */
        antesDeEntregar() {
            // Em TODA saída (entregar, frase ou descartar) o temporizador morre: senão um "Demorei demais" sairia junto de
            // "Mudou quem está na call" (ou depois do descarte) se o envio da frase fixa demorasse perto do prazo.
            if (estado.timer) { seguro(() => clearTimer(estado.timer)); estado.timer = null; }
            if (estado.avisoEnviado) return { acao: 'descartar' };
            reavaliar();
            // 'medicao_velha' (contrato B): o cérebro demorou mais que a idade máxima da medição. Ninguém entrou nem saiu da call, então
            // a frase certa é a do prazo, não a de "mudou quem está na call" (que seria enganosa).
            if (estado.invalidada) return { acao: 'frase', frase: estado.motivo === 'medicao_velha' ? FRASE_PRAZO : FRASE_MUDOU_CALL };
            estado.entregando = true;
            return { acao: 'entregar', privado: nivel() === NIVEL.PRIVADO };
        },

        /**
         * Portão da FALA, consultado pelo TTS ANTES DE CADA FRASE (canSpeak). Só o turno PRIVADO é recontado AGORA: um convidado que
         * entra depois do último portão (síntese, fila do TTS, frases longas) faz a fala parar. Falha, exceção ou invalidação = não
         * fala (falha fechado). Turno público: sempre true (nada muda).
         */
        audienciaOk() {
            try {
                if (estado.nivelCerebro !== NIVEL.PRIVADO && !estado.invalidada) return true;
                reavaliar();
                return estado.invalidada !== true;
            } catch {
                return false;
            }
        },

        /** Entrega do TEXTO por mensagem privada ao dono. NUNCA cai para o canal do servidor. Devolve a mensagem ou null. */
        async enviarPrivado(payload) {
            const p = typeof payload === 'string' ? { content: payload } : { ...(payload ?? {}) };
            for (const k of ['files', 'components', 'embeds']) if (Array.isArray(p[k]) && p[k].length === 0) delete p[k];
            if (p.content === '' || p.content == null) delete p.content;
            p.allowedMentions = { parse: [] };
            if (!p.content && !p.files && !p.embeds && !p.components) return null;
            try {
                if (typeof enviarDM !== 'function') throw new Error('sem DM');
                const msg = await enviarDM(p);
                return msg || null;
            } catch {
                estado.dmFalhou = true;
                if (!estado.dmAvisou) { // só um aviso, SEM conteúdo e sem ids
                    estado.dmAvisou = true;
                    seguro(() => log.warn('[VOZ] Não consegui entregar a resposta por mensagem privada (nada foi enviado ao canal).'));
                }
                return null;
            }
        },

        /** Os pontos de envio da mensagem de voz (buildVoiceMessage): se o turno é privado, o texto vai por DM. */
        entrega: {
            privado: () => nivel() === NIVEL.PRIVADO || estado.invalidada === true,
            enviarPrivado: (payload) => {
                if (estado.invalidada || estado.avisoEnviado) return Promise.resolve(null); // nada derivado de contexto privado sai
                return controle.enviarPrivado(payload);
            },
        },

        /**
         * Envolve o unifiedReply do llmHandler: no turno privado QUALQUER texto, embed ou arquivo vai por DM e o canal de texto só
         * recebe frases fixas (pelo `base`, chamado pelo próprio llmHandler). Turno invalidado ou vencido: nada sai.
         */
        envolverReply(base) {
            let ultimo = null; // última entrega por DM
            let viaDM = false;
            const reply = async (content, ...resto) => {
                if (estado.avisoEnviado || estado.invalidada) {
                    ultimo = { ok: false, mode: 'discarded', parts: 1, sentParts: 0, durationMs: 0 };
                    viaDM = true;
                    return null;
                }
                if (nivel() === NIVEL.PRIVADO) {
                    const inicio = Number(relogio());
                    const [files, components, embeds] = resto;
                    const msg = await controle.enviarPrivado({ content, files, components, embeds });
                    const durationMs = Math.max(0, Number(relogio()) - inicio);
                    ultimo = msg
                        ? { ok: true, mode: 'dm', parts: 1, sentParts: 1, durationMs }
                        : { ok: false, mode: 'failed', parts: 1, sentParts: 0, durationMs };
                    viaDM = true;
                    return msg;
                }
                viaDM = false;
                return base(content, ...resto);
            };
            Object.defineProperty(reply, 'lastDelivery', {
                get: () => (viaDM ? ultimo : base.lastDelivery),
                set: (v) => { base.lastDelivery = v; viaDM = false; },
            });
            Object.defineProperty(reply, 'progress', { get: () => base.progress });
            return reply;
        },

        /** Ferramenta: ordem fixa (voz com audiência, revalida agora, lista fechada, argumentos, guard e toggles). Qualquer exceção = bloqueia. */
        autorizarFerramenta(nome, args, { guard = null, desligada = null } = {}) {
            let permitido = false;
            let decisaoDoBloqueio = inicial;
            try {
                const r = revalidar(inicial, fatosAgora(medirCru()));
                decisaoDoBloqueio = r.decisao ?? inicial;
                if (!r.mantem) {
                    invalidar(r.motivo);
                } else {
                    const pessoal = r.decisao.recursos?.memoriaPessoal === true && r.decisao.recursos?.contextoPessoal === true;
                    const permitidas = pessoal ? [...FERRAMENTAS_LEITURA_VOZ, ...FERRAMENTAS_PESSOAIS_VOZ] : [...FERRAMENTAS_LEITURA_VOZ];
                    permitido = ferramentaPermitida(r.decisao, { nome, somenteLeitura: permitidas.includes(nome), permitidas })
                        && argumentosValidos(nome, args)
                        && (typeof guard === 'function' ? !guard() : false)
                        && (typeof desligada === 'function' ? desligada() === false : false);
                }
            } catch {
                permitido = false;
            }
            if (!permitido) seguro(() => registrar(decisaoDoBloqueio, { turnId: turnoId, bloqueio: nomeSeguro(nome), env }));
            return permitido;
        },

        /** Instante-limite (ms desde 1970) da resposta: o cérebro e os provedores (options.deadlineAt) param de trabalhar numa resposta condenada. */
        prazoAte(desde = t0) { return Number(desde) + chaves.prazoMs; },

        /** Prazo da resposta (YUI_VOZ_PRAZO_S) a partir de `desde` (voiceRequestedAt). Estourou: UMA frase fixa e a resposta tardia é descartada. */
        iniciarPrazo(desde = t0) {
            seguro(() => medida.inicio('fila'));
            const espera = Math.max(0, Number(desde) + chaves.prazoMs - Number(relogio()));
            const disparar = () => {
                estado.timer = null;
                if (estado.finalizado || estado.entregando || estado.avisoEnviado) return;
                estado.avisoEnviado = true;
                if (estado.opcoes) estado.opcoes.avisoEnviado = true;
                Promise.resolve(seguro(() => enviarAviso?.(FRASE_PRAZO))).catch(() => {});
            };
            estado.timer = setTimer(disparar, espera);
            seguro(() => estado.timer?.unref?.());
            return estado.timer;
        },

        marcarInicio: (etapa) => seguro(() => medida.inicio(etapa)),
        marcarFim: (etapa) => seguro(() => medida.fim(etapa)),
        marcarMs: (etapa, ms) => seguro(() => medida.marcar(etapa, ms)),

        /** Fim do turno (qualquer caminho): limpa o temporizador e emite UMA linha [VOZ-LAT]. Pode ser chamado de novo sem efeito. */
        finalizar() {
            if (estado.finalizado) return;
            estado.finalizado = true;
            if (estado.timer) { seguro(() => clearTimer(estado.timer)); estado.timer = null; }
            seguro(() => medida.marcar('total', Math.max(0, Number(relogio()) - t0)));
            seguro(() => log.info(medida.linha()));
        },

        /** Há temporizador pendurado? (teste) */
        get temTemporizador() { return estado.timer !== null; },
    };
    return controle;
}

/**
 * O executor de ferramentas do llmHandler consulta isto. Em voz unificada a decisão é SÓ da política: YUI_VOICE_TOOLS=true não abre
 * nada por trás dela. Sem controle de audiência no item = bloqueia.
 */
export function ferramentaVozAutorizada(nome, args, options, ctx = {}) {
    try {
        const ctl = options?.audienciaCtl;
        if (options?.voice !== true || !ctl || typeof ctl.autorizarFerramenta !== 'function') return false;
        return ctl.autorizarFerramenta(nome, args, { guard: ctx.guard, desligada: ctx.desligada }) === true;
    } catch {
        return false;
    }
}
