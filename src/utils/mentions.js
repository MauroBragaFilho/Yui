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
export { resolveMentions };
export default { resolveMentions };
