import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { checkBan } from '../handlers/banHandler.js';
import { resolveMentions } from '../utils/mentions.js';
import { addToQueue, getChannelSettings, getServerSettings, queueRefusalFor, refuseQueueRequest } from '../handlers/llmHandler.js';
import config from '../config.js';
import { clipContextText, longContextIds, LONG_CONTEXT_LIMIT, SHORT_CONTEXT_LIMIT } from '../discord/longReply.js';
import { clampText } from '../discord/embedLimits.js';
import { startsWithCommandPrefix } from '../discord/prefixRouter.js';
import { fenceUntrustedWeb } from '../handlers/llmSafety.js';
import { safeFetchText } from '../search/safeFetch.js';
import { clipHeadTail } from '../utils/promptBudget.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------------------------
// Bloco CONTEXTO: teto de caracteres
// ---------------------------------------------------------------------------------------------

/** Teto do bloco CONTEXTO do prompt (soma das linhas "autor: texto"). Sem ele: 2 mensagens longas + 8 de 500 passavam de 12 mil. */
export const CONTEXT_MAX_CHARS = 9000;

/**
 * Aplica o teto ao histórico, descartando as mensagens MAIS ANTIGAS primeiro.
 * `items`: linhas, ou { line, keep } em ordem cronológica; `keep` protege a mensagem respondida (só sai se for a única saída).
 * Devolve só as linhas que ficam, na mesma ordem.
 */
export function capContextLines(items, maxChars = CONTEXT_MAX_CHARS) {
    const list = (Array.isArray(items) ? items : []).map((it) => (typeof it === 'string' ? { line: it, keep: false } : { line: String(it?.line ?? ''), keep: it?.keep === true }));
    const alive = list.map(() => true);
    let total = list.reduce((n, it) => n + it.line.length + 1, 0);
    for (let i = 0; i < list.length && total > maxChars; i++) {
        if (list[i].keep) continue;
        alive[i] = false;
        total -= list[i].line.length + 1;
    }
    for (let i = 0; i < list.length && total > maxChars; i++) {
        if (!alive[i]) continue;
        alive[i] = false;
        total -= list[i].line.length + 1;
    }
    return list.filter((_, i) => alive[i]).map((it) => it.line);
}

// ---------------------------------------------------------------------------------------------
// Anexos de texto (.txt, .md, .log): lidos e entregues à IA como DADO NÃO CONFIÁVEL
// ---------------------------------------------------------------------------------------------

const ATTACH_TEXT_EXTS = new Set(['txt', 'md', 'log']);
const ATTACH_TEXT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const ATTACH_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/x-log', 'application/octet-stream']);
const ATTACH_LIST_MAX = 5; // anexos citados na nota do prompt
const ATTACH_READ_MAX_FILES = 3; // arquivos lidos por mensagem
const ATTACH_ONLY_SEARCH_PROMPT = '(enviou um arquivo de texto)'; // fala "limpa" quando a mensagem só tem anexo (nunca o nome nem o conteúdo)
const NO_TEXT_LINE = '(mensagem sem texto, só com o anexo abaixo)';

/** Só para os testes: troca a função que baixa o anexo (padrão: safeFetchText, com bloqueio de endereço interno e limite de bytes). */
export const attachmentDeps = { fetchText: safeFetchText };

