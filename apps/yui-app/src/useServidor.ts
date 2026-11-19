import { useEffect, useState } from 'react';
import { textoDoServidor, type GerenciadorDeServidor } from './servidores.ts';

/** O texto "Servidor: <host> (rede local)" / "(reserva)" que a tela mostra; atualiza sozinho quando o app troca de endereço. A lógica está em servidores.ts. */
export function useTextoDoServidor(servidor: GerenciadorDeServidor | null): string | null {
  const ler = () => (servidor ? textoDoServidor(servidor.escolha(), servidor.procurando(), servidor.naoConfirmado()) : null);
  const [texto, setTexto] = useState<string | null>(ler);
  useEffect(() => {
    setTexto(ler());
    if (!servidor) return undefined;
    return servidor.aoMudar(() => setTexto(ler()));
  }, [servidor]);
  return texto;
}
