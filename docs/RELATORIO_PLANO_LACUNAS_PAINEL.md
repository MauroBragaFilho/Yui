# Relatório para a Liz: plano das lacunas do painel (entregas A a F)

Alice, 27/11/2026. Base: `origin/main` 5c7877f (o que está em produção). Tudo está **sem commit** no working tree de `D:\Projetos\Yui`. Nada foi publicado nem ligado. Documentos de apoio:
- [PLANO_LACUNAS_PAINEL.md](PLANO_LACUNAS_PAINEL.md): as 14 lacunas e a ordem;
- [LEVANTAMENTO_LACUNAS_PAINEL.md](LEVANTAMENTO_LACUNAS_PAINEL.md): o levantamento técnico;
- [DESENHO_PAINEL_APROVACAO_E_GOOGLE.md](DESENHO_PAINEL_APROVACAO_E_GOOGLE.md): o desenho de aprovar planos e reautorizar o Google.

## Decisões do Braga (26/11)

1. Realizar o plano por completo.
2. Planos: **ver e aprovar** pelo painel.
3. Configuração da IA do Discord: **gravar no mesmo cofre** do painel web.
4. Aba Código: **remover os restos**.
5. Google: **reautorizar também pelo painel**.

## O que mudou, por entrega

| Entrega | Itens | O que faz |
|---|---|---|
| A | 1, 2, 7 | Ferramenta desligada no servidor passa a valer em todos os caminhos (comandos de barra, prefixo, pré-rotas de GTA e lembretes); as 10 chaves que só estavam no `.env` entram no cofre; tela de Monitores (a API já existia) |
| B | 3 v1, 4 v1, 5 | Leituras só do dono: `GET /v1/admin/live`, `/google`, `/planos`, `/avisos`. Cartão da live no Início, Google e live em Integrações, aviso de vencimento do Google, tela Planos e avisos |
| C | 6 | Configuração da IA com fonte única no cofre: os 20 ajustes que se perdiam ao reiniciar e os que iam para um `config.json` nunca lido. O Discord grava pelo canal no cérebro, com a mesma validação |
| D | 8, 9 v1, 12 | Aba "Funções" por servidor (no lugar da aba Ferramentas); tela GTA (o que saiu e onde); telas de listas, skills e continuidade (esta com apagar e confirmação) |
| E | 3 v2, 4 v2, 9 v2, 10 | Aprovar e recusar planos pelo painel (a mesma `decidir()` da DM); entrar e sair da live (o mesmo `rotear()` da conversa); republicar o GTA no canal já configurado; rádio completo (iniciar sem ninguém na call, pular, fila, busca com escolha) |
| F | 11, 13, 14 | Imagem no Chat do app (gerada no bot e servida por link curto de 10 min); restos da aba Código removidos; reautorizar o Google pelo painel (fluxo do desenho, com o endereço colado de volta) |

## Chaves novas (todas desligadas ou com o comportamento de hoje)

| Chave | Padrão | O que libera |
|---|---|---|
| `YUI_PLANOS_PAINEL` | false (ligar pede confirmação) | botões Aprovar e Recusar no painel |
| `YUI_APP_IMAGEM` | false | gerar imagem no Chat do app |
| `YUI_GOOGLE_REAUTORIZAR_PAINEL` | false (ligar pede confirmação) | reautorizar o Google pelo painel |
| `YUI_IA_*` (mostrar modelo, retentativas, temperatura, tempo limite e tokens por provedor), `YUI_IA_CONTEXTO_DO_SERVIDOR`, `YUI_MUSICA_MANTER_CARTAO`, `YUI_CANAL_APELACOES`, `YUI_SALVAR_HISTORICO`, `YUI_AUTOMOD_PADRAO`, `YUI_AUTOMOD_MODO_PADRAO` | o valor atual do código | a configuração da IA e do servidor que antes ficava no Discord |

As 10 chaves levadas ao cofre (`GTA_WEEKLY_ENABLED`, `NEWSWIRE_ENABLED`, `REQUIRE_TOS`, `YUI_RESEARCH_ENABLED`, `YUI_MEMORY_ENABLED`, `YUI_LISTS_ENABLED`, `YUI_REMINDERS_ENABLED`, `YUI_VISION`, `YUI_AUTOMOD_AI_BAN`, `YUI_HEALTH_REPORT`) mantêm os padrões. Pedem confirmação:
- desligar a memória;
- desligar os Termos;
- o ban automático da IA em `auto`.

