function resolveMentions(text, clientInstance) {
    if (!text) return "";
    let resolvedText = text.replace(/<@!?(\d+)>/g, (match, id) => {
        const user = clientInstance.users.cache.get(id);
        return user ? `@${user.username}` : '@UsuárioDesconhecido';
    });
    resolvedText = resolvedText.replace(/<#(\d+)>/g, (match, id) => {
        const channel = clientInstance.channels.cache.get(id);
        return channel ? `#${channel.name}` : '#CanalDesconhecido';
    });
    return resolvedText;
}
/**
 * Desfaz o resolveMentions para as pessoas citadas na mensagem: "@Nome" volta a "<@id>" (o nome mais longo primeiro, para
 * "@Ana" não comer "@Ana Maria"). `users`: coleção/lista de usuários da mensagem (message.mentions.users). Sem usuários, devolve o texto.
 */
function restoreMentionIds(text, users) {
    let t = String(text ?? '');
    let list = [];
    try { list = users && typeof users.values === 'function' ? [...users.values()] : Array.isArray(users) ? users : []; } catch { list = []; }
    list = list.filter((u) => u && u.id && u.username).sort((a, b) => String(b.username).length - String(a.username).length);
    for (const u of list) t = t.split(`@${u.username}`).join(`<@${u.id}>`);
    return t;
}
export { resolveMentions, restoreMentionIds };
export default { resolveMentions, restoreMentionIds };
