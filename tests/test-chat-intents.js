// Teste offline das Portas N (memória por conversa) e R (resumo do chat): detecção estrita, confirmação, privacidade em canal público.
// Sem Discord, sem rede e sem tocar em banco: npm run test:chatintents
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectMemoryIntent, runMemoryIntent, detectSummaryRequest, takeSummaryQuota, pickMessagesToSummarize,
    setForgetAllPending, hasForgetAllPending, forgetTokens, __resetChatIntentsForTests
} from '../src/handlers/chatIntents.js';

const direct = { direct: true };
const kind = (t, extra = {}) => detectMemoryIntent(t, { ...direct, ...extra }).kind;

function fakeMemory(rows) {
    const store = rows.map(r => ({ ...r }));
    return {
        store,
        listMemories: () => store.map(r => ({ ...r })),
        forget: (_c, id) => { const i = store.findIndex(r => r.id === id); if (i < 0) return false; store.splice(i, 1); return true; },
        forgetAll: () => { const n = store.length; store.length = 0; return n; }
    };
}
const deps = (memory, extra = {}) => ({ userId: 'u1', isDM: true, enabled: true, scopeLabel: '🔒 permanente', memoryCtx: {}, memory, ...extra });

test('ver a memória por conversa', () => {
    for (const t of ['yui, o que você sabe de mim?', 'o que vc lembra sobre mim', 'mostra minhas lembranças', 'quais são as minhas memórias']) {
        assert.equal(kind(t), 'view', t);
    }
});

test('esquecer por número, por texto e apagar tudo', () => {
    assert.equal(kind('esquece a lembrança #3'), 'forget_id');
    assert.equal(detectMemoryIntent('apaga a memória número 12', direct).id, 12);
    assert.equal(kind('esquece que eu gosto de Sultan RS'), 'forget_text');
    assert.equal(kind('apaga tudo que você sabe de mim'), 'forget_all');
    assert.equal(kind('apaga toda a minha memória'), 'forget_all');
});

test('pergunta, negação, link, voz, rádio, terceiros e não direto NÃO disparam', () => {
    for (const t of ['como apago minha memória?', 'você consegue apagar tudo que sabe de mim?', 'não apaga tudo que sabe de mim', 'oi yui tudo bem', 'esquece']) {
        assert.equal(kind(t), 'none', t);
    }
    const t = 'apaga tudo que você sabe de mim';
    for (const c of [{ voice: true }, { radioMode: true }, { thirdPartyPrompt: true }, { disableTools: true }, { hasAttachment: true }, { direct: false }]) {
        assert.equal(detectMemoryIntent(t, { direct: true, ...c }).kind, 'none', JSON.stringify(c));
    }
    assert.equal(kind('apaga tudo que sabe de mim https://x.com'), 'none');
});

test('apagar tudo só vale depois da confirmação, que expira', async () => {
    __resetChatIntentsForTests();
    const mem = fakeMemory([{ id: 1, type: 'note', content: 'a' }, { id: 2, type: 'note', content: 'b' }]);
    assert.equal(kind('sim, apagar tudo'), 'none', 'sem pedido pendente, "sim" não faz nada');
    const ask = await runMemoryIntent(detectMemoryIntent('apaga tudo que você sabe de mim', direct), deps(mem));
    assert.match(ask.text, /sim, apagar tudo/);
    assert.equal(mem.store.length, 2, 'pedir não apaga');
    assert.equal(hasForgetAllPending('u1'), true);
    const intent = detectMemoryIntent('sim, apagar tudo', { ...direct, pendingForgetAll: true });
    assert.equal(intent.kind, 'confirm_forget_all');
    const done = await runMemoryIntent(intent, deps(mem, { wipeContext: async () => 3 }));
    assert.equal(mem.store.length, 0);
    assert.match(done.text, /Apaguei 2 lembran/);
    assert.match(done.text, /3 fala/);
    assert.equal(hasForgetAllPending('u1'), false);
    // expira
    setForgetAllPending('u2', 1000);
    assert.equal(hasForgetAllPending('u2', 1000 + 3 * 60 * 1000), false);
    // outra conversa ou "não" cancelam
    assert.equal(detectMemoryIntent('qual a cotação do dólar?', { ...direct, pendingForgetAll: true }).kind, 'none');
    assert.equal(detectMemoryIntent('não, deixa', { ...direct, pendingForgetAll: true }).kind, 'cancel_forget_all');
});