## Regras cumpridas em todas as entregas

- **Rotas:**
  - Toda rota nova é só do dono (403 para os outros).
  - As de escrita estão no `ROUTES` do `routeGuard` e na matriz de permissões.
  - As que vão ao bot (GTA, rádio) estão no `PANEL_ACTIONS`.
- **Auditoria:** sem conteúdo. Nunca sai a busca do rádio, o link da live, o texto do pedido de imagem nem os argumentos de plano.
- **Respostas:** nenhuma devolve token, segredo, código do Google, texto do chat da live, argumentos ou resultados de plano. Testes procuram isso no JSON.
- **Mutações:** cada entrega fez as suas (desfazer o conserto, ver o teste falhar, restaurar).
- **Fim de linha:** CRLF preservado em todos os arquivos tocados.
- **Segredos:** nenhum acesso ao `.env` de produção, ao `secrets/`, ao notebook ou a serviços reais. Exceção, relatada: um agente carregou módulos da raiz com `node -e`, e o `dotenv` leu o `.env` **deste PC** (de desenvolvimento) para a memória de um processo curto. O processo só imprimiu "ok". Nada foi mostrado, gravado ou enviado.

## Desvios do plano e do desenho (para o seu parecer)

1. **Planos aprovados vendo só o nome de cada ferramenta.** O desenho previa o mesmo texto da DM, mas esse texto traz os argumentos, que a entrega B garante que não saem do servidor. A confirmação avisa que os detalhes estão na DM. Os planos continuam só de leitura, com hash, versão e validade de 30 min.
2. **Reautorizar o Google é ação `SSDDD` com `modifies` na matriz.** Ela grava credencial, então em enforce o somente leitura nega até ao dono. Hoje a política está em observe, então funciona.
3. **A concessão parcial do Google grava o arquivo**, como faz o script, e a tela avisa o escopo que faltou. Sem nenhum dos dois escopos, nada é gravado.
4. **Quem tinha o Gmail perde o Gmail ao reautorizar pelo painel.** O painel nunca pede o Gmail, e a tela avisa.
5. **Apagar da continuidade e as ações de planos, live e Google não passam pelo `PANEL_ACTIONS`.** Vivem no cérebro, que é onde a API roda. Testes provam que nada vai ao bot.
6. **Limite de imagem duplicado.** A imagem pelo app conta o limite por hora separado do Discord (o dobro somando os dois) e não traduz o pedido para o inglês, para nenhum texto ir à IA sem o perfil privado.
7. **Semanal do Reddit republicado** sai na composição do `/gta-semanal`, sem a tradução da publicação automática.
8. **Ficou de fora:**
   - prompt do sistema, prefixo e nome, que esperam desenho próprio;
   - URLs dos provedores, só leitura no Discord;
   - ligar e desligar skills;
   - mexer nas listas pelo painel;
   - funções globais por servidor (pesquisa direta, persona).
9. **Os comandos do GTA passaram a obedecer ao interruptor.** Decisão do Braga em 27/11: com a função "GTA Online" (`gta_online`) desligada no servidor, o `/gta-diario`, o `/gta-semanal`, o `/gta-noticias` e o `+yui diario|semanal|noticias` recusam com a mesma frase da conversa. Na DM nada muda, e a publicação automática nos canais continua por canal. A função na aba Funções passou a se chamar "GTA Online" (antes "GTA Online pela conversa"). Testes em `test:ferramentadesligada` (22) e `test:interactionlimits` (seção 8), com mutação nos dois caminhos.

## Testes

- **App:** `tsc` sem erros, `npm run painel:build` recompilado, `npm test` 177/177 (de 89 para 177).
- **Suítes novas do servidor**, todas registradas no `package.json`, no `run-ci.mjs` e no `README_TESTES.md`:

  | Suíte | Testes |
  |---|---|
  | `test:ferramentadesligada` | 22 |
  | `test:painelleituras` | 20 |
  | `test:painelia` | 22 |
  | `test:painelgta` | 20 |
  | `test:paineltransparencia` | 15 |
  | `test:painelacoes` | 27 |
  | `test:painelrepublicar` | 22 |
  | `test:painelradio` | 21 |
  | `test:imagemapp` | 38 |
  | `test:painelgoogle` | 27 |

