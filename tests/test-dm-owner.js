// Privado (DM): a Yui só conversa com o dono; qualquer outra pessoa no privado é ignorada em silêncio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isForeignDirectMessage } from '../src/events/messageCreate.js';

const dono = (id) => id === 'dono-1';

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
