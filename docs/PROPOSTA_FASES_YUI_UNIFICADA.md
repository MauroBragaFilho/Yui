# Proposta de fases: Yui única (sem Jarvis), com máquina mais forte

> Proposta de 10/11/2026, **para aprovação do dono**. Nada daqui está implementado. Parte do `ROADMAP_EVOLUCAO.md` (Fases 0 a 5, R01 a R20) e do estado real do código e da produção; não substitui o roadmap enquanto não for aprovada.

## 1. Premissas

- O Jarvis (`D:\Projetos\Projeto Jarvis`) foi abandonado; o que ele prometia (assistente que **faz programas**, nível 4, IA local, motor de código plugável, pacote de revisão) passa a ser uma fase da Yui.
- A máquina atual é o notebook (ASUS X450LD, 4 GB de RAM, HD, sem GPU útil). A máquina forte ainda **não tem especificação**: tudo que depende dela (IA local, voz local, RAG) fica atrás de um portão de medição (Fase M).
- Regra herdada do Jarvis e mantida: **o bot exposto e o agente que grava/executa não dividem processo**. O agente de código é um worker separado, com política própria, que sobrevive a reinício do bot.
- Ordem de segurança do roadmap original continua: **política antes de poder** (nenhuma ação no sistema antes da Fase 1).

## 1.1 Foco atual (decisão de 10/11/2026)

Por enquanto a Yui **fica no notebook** e a **IA fica na nuvem**. Ficam adiadas as Fases 3 (IA local, RAG), 5 (voz local) e M (máquina nova) até existir o hardware. O trabalho agora é fazer a Yui **rodar e aguentar** nessa máquina (4 GB de RAM, HD, Wi-Fi):

| # | Item | Por quê |
|---|---|---|
| 1 | Atualizador seguro (Fase 0, R08): rodar os testes antes de aplicar, cobrir `apps/`, voltar a versão se falhar, não sobrescrever `src/data` | Hoje um push ruim vira produção às 04:00 |
| 2 | Observabilidade: relatório diário de saúde (RAM, disco, uptime, reconexões, erros) e alerta ao dono só do que importa | Hoje só se descobre pelo "Erro grave" |
| 3 | Memória e disco: teto de RAM do processo e do Chrome (Reddit), rotação de logs e backups, limpeza de temporários | 4 GB e HD são o gargalo |
| 4 | Rede instável: timeout em toda chamada externa (YouTube, Reddit, provedores de IA), reconexão sem cair | A queda de Wi-Fi de 10/11 mostrou chamadas sem prazo |
| 5 | Backup: cópia fora do notebook e teste de restauração | Disco único, HD antigo |
| 6 | Brechas de permissão conhecidas (`+yui` em DM, banir o dono, `/chat_updates`) | Fase 0, barato e importante |
| 7 | Supervisão: health check que religa só a Yui, sem criar segunda instância | R08; o `yui-supervisor.ps1` atual não serve (subiria duas) |

A Fase 1 (política) e a Fase 2 (rotina pessoal, só com IA na nuvem) seguem valendo, mas só depois dos itens 1 a 5.

**Andamento em 11/11/2026:**

- Item 1 (atualizador): feito o que dava para fazer sem hardware novo. Antes de aplicar, ele sobe o código novo numa pasta temporária e confere que chega ao login do Discord (pega arquivo faltando e erro de sintaxe); espera até 4 min a Yui ficar de pé; não pula mais `src\database`. Falta cobrir `apps/` (o painel ainda é copiado à mão, porque o build não está no git).
- Item 2 (observabilidade): relatório diário de saúde por DM às 08:00 (`YUI_HEALTH_REPORT`).
- Item 3 (memória e disco): o Chrome do Weekly agora tem recuo depois de falha, um por vez, prazo de 60 s e prioridade baixa. Os backups do atualizador já guardam só 3 e os logs rodam em 14 dias.
- Item 4 (rede): prazo padrão de 45 s para todo `fetch` e `axios` que não define o seu (`YUI_HTTP_TIMEOUT_MS`).
- Item 5 (backup fora do notebook): **pendente, depende de escolher o destino** (PC, Drive ou outro).
- Item 6 (permissões): feito, com teste (`test:permgaps`).
- Item 7 (supervisão que religa só a Yui): pendente.

## 2. Visão geral

| Fase | Nome | Roda no notebook? | Depende de |
|---|---|---|---|
| 0 | Fechar a fundação | sim | — |
| 1 | Política de 4 estados (R01, R03, R02) | sim | 0 |
| M | Migração para a máquina forte | — | decisão de hardware |
| 2 | Rotina pessoal e proatividade | sim | 0 |
| 3 | IA local, RAG e memória v2 | não (precisa da máquina nova) | M, 0 |
| 4 | Yui Dev: agente de código nível 4 | só com modelo na nuvem | 1, 3 (para o modo todo local) |
| 5 | Voz local e presença | não | M |
| 6 | Core unificado e refinamento (R10, R06, R16) | sim | 1 |

As Fases 2 e M podem andar em paralelo à Fase 1.

## 3. Fases