- **Suíte completa (`test:ci`):** ver a seção "Resultado da suíte completa" no fim.
- **Falhas que já existiam**, conferidas numa cópia limpa do 5c7877f:
  - `test:tts-ia`: 3 falhas;
  - `test:llmlimits`: trava na seção C;
  - `researchentries` e `modlist`: falhas antigas.

## Perguntas para você

1. Aprovar plano pelo painel vendo só o nome das ferramentas é aceitável, ou exige um texto sem argumentos montado por código?
2. Há requisito extra para a origem "painel" ao aprovar, como reautenticar ou exigir sessão nova?
3. O fluxo de colar o endereço do Google é aceitável, ou prefere um cliente "Aplicativo da Web" com retorno no `.ts.net`?
4. Pedir `openid email` só para mostrar qual conta autorizou?
5. O que precisa entrar no desenho do prompt do sistema, do prefixo e do nome pelo painel?

## Resultado da suíte completa

- **1ª rodada:** `npm run test:ci` com a trava de teste pesado, 119/122. As três falhas eram dos testes:
  - `test:painelia` e `test:imagemapp` subiam o canal de verdade, cujo `whoami` e `icacls` o bloqueio do CI barra. Corrigido como no `test:channel`: restrição falsa no teste. A restrição real continua coberta em `test:channel` e `test:separacao`.
  - `test:cobertura-bloqueio` exigia 4 ou mais arquivos em `tests/dev`. Saíram 2 com a aba Código e ficaram 3; o mínimo passou a 3.
- **2ª rodada:** `npm run test:ci` **122/122 suítes OK**, exit 0 (antes do item 9).
- **App:** `npm test` 177/177.
- **3ª rodada (estado final, 27/11, já com o item 9):** `npm run test:ci` **122/122 suítes OK**, exit 0.
- **Depois da decisão do item 9 (27/11), antes da 3ª rodada:** rodaram as suítes ligadas à mudança, todas OK:
  - `test:ferramentadesligada` 22, com mutação;
  - `test-interaction-limits` 61, com mutação;
  - `discord-guard`, `leftovers-final`, `permission-gaps`, `text-inputs`, `painelgta`, `painelrepublicar`, `gtao`, `embed-publish`, `clean-bootstrap` e `painel-config`.
  - App: `tsc` limpo, painel recompilado (carimbo 5d8475fd6f84), `npm test` 177/177.

## Parecer da Liz (27/11/2026)

Enviado pelo chat da Liz ("Parecer da Fase 1", projeto Yui no ChatGPT) a pedido do Braga. Parecer técnico **favorável com ressalvas**. Ela não autoriza a publicação em nome do Braga.

**Aprovado:** as entregas A a F (nenhuma descartada), os planos sem argumentos no navegador, a perda do Gmail, as ações fora do `PANEL_ACTIONS` (com autorização no próprio serviço), o semanal do Reddit, o adiamento do que ficou de fora e o item 9 (GTA).

**Pede mudança antes de publicar:**
1. **Planos (desvio 1, pergunta 1):** um resumo seguro montado por código no servidor, não só o nome das ferramentas. Para cada ação: o que faz, o serviço, o alvo, se lê, grava ou apaga, e os argumentos não sensíveis. Continua ligado ao hash, à versão e à validade.
2. **Operações críticas (desvio 2, pergunta 2):** confirmação reforçada da identidade (step-up) para aprovar pelo painel e para reautorizar o Google, sem criar senha nova. Ela também pede sessão válida e CSRF, e não aceita o modo observe como justificativa. A reautorização deve ser uma exceção explícita do somente leitura.
3. **Google (pergunta 3):** trocar o colar do endereço por retorno automático HTTPS (cliente "Aplicativo da Web"). O `.ts.net` precisa ser validado no Google; se não servir, um domínio próprio. Ela pede ainda Calendar e Tasks só leitura e o Gmail bloqueado no servidor, mesmo com credencial antiga, e só os escopos que o Google devolveu de fato.
4. **Imagem (desvio 6):** um limite só por pessoa, somando Discord e app.

**Sugestões:**
- `openid email` sim (pergunta 4), guardando o `sub`.
- Versionar o cofre para o painel e o Discord não sobrescreverem um ao outro.
- Conferir se outros limites contam separado por interface.
- Desenho próprio para o prompt, o prefixo e o nome (pergunta 5): regras de segurança fixas no código e a personalidade editável, com versões e restaurar.

**Próximo passo que ela propõe:** um complemento ao `PLANO_LACUNAS_PAINEL.md` com essas correções, sem commit, para o Braga aprovar.