function intFromEnv(env, name, fallback, min, max) {
    const n = Number.parseInt(String(env?.[name] ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(n, min), max);
}

/** YUI_READ_TEXT_ATTACHMENTS (padrão ligado), YUI_ATTACH_TEXT_MAX_KB (100) e YUI_ATTACH_TEXT_MAX_CHARS (12000). */
export function attachmentSettings(env = process.env) {
    const flag = String(env?.YUI_READ_TEXT_ATTACHMENTS ?? '').trim().toLowerCase();
    return {
        enabled: !['false', '0', 'off', 'no', 'nao', 'não'].includes(flag),
        maxBytes: intFromEnv(env, 'YUI_ATTACH_TEXT_MAX_KB', 100, 1, 1024) * 1024,
        maxChars: intFromEnv(env, 'YUI_ATTACH_TEXT_MAX_CHARS', 12000, 500, 50000),
    };
}

/** Nome do anexo seguro para o prompt: o nome é escolhido por quem envia, então sem colchetes, aspas, quebras de linha nem invisíveis. */
export function safeAttachmentName(name) {
    const s = String(name ?? '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N} ._()+,'&#-]/gu, '_')
        .replace(/_{2,}/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return clampText(s || 'arquivo', 60);
}

/**
 * O link do anexo é do CDN do Discord? Só https, sem credenciais nem porta estranha, e o host EXATO
 * cdn.discordapp.com ou media.discordapp.net (verificado ANTES de baixar qualquer coisa).
 */
export function isDiscordCdnUrl(url) {
    try {
        const u = new URL(String(url ?? ''));
        return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && ATTACH_TEXT_HOSTS.has(u.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function attachmentList(attachments) {
    if (!attachments) return [];
    try {
        if (Array.isArray(attachments)) return attachments.slice(0, 25);
        if (typeof attachments.values === 'function') return [...attachments.values()].slice(0, 25);
    } catch { /* coleção inválida: sem anexos */ }
    return [];
}

const extensionOf = (name) => /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim())?.[1]?.toLowerCase() ?? '';
const mimeOf = (contentType) => String(contentType ?? '').split(';')[0].trim().toLowerCase();

/**
 * Descreve os anexos da mensagem (função PURA): quantos há, os 5 primeiros com nome seguro, tamanho em KB, extensão e se
 * são de um tipo que a Yui lê (.txt, .md, .log). `label` é o texto da nota "[o usuário anexou: ...]".
 */
export function describeAttachments(attachments) {
    const raw = attachmentList(attachments);
    const items = raw.slice(0, ATTACH_LIST_MAX).map((a) => {
        const size = Number.isFinite(Number(a?.size)) ? Math.max(0, Number(a.size)) : 0;
        const ext = extensionOf(a?.name);
        const mime = mimeOf(a?.contentType);
        return {
            name: safeAttachmentName(a?.name),
            ext,
            size,
            kb: Math.max(1, Math.round(size / 1024)),
            url: typeof a?.url === 'string' ? a.url : '',
            textLike: ATTACH_TEXT_EXTS.has(ext) && (!mime || ATTACH_TEXT_MIMES.has(mime)),
        };
    });
    const hidden = raw.length - items.length;
    const label = items.map((i) => `${i.name} (${i.kb} KB)`).join(', ') + (hidden > 0 ? `, e mais ${hidden}` : '');
    return { total: raw.length, hidden, items, label };
}

/** Texto do arquivo pronto para o prompt, ou null se não for texto (binário disfarçado de .txt). */
function cleanAttachmentText(raw) {
    let s = String(raw ?? '');
    if (s.includes('\u0000')) return null;
    s = s.replace(/^﻿/, '');
    let bad = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0xFFFD || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
    }
    if (s.length > 0 && bad / s.length > 0.1) return null;
    s = s.replace(/\r\n?/g, '\n').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    // O arquivo não pode "abrir uma seção" do prompt montado aqui.
    s = s.replace(/^[ \t]*---[ \t]*(?:CONTEXTO|MENSAGEM ATUAL)[ \t]*---[ \t]*$/gim, '(cabeçalho removido)');
    return s.replace(/\n{4,}/g, '\n\n\n').trim();
}

async function fetchAttachmentText(item, settings, fetchText, fetchOptions) {
    try {
        const r = await fetchText(new URL(item.url).href, {
            maxBytes: settings.maxBytes,
            maxRedirects: 0, // o host foi conferido ANTES: um redirecionamento não pode levar para outro lugar
            timeoutMs: 6000,
            totalDeadlineMs: 10000,
            allowedContentTypes: [...ATTACH_TEXT_MIMES],
            headers: { Accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.1' },
            ...fetchOptions,
        });
        if (!r || r.ok !== true) {
            logger.warn(`[Anexos] Leitura recusada (${String(r?.code || 'sem-codigo').slice(0, 24)}).`);
            return { reason: r?.code === 'CONTENT_TYPE' ? 'type' : 'fetch' };
        }
        if (r.truncated) return { reason: 'size' };
        const text = cleanAttachmentText(r.text);
        if (text === null) return { reason: 'binary' };
        if (!text) return { reason: 'empty' };
        return { text };
    } catch (err) {
        logger.warn(`[Anexos] Falha ao ler o anexo (${String(err?.name || 'Error').slice(0, 40)}).`);
        return { reason: 'fetch' };
    }
}

/**
 * Lê os anexos .txt, .md e .log da mensagem. NUNCA lança.
 *
 * Regras: só do CDN do Discord (host conferido antes de baixar), sem redirecionamento, até 100 KB por arquivo
 * (YUI_ATTACH_TEXT_MAX_KB), no máximo 3 arquivos e 12000 caracteres no total (YUI_ATTACH_TEXT_MAX_CHARS);
 * YUI_READ_TEXT_ATTACHMENTS=false desliga. O texto sai CERCADO como dado não confiável (a mesma marca do texto da web).
 * Resultado: { total, hidden, label, maxKb, readCount, chars, items: [{ name, kb, status, reason, truncated, textLike }], blocks }
 * (`textLike`: o anexo é de um tipo que a Yui lê, .txt, .md ou .log).
 */
export async function readTextAttachments(attachments, { env = process.env, fetchText = attachmentDeps.fetchText, fetchOptions = {} } = {}) {
    const settings = attachmentSettings(env);
    const desc = describeAttachments(attachments);
    const result = { total: desc.total, hidden: desc.hidden, label: desc.label, maxKb: Math.round(settings.maxBytes / 1024), readCount: 0, chars: 0, items: [], blocks: [] };
    if (desc.total === 0) return result;
    const jobs = [];
    try {
        for (const item of desc.items) {
            const out = { name: item.name, kb: item.kb, status: 'skipped', reason: '', truncated: false, textLike: item.textLike === true };
            result.items.push(out);
            if (!item.textLike) out.reason = 'type';
            else if (!settings.enabled) out.reason = 'disabled';
            else if (item.size <= 0) out.reason = 'empty';
            else if (item.size > settings.maxBytes) out.reason = 'size';
            else if (!isDiscordCdnUrl(item.url)) out.reason = 'host';
            else if (jobs.length >= ATTACH_READ_MAX_FILES) out.reason = 'limit';
            else jobs.push({ out, promise: fetchAttachmentText(item, settings, fetchText, fetchOptions) });
        }
        const fetched = await Promise.all(jobs.map((j) => j.promise));
        let budget = settings.maxChars;
        jobs.forEach((job, i) => {
            const got = fetched[i];
            const out = job.out;
            if (got.reason) {
                out.status = 'failed';
                out.reason = got.reason;
                return;
            }
            if (budget <= 0) {
                out.reason = 'limit';
                return;
            }
            const originalChars = got.text.length;
            let text = got.text;
            if (text.length > budget) {
                // Início E fim (70/30): num .log o que importa costuma estar no fim; num texto colado, a conclusão.
                text = clipHeadTail(text, budget);
                out.truncated = true;
            }
            const fenced = fenceUntrustedWeb(text);
            if (!fenced) {
                out.status = 'failed';
                out.reason = 'empty';
                return;
            }
            budget -= text.length;
            out.status = 'read';
            result.readCount += 1;
            result.chars += text.length;
            const header = `Conteúdo de ${out.name}${out.truncated ? ` (cortado, ficaram o início e o fim: ${text.length} de ${originalChars} caracteres)` : ''}:`;
            result.blocks.push(`${header}\n${fenced}`);
        });
    } catch (err) {
        logger.warn(`[Anexos] Erro inesperado ao ler os anexos (${String(err?.name || 'Error').slice(0, 40)}).`);
        result.blocks.length = 0;
        result.readCount = 0;
        result.chars = 0;
        for (const out of result.items) {
            out.status = 'failed';
            out.reason = out.reason || 'fetch';
        }
    }
    if (result.items.length > 0) logger.info(`[Anexos] ${result.readCount} de ${result.total} anexo(s) lido(s), ${result.chars} caracteres.`);
    return result;
}

const FIXED_REPLY_COOLDOWN_MS = 30_000; // no máximo uma resposta fixa a cada 30 s por pessoa
const fixedReplyAt = new Map(); // pessoa -> instante da última resposta fixa

/**
 * Pode mandar uma resposta FIXA (sem IA: "não entendi o que você precisa", anexo que não deu para ler) a esta pessoa? No máximo uma a cada
 * 30 s. Antes essas respostas passavam pela fila da IA, que era o freio; agora saem na hora, e 100 menções vazias seguidas gerariam 100
 * respostas do bot (e o limite de taxa do Discord). As demais só vão para o log. (B4)
 */
export function allowFixedReply(userId, now = Date.now()) {
    const key = String(userId ?? '');
    const last = fixedReplyAt.get(key);
    if (last !== undefined && now - last < FIXED_REPLY_COOLDOWN_MS) return false;
    fixedReplyAt.set(key, now);
    if (fixedReplyAt.size > 500) {
        for (const [id, at] of fixedReplyAt) if (now - at >= FIXED_REPLY_COOLDOWN_MS) fixedReplyAt.delete(id);
    }
    return true;
}

/** Responde sem nunca deixar uma rejeição solta (a resposta de aviso não pode derrubar nem desviar o fluxo). */
function replyQuietly(message, text) {
    try {
        Promise.resolve(message.reply(text)).catch(() => {});
    } catch { /* sem resposta */ }
}

function reasonLabel(reason, maxKb) {
    switch (reason) {
        case 'type': return 'tipo de arquivo que você não lê';
        case 'disabled': return 'a leitura de anexos está desligada';
        case 'empty': return 'arquivo vazio';
        case 'size': return `passa de ${maxKb} KB`;
        case 'host': return 'link do anexo não aceito';
        case 'binary': return 'não parece texto';
        case 'limit': return 'limite de leitura por mensagem';
        default: return 'falha ao baixar';
    }
}

/** O anexo é de um tipo que a Yui lê (.txt, .md, .log)? Resultado montado à mão, sem `textLike`: "type" sem tentativa de leitura é tipo que ela não lê. */
function isReadableKind(item) {
    if (typeof item?.textLike === 'boolean') return item.textLike;
    return !(item?.status === 'skipped' && item?.reason === 'type');
}

/**
 * Trecho do prompt com os anexos: a nota "[o usuário anexou: ...]", o aviso do que NÃO foi lido e o conteúdo cercado
 * como dado não confiável. Vai SÓ no finalPrompt (a busca na web e o auto-ban olham apenas a fala limpa).
 *
 * `hasText`: a mensagem tem texto próprio além do anexo. Então uma foto, um vídeo ou um PDF junto da fala é só contexto: entra apenas
 * na nota neutra "[o usuário anexou: ...]", SEM a ordem de avisar (senão a Yui avisaria que não lê imagens a cada foto). A frase
 * "NÃO leu" fica para o que a pessoa espera que seja lido: .txt, .md ou .log cuja leitura falhou ou está desligada. Sem texto
 * próprio (ou sem a opção) todo anexo não lido é avisado, como sempre foi. (Reg 4)
 */
export function buildAttachmentPrompt(result, { hasText = false } = {}) {
    if (!result || !(result.total > 0)) return '';
    const lines = [`[o usuário anexou: ${result.label}]`];
    const unread = result.items
        .filter((i) => i.status !== 'read' && (!hasText || isReadableKind(i)))
        .map((i) => `${i.name} (${reasonLabel(i.reason, result.maxKb)})`);
    if (!hasText && result.hidden > 0) unread.push(`mais ${result.hidden} anexo(s) (não listados)`);
    if (unread.length > 0) lines.push(`[Você NÃO leu: ${unread.join(', ')}. Avise isso em uma frase e não invente o conteúdo.]`);
    lines.push(...result.blocks);
    return lines.join('\n');
}

/** Resposta fixa (sem IA, sem nome de arquivo) quando a mensagem só tem anexo e nada pôde ser lido. */
export function attachmentOnlyReply(result) {
    const reasons = new Set((result?.items ?? []).map((i) => i.reason));
    const maxKb = result?.maxKb ?? 100;
    if (reasons.has('disabled')) return 'Recebi o anexo, mas ainda não leio arquivos. Cole o texto aqui na conversa, em partes se for longo.';
    if (reasons.has('fetch')) return 'Não consegui baixar o anexo agora. Tente de novo em instantes ou cole o texto aqui na conversa.';
    if (reasons.has('size')) return `Esse anexo passa de ${maxKb} KB. Mande um arquivo menor ou cole o trecho aqui na conversa.`;
    if (reasons.has('binary')) return 'Esse arquivo não parece ser texto puro. Só leio .txt, .md e .log com texto.';
    if (reasons.has('empty')) return 'O anexo está vazio, não tem o que ler.';
    return `Recebi o anexo, mas só leio arquivos .txt, .md e .log (até ${maxKb} KB). Cole o texto aqui na conversa ou mande em um desses formatos.`;
}

export default {
    name: 'messageCreate',
    once: false,
    async execute(message, client) {
        if (message.author.bot) return;
        // Comando por prefixo ("+yui diario", "+yui perguntar ..."): quem trata é o prefixRouter (client.js). Sem este retorno a mesma
        // mensagem virava também uma conversa (o nome "Yui" casa com "+yui"): custo dobrado e até ferramenta acionada pela menção.
        if (startsWithCommandPrefix(message.content, config.discord?.prefix ?? config.prefix)) return;
        const banInfo = checkBan(message.author.id, message.guildId, message.channelId);
        if (banInfo) {
            const isMentionForBan = message.mentions.has(client.user, { ignoreEveryone: true });
            if (!isMentionForBan) return;
            const banEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                .setDescription(`Sua tentativa de interação foi abortada. O acesso à **IA Yui** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **ALVO:** ${clampText(banInfo.typeName || banInfo.type, 60)}\n- **MOTIVO:** ${clampText(banInfo.reason || 'Violação severa dos Termos de Uso da IA Yui.', 300)}\n- **STATUS:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços.\n\nSe acredita que isso é um erro, solicite um desbanimento pelo botão abaixo.\n\n---\n💡 **Quer usar a Yui sem restrições?** Hospede sua própria versão!\n🚀 **Repositório:** [MauroBragaFilho/Yui](https://github.com/MauroBragaFilho/Yui)`)
                .setFooter({ text: 'Yui Security & Moderation • by oBraga' })
                .setTimestamp();
            const appealButton = new ButtonBuilder()
                .setCustomId(`appeal_ban_user_${message.author.id}`)
                .setLabel('⚖️ Solicitar Apelação')
                .setStyle(ButtonStyle.Secondary);
            const githubButton = new ButtonBuilder()
                .setLabel('Página do Projeto')
                .setURL('https://github.com/MauroBragaFilho/Yui')
                .setStyle(ButtonStyle.Link)
                .setEmoji('🚀');
            const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
            return message.reply({ embeds: [banEmbed], components: [banRow] }).catch(() => {});
        }
        if (message.guildId) {
            const { isServerAccepted, sendTermsOfService } = await import('../handlers/tosHandler.js');
            if (!isServerAccepted(message.guildId)) {
                const serverSettings = getServerSettings(message.guildId);
                const respondToEveryone = serverSettings.respondToEveryone || false;
                const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
                const botName = config.botName || 'Yui';
                const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
                const hasYuiName = nameRegex.test(message.content);
                let isReplyToBot = false;
                if (message.reference && message.reference.messageId) {
                    try {
                        const refMsg = message.channel.messages.cache.get(message.reference.messageId);
                        if (refMsg && refMsg.author && refMsg.author.id === client.user.id) {
                            isReplyToBot = true;
                        }
                    } catch (e) {}
                }
                const settings = getChannelSettings(message.channelId);
                const isChatterActive = settings?.chatter?.active || false;
                if (isMention || hasYuiName || isReplyToBot || isChatterActive) {
                    await sendTermsOfService(message);
                }
                return;
            }
        }
        const serverSettings = getServerSettings(message.guildId);
        const respondToEveryone = serverSettings.respondToEveryone || false;
        const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
        const botName = config.botName || 'Yui';
        const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
        const hasYuiName = nameRegex.test(message.content);
        if (isMention || hasYuiName) {
            if (message.guildId && message.channelId) {
                const { setServerLastChannel } = await import('../handlers/llmHandler.js');
                setServerLastChannel(message.guildId, message.channelId);
                const { checkAndInitializeUpdateChannel } = await import('../handlers/tosHandler.js');
                await checkAndInitializeUpdateChannel(message.guild, message.channel);
            }
            try {
                // Fila cheia ou pessoa com pedidos demais: o addToQueue recusaria no fim do mesmo jeito. Recusa já, sem baixar anexo (até 3
                // downloads de 100 KB) nem buscar o histórico do canal. O aviso é o de sempre (um a cada 30 s por pessoa). (B4)
                const earlyRefusal = queueRefusalFor(message.author.id, {});
                if (earlyRefusal) {
                    await refuseQueueRequest(message, 'mention', message.author.id, earlyRefusal, {});
                    return;
                }
                let currentUserPrompt = message.content;
                if (isMention) {
                    currentUserPrompt = currentUserPrompt.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
                }
                currentUserPrompt = resolveMentions(currentUserPrompt, client);
                // Anexos .txt/.md/.log: a leitura (rede, com prazo) corre junto com a busca do histórico; nunca lança.
                const attachmentsPromise = readTextAttachments(message.attachments);
                const history = [];
                let repliedMessage = null;
                if (message.reference && message.reference.messageId) {
                    try {
                        repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                    } catch (err) {
                        logger.warn(`[MessageCreate] Não consegui buscar a mensagem respondida: ${String(err?.message ?? err).slice(0, 100)}`);
                    }
                }
                const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
                const messageMap = new Map();
                if (repliedMessage) messageMap.set(repliedMessage.id, repliedMessage);
                recentMessages.forEach(msg => {
                    if (msg.author.bot && msg.author.id !== client.user.id) return;
                    if (!messageMap.has(msg.id)) messageMap.set(msg.id, msg);
                });
                const sortedMessages = [...messageMap.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                // A mensagem respondida e a última do mesmo autor (ex.: uma lista colada) vão quase inteiras; as demais seguem em 500.
                const longIds = longContextIds(sortedMessages, { repliedId: repliedMessage?.id ?? null, authorId: message.author.id });
                for (const msg of sortedMessages) {
                    const isBot = msg.author.id === client.user.id;
                    const authorName = isBot ? 'Yui' : msg.author.username;
                    let content = resolveMentions(msg.content, client);
                    if (isBot && (content.includes('erro ao processar seu pedido') || content.includes('Limites de Processamento Atingidos') || content.includes('Desculpe, tive um erro'))) {
                        content = 'erro da ia';
                    }
                    if (isBot) {
                        content = content.replace(/^-# .*$/gm, '').replace(/🧠 \*\*Processando\.\.\.\*\*/g, '').trim();
                    }
                    if (content.trim().length === 0) continue;
                    content = clipContextText(content, longIds.has(msg.id) ? LONG_CONTEXT_LIMIT : SHORT_CONTEXT_LIMIT);
                    history.push({ line: `${authorName}: ${content}`, keep: msg.id === repliedMessage?.id });
                }
                const contextLines = capContextLines(history);
                const attachments = await attachmentsPromise;
                const hasText = currentUserPrompt.trim().length > 0;
                const attachmentPrompt = buildAttachmentPrompt(attachments, { hasText });
                const currentDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                let envInfo = '';
                if (config.sendEnvironmentInfo) {
                    envInfo = `Servidor: ${message.guild?.name || 'DM'} | Canal: #${message.channel?.name || 'Chat'}\n`;
                }
                const finalPrompt = `--- CONTEXTO ---\nData: ${currentDate}\n${envInfo}${contextLines.join('\n')}\n--- MENSAGEM ATUAL ---\n${message.author.username}: "${hasText ? currentUserPrompt : NO_TEXT_LINE}"\n${attachmentPrompt ? `${attachmentPrompt}\n` : ''}INSTRUÇÃO: Responda diretamente à mensagem atual. Não repita o que o usuário disse nem o que você disse antes.`;
                if (!hasText && attachments.total === 0) {
                    if (allowFixedReply(message.author.id)) replyQuietly(message, 'Oi! Vi que me marcou, mas não entendi o que você precisa.');
                } else if (!hasText && attachments.readCount === 0) {
                    // Só anexo e nada pôde ser lido: resposta fixa, sem gastar a IA (e sem repetir o nome do arquivo na resposta).
                    if (allowFixedReply(message.author.id)) replyQuietly(message, attachmentOnlyReply(attachments));
                } else {
                    // A nota e o conteúdo do anexo vão SÓ no finalPrompt: a busca na web e o auto-ban olham o searchPrompt (a fala limpa).
                    // Com texto de anexo LIDO o arquivo é dado de terceiros (M1/M2/B3): sem ferramentas (um .log não pode acionar ban, download,
                    // entrada em call...), fora do historico.txt e do alerta de conteúdo suspeito, e sem provedor anônimo. `attachmentBlock` é o
                    // trecho exato do prompt que carrega o arquivo.
                    const attachmentOptions = attachments.readCount > 0 ? { disableTools: true, attachmentBlock: attachmentPrompt } : {};
                    addToQueue(finalPrompt, message, 'mention', { allowSearch: true, searchPrompt: hasText ? currentUserPrompt : ATTACH_ONLY_SEARCH_PROMPT, guildId: message.guildId, ...attachmentOptions });
                }
            } catch (error) {
                logger.error(`[MessageCreate] Falha ao montar o pedido da menção: ${String(error?.message ?? error).slice(0, 200)}`);
                const fallbackPrompt = message.content.replace(`<@${client.user.id}>`, '').trim();
                if (fallbackPrompt) {
                    addToQueue(fallbackPrompt, message, 'mention', { allowSearch: true, searchPrompt: fallbackPrompt, guildId: message.guildId });
                } else {
                    message.reply('Oi, tive um erro ao ler o histórico.');
                }
            }
        } else {
            const settings = getChannelSettings(message.channelId);
            if (settings?.chatter?.active) {
                let chance = 0;
                if (settings.chatter.percentage !== undefined && settings.chatter.percentage !== null) {
                    chance = settings.chatter.percentage / 100;
                } else {
                    switch (settings.chatter.frequency) {
                        case 'low': chance = 0.01; break;
                        case 'medium': chance = 0.05; break;
                        case 'high': chance = 0.15; break;
                    }
                }
                if (Math.random() < chance) {
                    if (message.guildId && message.channelId) {
                        const { setServerLastChannel } = await import('../handlers/llmHandler.js');
                        setServerLastChannel(message.guildId, message.channelId);
                        const { checkAndInitializeUpdateChannel } = await import('../handlers/tosHandler.js');
                        await checkAndInitializeUpdateChannel(message.guild, message.channel);
                    }
                    try {
                        const currentUserPrompt = resolveMentions(message.content, client);
                        const history = [];
                        const recentMessages = await message.channel.messages.fetch({ limit: 5, before: message.id });
                        const orderedRecent = [...recentMessages.values()].reverse();
                        const longIds = longContextIds(orderedRecent, { authorId: message.author.id });
                        orderedRecent.forEach(msg => {
                            const isBot = msg.author.id === client.user.id;
                            const authorName = isBot ? 'Yui' : msg.author.username;
                            let content = resolveMentions(msg.content, client);
                            if (isBot && (content.includes('erro ao processar seu pedido') || content.includes('Limites de Processamento Atingidos') || content.includes('Desculpe, tive um erro'))) {
                                content = 'erro da ia';
                            }
                            if (isBot) {
                                content = content.replace(/^-# .*$/gm, '').replace(/🧠 \*\*Processando\.\.\.\*\*/g, '').trim();
                            }
                            if (content.trim().length === 0) return;
                            content = clipContextText(content, longIds.has(msg.id) ? LONG_CONTEXT_LIMIT : SHORT_CONTEXT_LIMIT);
                            history.push(`${authorName}: ${content}`);

                        });
                        const contextLines = capContextLines(history);
                        const currentDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        let envInfo = '';
                        if (config.sendEnvironmentInfo) {
                            envInfo = `Servidor: ${message.guild?.name || 'DM'} | Canal: #${message.channel?.name || 'Chat'}\n`;
                        }
                        const finalPrompt = `--- CONTEXTO ---\nData: ${currentDate}\n${envInfo}${contextLines.join('\n')}\n--- MENSAGEM ATUAL ---\n${message.author.username}: "${currentUserPrompt}"\nINSTRUÇÃO: Entre na conversa espontaneamente sem repetir o que foi dito.`;
                        // chatter: a pessoa não chamou a Yui; se a fila recusar, nada de "você já tem pedidos na fila" (só o log).
                        addToQueue(finalPrompt, message, 'mention', { allowSearch: true, searchPrompt: currentUserPrompt, guildId: message.guildId, chatter: true });

                    } catch (error) {
                        logger.error(`[MessageCreate] Falha ao montar a conversa espontânea: ${String(error?.message ?? error).slice(0, 200)}`);
                    }
                }
            }
        }
    },
};
