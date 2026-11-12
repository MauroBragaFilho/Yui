// Privado (DM): por padrão a Yui conversa com QUALQUER pessoa; com YUI_DM_EVERYONE=false só com o dono (os demais são ignorados em silêncio).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isForeignDirectMessage as ignoredDm, dmEveryoneEnabled } from '../src/events/messageCreate.js';

const dono = (id) => id === 'dono-1';
// Regra antiga (YUI_DM_EVERYONE=false): só o dono.
const isForeignDirectMessage = (m, isOwner) => ignoredDm(m, isOwner, false);

test('privado do dono: não é estranho (a Yui responde)', () => {
    assert.equal(isForeignDirectMessage({ guildId: null, author: { id: 'dono-1' } }, dono), false);
});

test('privado de outra pessoa: é estranho (ignorado)', () => {
    assert.equal(isForeignDirectMessage({ guildId: null, author: { id: 'alguem' } }, dono), true);
    assert.equal(isForeignDirectMessage({ guildId: undefined, author: { id: 'alguem' } }, dono), true);
});

test('mensagem em servidor nunca é tratada como privado de estranho', () => {
    assert.equal(isForeignDirectMessage({ guildId: '123', author: { id: 'alguem' } }, dono), false);
    assert.equal(isForeignDirectMessage({ guildId: '123', author: { id: 'dono-1' } }, dono), false);
});

test('sem autor: no privado é estranho (falha fechado)', () => {
    assert.equal(isForeignDirectMessage({ guildId: null }, dono), true);
});

test('padrão: qualquer pessoa conversa no privado (nada é ignorado)', () => {
    assert.equal(dmEveryoneEnabled({}), true, 'sem a variável o padrão é liberar');
    assert.equal(dmEveryoneEnabled({ YUI_DM_EVERYONE: 'true' }), true);
    assert.equal(ignoredDm({ guildId: null, author: { id: 'alguem' } }, dono, true), false);
    assert.equal(ignoredDm({ guildId: null, author: { id: 'dono-1' } }, dono, true), false);
    assert.equal(ignoredDm({ guildId: null }, dono, true), false);
});

test('YUI_DM_EVERYONE=false: volta à regra antiga (só o dono)', () => {
    assert.equal(dmEveryoneEnabled({ YUI_DM_EVERYONE: 'false' }), false);
    assert.equal(dmEveryoneEnabled({ YUI_DM_EVERYONE: ' FALSE ' }), false);
    assert.equal(ignoredDm({ guildId: null, author: { id: 'alguem' } }, dono, dmEveryoneEnabled({ YUI_DM_EVERYONE: 'false' })), true);
});