### Fase 0: fechar a fundação (pré-requisito de tudo)
- R07: tirar bancos, cookies e `src/data` do git (roteiro já pronto em `docs/ROTEIRO_DADOS_RUNTIME_GIT_R07.md`) e decidir sobre segredos já publicados no histórico.
- R08: supervisão com health check; o `YuiAtualizar` precisa rodar a suíte antes de aplicar, cobrir `apps/` e voltar a versão se algo falhar (hoje só olha se o processo ficou de pé 45 s).
- Brechas de permissão já conhecidas: `+yui` em DM de quem não é dono, `/yui-criador banir` sem proteger o dono, `/chat_updates` inexistente no aviso de ToS.
- YouTube sem timeout (travou cerca de 33 min na queda de rede de 10/11).
- **Feito quando:** push na `main` não consegue derrubar a produção nem sobrescrever dados dela, e as brechas acima têm teste.

### Fase 1: política de 4 estados (R01, R03, R02)
Já especificada em `docs/ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md`. Um motor `allow/ask/deny/observe` para todas as interfaces; terminal sem shell; aprovação por canal que só o dono controla (o Discord sozinho **não** é segundo fator: quem tem a conta passa pelos dois). Começar em modo observação (só registra).
- **Feito quando:** toda ferramenta com efeito passa pelo motor e há teste de negação.

### Fase M: migração para a máquina forte
- Decidir o hardware antes de comprar (ver §5). Medir tokens por segundo e RAM com 2 ou 3 modelos reais.
- Checklist: Windows em modo servidor (sem suspensão, religar após queda de energia na BIOS), tarefas `YuiBot`/`YuiWebApp`/`YuiAtualizar`, Tailscale, IP fixo, restauração do backup testada **antes** de desligar o notebook.
- Manter o notebook como reserva por uma semana.
- **Feito quando:** a Yui roda na máquina nova por 7 dias sem intervenção, com restauração de backup comprovada.

### Fase 2: rotina pessoal e proatividade
- Relatório matinal (agenda, pendências, saúde da máquina) e alertas por evento (disco, internet caída, tarefa parada).
- Calendário e e-mail **somente leitura** primeiro; escrever/enviar só depois da Fase 1, com aprovação.
- Listas e tarefas pessoais (a Porta L já existe) ganham lembretes.
- **Feito quando:** o relatório chega sozinho por 7 manhãs seguidas.

### Fase 3: IA local, RAG e memória v2 (R11)
- Provedor local (Ollama, LM Studio ou llama.cpp) no topo da cadeia do gateway, com modelo de contingência para ficar sem internet.
- Embeddings locais e busca por significado em notas, documentos e projetos; memória de pessoas e projetos (R11), com migração reversível e backup antes.
- **Feito quando:** a Yui responde e usa ferramentas com a internet desligada, e uma busca por significado acha um documento pelo assunto.

### Fase 4: Yui Dev, o agente de código (herda o Jarvis)
- Worker separado do bot: recebe uma tarefa, trabalha numa branch/worktree isolada, roda os testes e entrega um **pacote de revisão** (resumo, diff, resultado dos testes). Push só em branch, com token restrito; nunca na `main`.
- Motor plugável (candidatos já levantados: OpenCode, Goose; "motor 0" derivado de `src/core/dev`). O modelo vem por configuração: nuvem no começo, local depois da Fase 3.
- Interface: caixa de tarefas e revisão no app da Yui (`apps/yui-app`) e no Discord privado, **sem refazer um app Electron**.
- Tudo passa pela política da Fase 1: pasta liberada, lista de binários, tempo limite, aprovação para o destrutivo.
- **Feito quando:** uma tarefa pequena real (ex.: corrigir um teste) vira um pacote de revisão aprovado por você, sem tocar fora da branch.

### Fase 5: voz local e presença
- Palavra de ativação, detecção de fala, reconhecimento local, síntese local e interrupção por voz. Hoje só existe o TTS (SAPI, Edge, Azure) e a voz no Discord.
- Depende de GPU na máquina nova e de microfone e caixa de som no próprio computador.
- **Feito quando:** dizer "Yui" no ambiente aciona e responde em cerca de 2 s.

### Fase 6: core unificado e refinamento
- R10 (um pipeline só, atrás de flag), R06 (persistência), streaming e os débitos de `GAPS_E_DEBITOS_TECNICOS.md`. Entra quando a Fase 1 estiver estável; não bloqueia as demais.

## 4. Riscos principais
- **Injeção de prompt:** mensagens do Discord e páginas da web podem tentar mandar o agente executar algo. Por isso a Fase 4 só começa depois da Fase 1.
- **Piorar a Yui pública:** cada fase atrás de flag, com as suítes atuais passando; a Fase 6 é a mais arriscada.
- **Comprar hardware errado:** não comprar antes do teste de modelos da Fase M.

## 5. Decisões que dependem do dono
1. Hardware: orçamento, VRAM da placa (modelos úteis para código pedem 16 a 24 GB) e RAM.
2. O notebook fica como reserva ou é desligado?
3. Confirma o nível 4 (trabalho sozinho em segundo plano, entrega para revisão)?
4. **A pasta do Jarvis fica guardada, sem apagar nem mover (decisão de 10/11/2026).** Ela contém a "Yui 2" (esqueleto Electron + React + TypeScript, com contrato IPC e testes) e a "Yui Desktop", que podem servir de base para a interface da Fase 4 ou do R13 (Desktop). Se um dia for apagar, mova essas duas para fora antes.
5. Na pasta do Jarvis, o que mais vale: `SPEC` e `ARQUITETURA`, `Yui 2\docs\TESTE_MOTORES.md` e o contrato IPC tipado em `Yui 2\src\shared`. A bancada de testes (`D:\Bancada-Motores`) fica fora da pasta, mas também é só do Jarvis; decidir se mantém para a Fase 4.
