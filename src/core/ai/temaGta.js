// O ASSUNTO é GTA Online? Só nesses casos a Yui injeta os dados do jogo e o conhecimento de GTA no prompt (em conversa sobre outros jogos eles só gastariam tokens e
// puxariam o tema) e só neles uma recusa genérica do modelo é refeita (ver recusa.js). Módulo puro, sem dependências (o /yui e o cérebro usam o mesmo).
const GTA_TOPIC =
  /\b(gta\w*|rockstar|los santos|golpes?|cayo|perico|van de armas|gun van|traficantes?|comerciantes?|naufr[aá]gio|colecion[aá]veis|contra o rel[oó]gio|time trials?|bandito|junk energy|semanal|nightclub|bunker|acid lab|p[oó]dio|reset)\b/i;

export function isGtaTopic(pergunta) {
  return GTA_TOPIC.test(pergunta || '');
}
