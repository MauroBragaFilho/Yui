# Base de Conhecimento da Yui

Coloque aqui arquivos `.txt` ou `.md` com qualquer informação que você
queira que a Yui saiba ao responder no comando `/yui` (ou
`+yui perguntar`): dicas, builds, melhores golpes/estratégias, buffs e
debuffs, guias de negócios, o que quiser.

## Como funciona

- Todo arquivo `.txt` ou `.md` colocado nesta pasta é lido automaticamente.
- Não precisa reiniciar o bot: o conteúdo é recarregado a cada 1 minuto.
- Dê nomes descritivos aos arquivos (o nome também é mostrado pra IA como
  contexto), ex: `buffs-armas.md`, `melhor-negocio-solo.txt`.
- Cada arquivo tem um limite de ~6.000 caracteres, e o total de todos os
  arquivos somados tem um limite de ~18.000 caracteres (pra não estourar o
  contexto do modelo de IA, especialmente em modelos locais via LM Studio).
  Se você tiver muito conteúdo, prefira resumos objetivos em vez de colar
  textos gigantes.
- Se o limite total for ultrapassado, os arquivos que vierem depois (em
  ordem alfabética) são ignorados naquela consulta — o log do bot avisa
  quando isso acontece.

## Formato sugerido

Markdown simples funciona bem, por exemplo:

```markdown
# Melhores negócios solo

- Nightclub: bom pra quem joga sozinho, gera renda passiva.
- Acid Lab: alto lucro por hora, mas precisa de setup caro.

# Buffs ativos nesta semana
- +50% RP em corridas
- Desconto de 30% no Arcade
```

Veja `exemplo-dicas.md` nesta mesma pasta para um exemplo completo.
