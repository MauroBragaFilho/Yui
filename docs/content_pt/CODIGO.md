# ⌨️ Código: a Yui mexendo nos seus projetos

A aba **Código** do app é onde a Yui lê o código de um projeto seu, responde sobre ele, revisa, sugere e, se você liberar, **edita arquivos e roda comandos, sempre pedindo a sua aprovação**. Ela traz para dentro da Yui o que o **Projeto Jarvis** queria ser (um assistente pessoal controlado pelo PC), com os problemas dele corrigidos. Não é outra assistente: é a mesma Yui, a mesma interface e o mesmo Core. Código em `src/core/dev/`.

> **Resumo:** só o **dono**, só em projetos da **lista**, **somente leitura por padrão** e, quando liberado, **aprovação a cada gravação ou comando, dada no próprio computador**.

---

## 📂 Sumário

1. [Ligar](#-1-ligar)
2. [Como usar](#-2-como-usar)
3. [O que protege você](#-3-o-que-protege-você)
4. [Modos de trabalho](#-4-modos-de-trabalho)
5. [Projetos](#-5-projetos)
6. [Onde ficam os dados](#-6-onde-ficam-os-dados)
7. [Limites](#-7-limites)
8. [Problemas comuns](#-8-problemas-comuns)

---

## 🔌 1. Ligar

No `.env`:

```env
YUI_DEV_ENABLED=true          # liga o módulo (padrão: false) e a aba Código aparece para o dono
YUI_PROJECTS=BDS=D:/Projetos/BDS|Yui=D:/Projetos/Yui   # projetos fixos (opcional)
# YUI_DEV_APPROVAL=ask        # ask (padrão): pergunta antes de gravar e de rodar comando
#                             # auto: grava sem perguntar (com backup); comandos ainda perguntam
# YUI_DEV_MAX_STEPS=12        # máximo de passos (ferramentas) por pergunta
# YUI_DEV_PROJECTS_FILE=secrets/dev-projects.json   # onde ficam os projetos cadastrados pelo app
```

Reinicie a Yui. Variáveis em [Variáveis de ambiente](ENVIRONMENT.md#-9-yui-core-código).

O módulo **não** muda o modo somente leitura: com `YUI_READ_ONLY=true` (o padrão) a Yui lê e responde, mas **não grava nem roda comandos**. Para liberar:

```env
YUI_READ_ONLY=false
```

e use o app **no próprio computador** (veja [a seção 3](#-3-o-que-protege-você)).

---

## 💬 2. Como usar

1. Abra o app (`http://localhost:8081`, ou a **Yui Desktop**, que é a janela dele) e entre como dono.
2. Vá em **Código**. À esquerda: **Projetos**, **Adicionar projeto** (só no computador) e a **árvore de arquivos**. Clique num arquivo para vê-lo e deixá-lo **em foco**: a Yui recebe esse arquivo como contexto da próxima pergunta.
3. Escolha o **modo** (Yui, Desenvolvedora, Revisora...) e escreva: "o que faz a função `soma`?", "revise `src/api.js`", "crie um teste para isso".
4. Enquanto trabalha, a tela mostra o que ela faz: `✔ Lendo src/soma.js`, `… Gravando notas.txt`. Quando precisar gravar ou rodar algo, aparece um **cartão de aprovação** com exatamente o que será feito:
   - **Aprovar**: ela executa e continua.
   - **Negar** (ou não responder em 5 minutos): nada é feito e ela segue sem isso.
5. **Parar** cancela a execução. **Limpar conversa** apaga o histórico guardado daquele projeto.

No celular (pelo Tailscale) a aba funciona para **ler e conversar**; os botões de aprovação ficam desativados com o aviso para aprovar no computador, e a Yui nem tenta gravar.

**Yui Desktop:** a janela do computador mostra este mesmo app e acrescenta o botão **Escolher pasta…** para cadastrar projetos. Veja `D:\Projetos\Projeto Jarvis\Yui Desktop`.

---

## 🛡️ 3. O que protege você

| Proteção | Como funciona |
|----------|---------------|
| **Só o dono** | Todas as rotas `/v1/dev/*` exigem o papel OWNER no backend; membros recebem `403` |
| **Somente leitura por padrão** | Com `YUI_READ_ONLY=true` as ferramentas de gravar e de rodar comandos são negadas, e a tela avisa |
| **Aprovação no computador** | Aprovar uma ação e cadastrar/remover projetos só vale se o pedido vier **do próprio PC**. Pedido que passa por proxy (Tailscale Serve, cabeçalhos `X-Forwarded-*`/`Tailscale-User-*`) conta como remoto: lê e conversa, **não aprova nada** |
| **Projetos da lista** | A Yui só abre pastas de `YUI_PROJECTS` ou cadastradas pelo dono. O cadastro recusa a raiz do disco, a sua pasta pessoal, pastas do Windows e `.ssh`, `.aws`, `.gnupg`, `.kube` |
| **Não sai do projeto** | Os caminhos são resolvidos com `path.relative` + `realpath`: `..`, pasta irmã com nome parecido e links simbólicos não escapam |
| **Arquivos sensíveis** | `.env`, `*.pem`, `*.key`, `id_rsa`, `credentials`, `secrets*`, `.npmrc`... **nunca** são lidos nem gravados, e nem aparecem na árvore |
| **Comandos** | Perigosos (`rm -rf`, `format`, `git push --force`, `curl \| sh`, `shutdown`...) são **sempre negados**. Só de consulta (`git status`, `npm test`, `tsc --noEmit`...) rodam sem perguntar. O resto pede aprovação. O ambiente do comando não leva as suas chaves e há tempo limite |
| **Edição segura** | Edição por blocos `SEARCH/REPLACE`: o trecho precisa existir **uma única vez**, tudo ou nada. Antes de gravar, o arquivo vai para `.yui/backups/` no projeto, e a gravação é atômica |
| **Texto é dado, não ordem** | O que vem de arquivos, da web e de comandos entra na conversa marcado como dado; a Yui não obedece instruções que apareçam ali |
| **IA** | Usa o LM Studio e, se faltar, o [Gateway](GATEWAY.md), sempre marcado como **sensível**: nunca vai a provedor anônimo (sem chave) |
| **Limites** | Uma execução por vez; mensagem de até 8.000 caracteres; 30 pedidos/min na rota que inicia a execução; aprovação expira em 5 min; execuções somem da memória 30 min depois de acabar |
| **Auditoria** | `logs/core-audit.jsonl` guarda início da execução, ferramenta usada e decisão de aprovação, **sem** o conteúdo dos arquivos nem das suas mensagens |

---

## 🎭 4. Modos de trabalho

Cada modo define o jeito de trabalhar **e** quais ferramentas ela pode usar.

| Modo | Para quê | Pode gravar/rodar? |
|------|----------|--------------------|
| **Yui** | Geral: conversar, ler, mudar | Sim (com aprovação) |
| **Desenvolvedora** | Implementar e corrigir | Sim |
| **Revisora** | Revisar o código e apontar problemas | **Não** (só leitura) |
| **Arquiteta** | Pensar a estrutura e as decisões | **Não** (só leitura) |
| **Documentação** | Escrever e atualizar docs | Sim |
| **Testes** | Criar e rodar testes | Sim |
| **DevOps** | Scripts, build, deploy | Sim |

A personalidade é a de `persona/yui-dev.md` (curta, direta, em português), relida ao ser alterada.

---

## 📁 5. Projetos

Duas origens, somadas:

- **`YUI_PROJECTS`** no `.env`: fixos; só se mudam no arquivo.
- **Cadastrados no app** (**Adicionar projeto**, com nome e pasta; ou **Escolher pasta…** na Yui Desktop): ficam em `secrets/dev-projects.json` (fora do Git) e podem ser removidos pelo app. Só são aceitos/removidos a partir do computador da Yui.

---

## 🗄️ 6. Onde ficam os dados

| O quê | Onde |
|-------|------|
| Conversa por projeto (só o texto) | `database/dev-history/` |
| Índice de busca do código | `database/dev-index/` (reconstruído sozinho; incremental) |
| Backups dos arquivos alterados | `.yui/backups/<data>/` **dentro do projeto** (a pasta `.yui` se ignora no Git sozinha) |
| Projetos cadastrados | `secrets/dev-projects.json` |

As três primeiras estão no `.gitignore` da Yui. **Limpar conversa** apaga o histórico do projeto.

---

## ⚠️ 7. Limites

- Foi testada com testes automáticos e IA **simulada** (`npm run test:dev`, `npm test` no app) e com a tela real; o uso com um modelo de verdade depende do seu LM Studio/Gateway estar no ar e de o modelo seguir o formato de ferramentas (modelos pequenos podem errar, e a Yui responde em texto quando isso acontece).
- Resposta **não** chega palavra por palavra: o app consulta a execução a cada ~0,7 s.
- Não tem editor de código, terminal interativo nem anexo de imagem.
- Uma execução por vez em toda a Yui; cancelar é pelo botão **Parar**.
- Não comita nem envia nada ao GitHub por conta própria (`git push --force` é negado, e `git commit` pede aprovação como qualquer comando).

---

## 🩺 8. Problemas comuns

| Sintoma | O que fazer |
|---------|-------------|
| A aba **Código** não aparece | Confira `YUI_DEV_ENABLED=true`, reinicie a Yui e entre como **dono** (membros não veem a aba) |
| "Somente leitura" no topo | É o padrão. Para gravar: `YUI_READ_ONLY=false` e reinicie |
| Botões de aprovação desativados | Você abriu pelo celular/Tailscale. Aprove no app do computador |
| "(sem pasta)" ao lado do projeto, ou "A pasta deste projeto não existe mais." | O caminho não existe mais; corrija em `YUI_PROJECTS` ou remova e cadastre de novo |
| "A Yui ainda está trabalhando em outro pedido." | Espere terminar ou clique em **Parar** |
| Resposta estranha ou JSON na tela | O modelo não seguiu o formato de ferramentas; tente o modo **Yui**, uma pergunta mais direta ou um modelo maior |
| Falha de IA | Veja o [Gateway](GATEWAY.md) e a aba **Admin → IA** (teste os provedores) |
