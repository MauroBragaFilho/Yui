// A porta dos comandos da live no processo que recebe a mensagem: no cérebro e no processo único é o próprio serviço; no bot separado, o pedido ao cérebro.
// Sem porta instalada (chave desligada), nada acontece. { rotear({ userId, texto, canal, idem }) => { handled, text } }
let porta = null;
export const definirPortaDaLive = (p) => { porta = p; };
export const portaDaLive = () => porta;
