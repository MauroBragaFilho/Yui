// Palavras proibidas da Yui: moderação de nomes de servidor/canal e de pedidos (banHandler.checkAutoBan), da consulta que vai a um buscador
// (agente de pesquisa e smartSearch: OBRIGATÓRIA no modo privado) e do que a Yui fala na call (TTS). Dado PURO, sem imports: o Core usa
// direto e o banHandler reexporta este MESMO array (uma lista só, sem cópia; a ordem e as repetições são as de sempre).
export const forbiddenKeywords = [
    'nsfw', 'porn', 'hentai', 'gore', 'sexo', 'puta', 'caralho', 'buceta', 'pinto', 'pênis', 'vagina', '18+', 'pornografia', 'pornô',
    'estupro', 'pedofilia', 'bestialidade', 'necrofilia', 'zoofilia', "porno", "pornhub", "redtube", "rule34", "r34", "lolicon", "shotacon",
    'suicídio', 'auto-mutilação', 'autoflagelação',
    'terrorismo', 'nazismo', 'hitler', 'suástica', 'extremismo', '1488',
    'xvideos', 'pornhub', 'redtube', 'rule34', 'r34', 'lolicon', 'shotacon',
    'foder', 'fodendo', 'foda-se', 'fodase', 'boquete', 'viado', 'traveco', 'punheta', 'orgia', 'suruba', 'nude', 'nudes', 'clitóris', 'ânus', 'felação',
    'masturbação', 'masturbar', 'ejaculação', 'sêmen',
    'arrombado', 'filho da puta', 'fdp',
    'cuzão', 'bicha',
    'boob', 'boobs', 'tits', 'fuck', 'bitch',
    'estuprar', 'estuprador',
    'pedófilo',
    'automutilação', 'suicidar',
    'homicídio', 'assassinato', 'decapitação', 'desmembramento', 'tortura', 'esquartejamento', 'assassinar',
    'fascismo', 'fascista', 'neonazista', 'neonazismo',
    'ku klux klan', 'swastika', 'white power'
];
