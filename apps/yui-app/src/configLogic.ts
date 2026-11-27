// Grupos e busca da tela "Configuração e chaves". Sem React para poder ser testado em Node.
type Ajuste = { chave: string; rotulo: string; grupo: string; descricao: string };

export const gruposDosAjustes = (itens: Ajuste[]): string[] => [...new Set(itens.map((i) => i.grupo))];

const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Como editar um ajuste: os que se digitam (número inteiro, número com casas decimais, texto e chave) ganham um campo; o texto de exemplo diz a faixa.
 * O decimal (a temperatura da IA, lacunas do painel item 6) aceita vírgula ou ponto; o servidor confere a faixa de novo.
 */
export function campoDoAjuste(item: { tipo: string; min?: number; max?: number }): { digitado: boolean; numerico: boolean; teclado: 'numeric' | 'decimal-pad' | 'default'; exemplo: string } {
  const numerico = item.tipo === 'int' || item.tipo === 'decimal';
  const digitado = numerico || item.tipo === 'texto' || item.tipo === 'segredo';
  const faixa = `Número de ${String(item.min ?? '').replace('.', ',')} a ${String(item.max ?? '').replace('.', ',')}`;
  const exemplo = item.tipo === 'segredo' ? 'Colar nova chave' : item.tipo === 'decimal' ? `${faixa} (por exemplo 0,7)` : numerico ? faixa : 'Novo valor';
  return { digitado, numerico, teclado: item.tipo === 'decimal' ? 'decimal-pad' : numerico ? 'numeric' : 'default', exemplo };
}

/** Com busca, procura em todos os grupos (nome, descrição, grupo e chave, sem acento); sem busca, mostra o grupo escolhido (null = todos). */
export function filtrarAjustes<T extends Ajuste>(itens: T[], grupo: string | null, busca: string): T[] {
  const termo = normal(busca.trim());
  if (termo) return itens.filter((i) => normal(`${i.rotulo} ${i.descricao} ${i.grupo} ${i.chave}`).includes(termo));
  return grupo === null ? itens : itens.filter((i) => i.grupo === grupo);
}
