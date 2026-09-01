# 🛠️ Desenvolvimento Externo e Sistema de Ferramentas (MCP)

Este guia é voltado para desenvolvedores e entusiastas que desejam expandir o cérebro da Yui usando o **Model Context Protocol (MCP)**.

---

## 📂 Sumário

1. [🧰 1. Entendendo as "Tools" (Ferramentas)](#-1-entendendo-as-tools-ferramentas)
2. [🤖 2. Ferramentas Nativas Melhoradas (MCP)](#-2-ferramentas-nativas-melhoradas-mcp)
3. [📂 3. Como criar uma nova Ferramenta?](#-3-como-criar-uma-nova-ferramenta)
4. [🏗️ 4. Personalizando a Alma (System Prompt)](#-4-personalizando-a-alma-system-prompt)
5. [💡 Dicas de Desenvolvimento](#-dicas-de-desenvolvimento)

---

## 🧰 1. Entendendo as "Tools" (Ferramentas)

A Yui não sabe fazer tudo sozinha. Ela utiliza "Tools" para estender suas capacidades. Quando a IA responde em formato JSON contendo um campo `tool`, o bot interrompe a resposta de texto e executa uma função programada.

### O Fluxo Técnico:
1.  **Declaração:** A ferramenta é descrita no arquivo `src/data/mcp_tools.json`.
2.  **Identificação:** A IA recebe essas descrições no System Prompt.
3.  **Execução:** O `llmHandler.js` intercepta o JSON, executa a lógica em Node.js (ex: `performWebSearch`) e devolve o resultado para a IA finalizar a resposta.

---

## 🤖 2. Ferramentas Nativas Melhoradas (MCP)

O ecossistema MCP da Yui foi robustamente aprimorado com comportamentos nativos específicos:

### 1. Câmbio e Finanças (`convert_currency`)
- **Resiliência a Erros:** O MCP foi aprimorado para lidar com rate-limit e falhas de API financeira. Caso a API principal falhe, há um fallback de cotação.
- **Cache Diário:** O sistema salva uma tabela diária de conversões no arquivo JSON local, evitando requisições desnecessárias a moedas frequentes.

### 2. Busca de Jogos (`search_game`)
- **Flexibilidade Linguística:** Se o nome do jogo buscado falhar na base FitGirl/DODI, a IA tenta buscar por nomes ligeiramente diferentes ou variações.
- **Embed de Lista:** A ferramenta pode retornar uma lista interativa de jogos encontrados, permitindo que a IA apresente uma seleção para o usuário escolher em vez de enviar diretamente o Torrent.

### 3. Geração de Imagens (`image_gen`)
- **Transparência de Limitações:** A IA agora é instruída a recusar pedidos de edição de imagens e deixar claro que não possui visão computacional nativa em tempo real ao usar a ferramenta.

### 4. Downloader de Mídia (`download_video`, `download_audio` & `search_and_download_music`)
- **Direcionamento Inteligente:** A IA identifica a intenção do usuário sobre baixar vídeo ou áudio. Caso o pedido seja ambíguo, a IA faz perguntas de esclarecimento ao usuário no chat em vez de disparar a ferramenta às cegas. O MCP não inicia processos de compressão; essa decisão fica a cargo do Discord e do usuário via botões.
- **Busca e Download de Música (`search_and_download_music`):** Permite à IA buscar e baixar músicas em MP3 HQ diretamente do Deezer via `deemix`. Se a busca possuir alta pontuação de certeza (>=80%), realiza o download imediato; caso seja ambígua, apresenta uma lista textual com as 5 opções acompanhada de menu suspenso para escolha pelo usuário.

### 5. Info de Jogos (`check_game_info`)
- **Fontes Combinadas:** Consulta RAWG.io (nota da comunidade, gêneros, plataformas, desenvolvedora) + HowLongToBeat (tempo de campanha, campanha+extras, 100%).
- **Fallback para Steam:** Quando a RAWG não está configurada, o sistema busca metacritic e sinopse pela Steam API (gratuita), mantendo a tool útil mesmo sem `RAWG_API_KEY`.

### 6. Compatibilidade de PC (`check_pc_compatibility`)
- **Comparação de Specs:** Recebe o jogo e (opcionalmente) CPU/GPU/RAM do usuário, compara com os requisitos mínimos/recomendados extraídos da Steam API e dá um veredito natural: "roda tranquilo", "roda no mínimo", "vai sofrer" ou "não vai rodar".
- **Persistência:** Specs podem ser salvas em `src/data/user_pc_specs.json` por userId. Se não houver specs nem cadastro, a Yui pergunta antes de comparar.

---

## 📂 3. Como criar uma nova Ferramenta?

### Passo 1: Definir no JSON
Adicione um novo objeto em `src/data/mcp_tools.json`:
```json
{
  "type": "function",
  "function": {
    "name": "meu_comando",
    "description": "Explicação para a IA saber quando usar.",
    "parameters": { ... }
  }
}
```

### Passo 2: Implementar no Handler
No arquivo `src/handlers/llmHandler.js`, adicione a lógica de execução dentro da função `processQueue()` ou crie um handler específico. Certifique-se de tratar erros para que a IA não fique "travada" esperando uma resposta.

---

## 🏗️ 4. Personalizando a Alma (System Prompt)

A personalidade da Yui não é apenas texto; é um conjunto de diretrizes de segurança e comportamento.
- **Local:** `src/config/index.js` -> campo `systemPrompt`.
- **Dica:** Se você alterar as regras de formatação (como permitir emojis), lembre-se de que isso pode aumentar o consumo de tokens e mudar o "tom" das conversas.

---

## 💡 Dicas de Desenvolvimento

- 💡 **Logs de Pensamento (Thought Trace):** Observe o console. A Yui imprime o `"thought"` da IA antes de cada ação de ferramenta. Se ela estiver "alucinando", ajuste a descrição da ferramenta no JSON.
- 💡 **Permissions:** Ao criar ferramentas que deletam mensagens ou gerenciam cargos, certifique-se de que o Bot tem essas permissões no Discord, caso contrário, a `discord.js` lançará um erro de `Missing Permissions`.
- 💡 **Sanitização de JSON:** Sempre passe as saídas da IA por um filtro de `JSON.parse` se você estiver pedindo logs estruturados, pois modelos menores podem "vazar" chaves como `{"resposta": "..."}` no meio do texto.
- 💡 **Comentários Internos (Internal Comments):** O bot usa chamadas recursivas (`isInternalComment: true`) para gerar falas naturais após o uso de ferramentas, garantindo que a IA sempre tenha uma "voz" humana após processar dados brutos.
- 💡 **Isolamento de Erros:** Sempre use `try-catch` em volta de novas ferramentas. Uma ferramenta mal implementada pode derrubar todo o processo do bot se não for tratada.

---
[🏠 Voltar ao Menu Principal](../README.md)
