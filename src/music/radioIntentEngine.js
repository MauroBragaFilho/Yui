function parseRadioIntent(text) {
    if (!text || typeof text !== 'string') return null;

    const cleanText = text.toLowerCase().trim();

    if (/\b(pausa|pausar|pause|espera|silêncio|silencio|para um pouco|dá um tempo|da um tempo|hold|cala a boca|cala boca)\b/i.test(cleanText)) {
        return { type: 'PAUSE' };
    }

    if (/\b(parar|pare|para|parar rádio|parar radio|pare o rádio|pare o radio|pare a música|pare a musica|para a música|para a musica|desliga a música|desliga a musica|stop|cancela|desliga|desliga o rádio|desliga o radio|fechar|encerrar)\b/i.test(cleanText)) {
        return { type: 'STOP' };
    }

    if (/\b(sair|saia|sai|sair da call|saia da call|sai da call|sair do canal|saia do canal|sai do canal|vaza|vazar|desconectar|desconecta|tchau|até logo|ate logo|sair da cal|saia da cal|sai da cal|sai daqui)\b/i.test(cleanText)) {
        return { type: 'LEAVE' };
    }

    if (/\b(próxima|proxima|passa|pula|skip|avançar|avancar|próxima música|proxima musica|passa essa|troca|muda música|muda musica|mudar música|mudar musica|passar)\b/i.test(cleanText)) {
        return { type: 'NEXT' };
    }

    if (/\b(anterior|voltar|música anterior|musica anterior|voltar música|voltar musica|toca a anterior|toca anterior|tocar anterior)\b/i.test(cleanText)) {
        return { type: 'PREVIOUS' };
    }

    if (/\b(embaralhar|modo aleatório|modo aleatorio|shuffle|misturar|ordem aleatória|ordem aleatoria|ativar aleatorio|ativar modo aleatorio|ativar shuffle)\b/i.test(cleanText)) {
        return { type: 'SHUFFLE' };
    }

    if (/\b(repetir|loop|modo de repetição|modo de repeticao|repetir música|repetir musica)\b/i.test(cleanText)) {
        return { type: 'LOOP' };
    }

    if (/\b(que música é essa|que musica e essa|qual o nome dessa música|qual o nome dessa musica|quem tá cantando|quem ta cantando|nome da música|nome da musica)\b/i.test(cleanText)) {
        return { type: 'INFO' };
    }

    if (/\b(mostra a fila|ver fila|lista de músicas|lista de musicas|quais músicas tem|quais musicas tem|ver a lista|mostra a lista)\b/i.test(cleanText)) {
        return { type: 'QUEUE' };
    }

    const removeMatch = cleanText.match(/\b(?:remover|tira|tirar|apagar|deletar)\s+(?:a\s+música\s+|a\s+faixa\s+|música\s+|faixa\s+|número\s+|numero\s+)?(\d+)\b/i);
    if (removeMatch) {
        return { type: 'REMOVE', position: parseInt(removeMatch[1], 10) };
    }

    const addPrefixRegex = /(?:^|\b)(?:toca|tocar|bota|botar|bote|coloca|colocar|coloque|adicione|adicionar|pesquisa|pesquisar|reproduzir|solta|soltar)\s+(?:a\s+música\s+|a\s+musica\s+|o\s+som\s+de\s+|a\s+faixa\s+)?(.+)$/i;
    const addMatch = cleanText.match(addPrefixRegex);
    if (addMatch && addMatch[1]) {
        let query = addMatch[1].trim();
        query = query.replace(/\s+(?:então|cara|por favor|aí|ai|mano|bro|velho|tipo|assim).*$/i, '').trim();
        query = query.replace(/[.,!?:;]+$/, '').trim();
        if (query.length >= 2) {
            return { type: 'ADD', query };
        }
    }

    if (/\b(tocar|play|retomar|voltar a tocar|despausar|solta o som|continua|solta a música|solta a musica|despausar)\b/i.test(cleanText)) {
        return { type: 'RESUME' };
    }

    return null;
}

export { parseRadioIntent };
