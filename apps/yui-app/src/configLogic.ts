// Grupos e busca da tela "Configuração e chaves". Sem React para poder ser testado em Node.
type Ajuste = { chave: string; rotulo: string; grupo: string; descricao: string };

export const gruposDosAjustes = (itens: Ajuste[]): string[] => [...new Set(itens.map((i) => i.grupo))];

const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Com busca, procura em todos os grupos (nome, descrição, grupo e chave, sem acento); sem busca, mostra o grupo escolhido (null = todos). */
export function filtrarAjustes<T extends Ajuste>(itens: T[], grupo: string | null, busca: string): T[] {
  const termo = normal(busca.trim());
  if (termo) return itens.filter((i) => normal(`${i.rotulo} ${i.descricao} ${i.grupo} ${i.chave}`).includes(termo));
  return grupo === null ? itens : itens.filter((i) => i.grupo === grupo);
}
