// A PORTA da live dos amigos: o bot fala com o serviço por aqui, sem saber onde ele roda.
//  - processo único: a porta é o próprio serviço (index.js);
//  - cérebro separado: no bot, a porta pede pelo canal (canalCerebro.js); no cérebro, o serviço é registrado para os "esquecer".
// O gancho dos "esquecer" (forgetAll e forgetUserContext) só age no processo onde o serviço mora; nos outros não faz nada.

let porta = null;
let servicoLocal = null;

/** @param {{ comando: Function, botao: Function, mensagemEnviada: Function } | null} p */
export function definirPortaLiveAmigos(p) { porta = p ?? null; }
export function portaLiveAmigos() { return porta; }

/** O serviço que mora NESTE processo (cérebro ou processo único), para os "esquecer". */
export function definirServicoLiveAmigos(s) { servicoLocal = s ?? null; }

/** Chamado pelos "esquecer" da Yui: se a pessoa tem vínculo, ele é apagado pela mesma rotina do "apagar meus dados". Nunca lança. */
export function apagarVinculoDe(userId) {
  if (!servicoLocal || !userId) return;
  try {
    Promise.resolve(servicoLocal.apagarVinculoDe(String(userId))).catch(() => {});
  } catch { /* o esquecer nunca falha por causa do vínculo */ }
}
