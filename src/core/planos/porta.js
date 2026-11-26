// A porta dos planos no processo que fala com o Discord: no processo único é o próprio serviço; no bot separado, o pedido ao cérebro.
// Sem porta instalada (chave desligada), nada acontece. { rotear({ userId, texto, idem }), decidir({ userId, id, versao, hash, aprovar }) }
let porta = null;
export const definirPortaDePlanos = (p) => { porta = p; };
export const portaDePlanos = () => porta;
