// O PERFIL DE IA do chat do app (etapa 10, piloto do app; o desenho dos perfis está em docs/RELATORIO_ETAPA9_PERFIS_IA.md).
//
// O app (POST /v1/chat e POST /v1/agent) usa o MESMO seletor determinístico do cérebro (src/cerebro/seletorPerfil.js): o cérebro o entrega ao servidor da API
// quando sobe (startApi(..., { selecionarPerfil })). Este arquivo só monta o campo da chamada de IA a partir dele e fica no Core de propósito: o Core não
// importa o cérebro. Regras:
//  - SEM seletor (processo único, testes) ou sem nenhum perfil configurado, o resultado é `{}`: a chamada de IA não ganha nenhum campo novo e o
//    comportamento é IDÊNTICO ao de antes;
//  - a privacidade é a MESMA que o AI Manager aplica à chamada (memória pessoal = conversa privada): a conversa do dono no app vai pelo perfil `privado`
//    SE ele estiver declarado (e cai na falha fechada se a rota dele não estiver verificada); a de um membro (memória pública) vai pelo perfil geral;
//  - o seletor só recebe fatos desta chamada (o ponto, a privacidade, o texto da pessoa e o tamanho do histórico): nunca o id nem o papel de ninguém,
//    e nada fica guardado entre as chamadas (o pedido de uma pessoa nunca herda o perfil de outra);
//  - um seletor que lança vale como "sem perfil" (o fluxo de hoje). O modelo escolhido não concede permissão nenhuma.
export function perfilDoApp(selecionar, { ctx = null, texto = '', history = [] } = {}) {
  if (typeof selecionar !== 'function') return {};
  try {
    const historicoChars = (Array.isArray(history) ? history : []).reduce((n, h) => n + String(h?.content ?? '').length, 0);
    const perfil = selecionar({ ponto: 'conversa', privada: ctx?.memoryScope === 'personal', texto: String(texto ?? ''), historicoChars });
    return perfil ? { perfil } : {};
  } catch {
    return {};
  }
}