test('ver: lista na DM, só a contagem em canal público', async () => {
    const mem = fakeMemory([{ id: 7, type: 'fact', content: 'O nome do usuário é Mauro.' }]);
    const dm = await runMemoryIntent({ kind: 'view' }, deps(mem));
    assert.match(dm.text, /#7/);
    assert.match(dm.text, /Mauro/);
    const pub = await runMemoryIntent({ kind: 'view' }, deps(mem, { isDM: false }));
    assert.doesNotMatch(pub.text, /Mauro/);
    assert.match(pub.text, /1 lembran/);
});

test('esquecer por número e por texto', async () => {
    const mem = fakeMemory([{ id: 1, type: 'preference', content: 'eu gosto de Sultan RS' }, { id: 2, type: 'note', content: 'prefiro café' }]);
    assert.match((await runMemoryIntent({ kind: 'forget_id', id: 99 }, deps(mem))).text, /Não encontrei/);
    const byText = await runMemoryIntent(detectMemoryIntent('esquece que eu gosto de Sultan RS', direct), deps(mem));
    assert.match(byText.text, /esqueci/);
    assert.equal(mem.store.length, 1);
    const none = await runMemoryIntent(detectMemoryIntent('esquece que eu falei foguete', direct), deps(mem));
    assert.equal(none.handled, false, 'sem lembrança parecida segue para o modelo');
    assert.deepEqual(forgetTokens('eu gosto de Sultan RS'), ['gosto', 'sultan']);
});

test('memória desligada avisa e não apaga', async () => {
    const mem = fakeMemory([{ id: 1, type: 'note', content: 'a' }]);
    const r = await runMemoryIntent({ kind: 'forget_all' }, deps(mem, { enabled: false }));
    assert.match(r.text, /desativado/);
    assert.equal(mem.store.length, 1);
});

test('resumo do chat: pedido, quantidade e não-pedidos', () => {
    const ok = (t, c = {}) => detectSummaryRequest(t, { ...direct, ...c });
    assert.equal(ok('yui resume as últimas 50 mensagens').amount, 50);
    assert.equal(ok('faz um resumo da conversa').amount, 20);
    assert.equal(ok('resume o chat pra mim').explicit, true);
    assert.equal(ok('o que rolou aqui no chat?').explicit, true);
    assert.equal(ok('resume 500 mensagens').amount, 100, 'teto');
    assert.equal(ok('resume 1 mensagem').amount, 5, 'piso');
    for (const t of ['você consegue resumir o chat?', 'não resume o chat', 'resume esse texto pra mim', 'oi yui', 'resume o chat https://x.com']) {
        assert.equal(ok(t).explicit, false, t);
    }
    for (const c of [{ voice: true }, { radioMode: true }, { thirdPartyPrompt: true }, { disableTools: true }, { direct: false }]) {
        assert.equal(detectSummaryRequest('resume o chat', { direct: true, ...c }).explicit, false, JSON.stringify(c));
    }
});

test('resumo: 1 por minuto por pessoa, dono sem limite; o próprio pedido sai do log', () => {
    __resetChatIntentsForTests();
    assert.equal(takeSummaryQuota('a', { now: 1000 }).ok, true);
    assert.equal(takeSummaryQuota('a', { now: 2000 }).ok, false);
    assert.equal(takeSummaryQuota('b', { now: 2000 }).ok, true);
    assert.equal(takeSummaryQuota('a', { now: 62_000 }).ok, true);
    assert.equal(takeSummaryQuota('dono', { isOwner: true, now: 1 }).ok && takeSummaryQuota('dono', { isOwner: true, now: 2 }).ok, true);
    const msgs = [
        { author: { id: 'x' }, content: 'oi' },
        { author: { id: 'y' }, content: 'tudo bem?' },
        { author: { id: 'bot', bot: true }, content: '🧠 **Processando...**' },
        { author: { id: 'u1' }, content: 'yui resume o chat' }
    ];
    const picked = pickMessagesToSummarize(msgs, { requesterId: 'u1', amount: 20 });
    assert.deepEqual(picked.map(m => m.content), ['oi', 'tudo bem?']);
    assert.equal(pickMessagesToSummarize(msgs, { requesterId: 'u1', amount: 1 }).length, 1);
});

test('GTA sob demanda por conversa (Porta G)', async () => {
    const { detectGtaIntent } = await import('../src/handlers/chatIntents.js');
    const ctx = { direct: true, voice: false, radioMode: false, disableTools: false, thirdPartyPrompt: false, hasAttachment: false };

    assert.equal(detectGtaIntent('yui o que tem no gta hoje?', ctx).kind, 'daily');
    assert.equal(detectGtaIntent('onde ta a gun van hoje no gta?', ctx).kind, 'daily');
    assert.equal(detectGtaIntent('yui mostra o reset diario do gta', ctx).kind, 'daily');

    assert.equal(detectGtaIntent('yui quais sao os descontos da semana no gta?', ctx).kind, 'weekly');
    assert.equal(detectGtaIntent('mostra o evento semanal do gta', ctx).kind, 'weekly');
    assert.equal(detectGtaIntent('qual o carro do podio do gta online?', ctx).kind, 'weekly');

    assert.equal(detectGtaIntent('yui quais as ultimas noticias do gta?', ctx).kind, 'news');
    assert.equal(detectGtaIntent('novidades da rockstar newswire', ctx).kind, 'news');

    // Negativos e conversas comuns
    assert.equal(detectGtaIntent('nao quero ver nada de gta', ctx).kind, 'none');
    assert.equal(detectGtaIntent('como voce joga gta?', ctx).kind, 'none');
    assert.equal(detectGtaIntent('gta v foi lancado em 2013', ctx).kind, 'none');
    assert.equal(detectGtaIntent('olha essa foto: https://gta.com/foto.png', ctx).kind, 'none');
    assert.equal(detectGtaIntent('o que tem no gta hoje?', { ...ctx, voice: true }).kind, 'none');
    assert.equal(detectGtaIntent('o que tem no gta hoje?', { ...ctx, direct: false }).kind, 'none');
});
test('Modo rádio por conversa', async () => {
    const { detectRadioIntent } = await import('../src/handlers/chatIntents.js');
    const ctx = { direct: true, voice: false, radioMode: false, disableTools: false, thirdPartyPrompt: false, hasAttachment: false };

    assert.equal(detectRadioIntent('yui toca lofi hip hop', ctx).kind, 'play');
    assert.equal(detectRadioIntent('bota a musica da radio los santos', ctx).kind, 'play');
    assert.equal(detectRadioIntent('yui pausa o som', ctx).kind, 'pause');
    assert.equal(detectRadioIntent('yui continua tocando', ctx).kind, 'resume');
    assert.equal(detectRadioIntent('passa essa musica', ctx).kind, 'next');
    assert.equal(detectRadioIntent('desliga o radio yui', ctx).kind, 'stop');
    assert.equal(detectRadioIntent('que musica e essa?', ctx).kind, 'info');

    // Negativos
    assert.equal(detectRadioIntent('nao toca nada agora', ctx).kind, 'none');
    assert.equal(detectRadioIntent('como voce toca musica?', ctx).kind, 'none');
    assert.equal(detectRadioIntent('eu gosto de musica classica', ctx).kind, 'none');
    assert.equal(detectRadioIntent('toca lofi', { ...ctx, direct: false }).kind, 'none');
});