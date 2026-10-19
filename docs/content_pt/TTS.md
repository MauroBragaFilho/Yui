# 🔊 Yui falando na call (TTS): guia de configuração

Como fazer a Yui **responder falando** numa chamada de voz do Discord. Tudo roda no seu PC, sem rede e sem custo: ela usa a voz **Microsoft Maria (pt-BR)** que já vem no Windows. Não há nada para baixar.

> **Estado:** a fala já está ligada ao bot (`voiceHandler`, `llmHandler` e inicialização) e passou em todos os testes automáticos, que são offline e usam dublês. **Ainda não foi testada numa call de verdade.** Faça o primeiro teste num servidor seu, com o [checklist da Operação](OPERACAO.md#-11-checklist-da-fala-tts).
>
> Existe também um teste ponta a ponta **simulado** (`npm run test:tts-e2e`: voz Maria real do Windows, receptor de voz real do Discord, sem rede). Foi ele que achou, e já corrigiu, um defeito sério: a Yui respondia no chat mas nunca saía som (a fala procurava a conexão de voz num registro diferente do que o bot usa para entrar na call).

Variáveis completas: [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local). Música e rádio: [Rádio](RADIO.md).

---

## 📂 Sumário

1. [Resumo em 5 passos](#-1-resumo-em-5-passos)
2. [Conferir a voz do Windows](#-2-conferir-a-voz-do-windows)
3. [Ligar no servidor](#-3-ligar-no-servidor)
4. [Como usar na call](#-4-como-usar-na-call)
5. [Quando ela fala e quando não fala](#-5-quando-ela-fala-e-quando-não-fala)
6. [Configurações do `.env`](#-6-configurações-do-env)
7. [Ajustar a pronúncia](#-7-ajustar-a-pronúncia)
8. [Privacidade](#-8-privacidade)
9. [Problemas comuns](#-9-problemas-comuns)
10. [Uma voz melhor, no futuro](#-10-uma-voz-melhor-no-futuro)
11. [Testes](#-11-testes)

---

## ⚡ 1. Resumo em 5 passos

1. Confirme que o Windows tem a voz **Microsoft Maria Desktop (pt-BR)** ([passo 2](#-2-conferir-a-voz-do-windows)).
2. Ouça como ela soa: `npm run tts:amostra`. Ele gera arquivos WAV numa pasta temporária, mostra o caminho no fim e não mexe no Discord.
3. **Reinicie a Yui** (veja [Operação](OPERACAO.md#-3-iniciar-parar-e-reiniciar)). Até reiniciar, o interruptor novo nem aparece na lista de ferramentas.
4. No servidor, ligue **duas chaves** ([passo 3](#-3-ligar-no-servidor)): **🎙️ Assistente de Voz (Call)**, sem a qual o `/entrar-call` recusa, e **🔊 Resposta por Voz (TTS)**. A Yui nasce com as duas **desligadas** em todos os servidores. Quem liga precisa de *Gerenciar Servidor* ou *Gerenciar Canais*.
5. Entre numa call, use `/entrar-call` e fale: *"Yui, qual a capital da Austrália?"*

Se algo não funcionar, vá direto ao [passo 9](#-9-problemas-comuns).

---

## 🎙️ 2. Conferir a voz do Windows

No PowerShell:

```powershell
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '  |  ' + $_.VoiceInfo.Culture.Name }
```

Você deve ver uma linha como `Microsoft Maria Desktop  |  pt-BR`. Neste PC ela já existe (a `Microsoft Zira Desktop` é inglês e não serve).

**Se não aparecer nenhuma voz `pt-BR`:** Configurações do Windows → Hora e idioma → Idioma e região → *Português (Brasil)* → Opções de idioma → instale o recurso de **texto para fala** (não o de reconhecimento de fala). Reinicie a Yui depois.

**Atenção:** as "vozes naturais" do Narrador do Windows 11 **não** aparecem para esse recurso (são outro sistema). Só valem as vozes da lista acima.

Para escolher outra voz instalada, ou mudar a velocidade, use `YUI_TTS_SAPI_VOICE` e `YUI_TTS_SAPI_RATE` ([passo 6](#-6-configurações-do-env)).

---

**Testar as vozes sem usar a Yui:** dê duplo clique em `Testar Voz.bat` (ou rode `npm run tts:testar`) e abra http://127.0.0.1:4747. Escolha a voz, mova o tom e a velocidade, digite uma frase e ouça na hora; a página mostra as 3 linhas do `.env` para colar. Funciona só no seu PC (o texto digitado sai para a Microsoft, como na voz da nuvem).

## 🔌 3. Ligar no servidor

O TTS é um **interruptor por servidor, desligado por padrão**: todos na call ouvem a Yui, então um administrador precisa autorizar. Quem liga precisa de *Gerenciar Servidor* ou *Gerenciar Canais*.

**Jeito rápido: `/yui-ferramentas`.** Preencha os campos assim, uma ferramenta de cada vez:

| Campo | Valor |
|-------|-------|
| `acao` | **⚡ Alternar Tool (Ativar/Desativar)** |
| `ferramenta` | **🎙️ Assistente de Voz (Call)**, e depois **🔊 Resposta por Voz (TTS)** (digite "voz" para filtrar a lista) |
| `estado` | **✅ Ativar** |

**Jeito pelo painel:** `/yui-servidor` → botão **🔧 Ferramentas MCP** → escolha a ferramenta no menu → **🟢 Ativar Ferramenta**. A descrição da ferramenta aparece ali mesmo.

- **Conferir:** `/yui-ferramentas` com `acao` = **📜 Listar Status das Tools** mostra o que está em 🟢 Ativas e em 🔴 Desativadas.
- **Desligar:** o mesmo caminho com **❌ Desativar**. A fala em curso é **cortada na hora** (de qualquer lugar onde se desligue: `/yui-ferramentas`, o painel do servidor ou o do dono) e nada mais é falado.
- **Voltar ao padrão:** **🔄 Restaurar Padrão do Servidor** desliga as duas chaves, junto com o resto das ferramentas.

As duas chaves são **independentes**: o *Assistente de Voz (Call)* deixa a Yui entrar na call (`/entrar-call`) e atender "Yui, sai da call"; o *TTS* só decide se ela **responde falando**. Ligar o TTS não faz a Yui entrar sozinha.

**O que o 🔊 muda na conversa por voz.** Com o 🔊 **desligado** (o padrão) a conversa por voz continua **como era antes do TTS**: só texto, com as ferramentas, o histórico e o AutoMod de sempre. Com o 🔊 **ligado** (e o TTS ativo no bot) o servidor entra no **modo voz**: tudo o que está descrito abaixo (respostas curtas, sem ferramentas por voz, sem memória nem histórico, "Yui, para", limites de pedidos) passa a valer para **toda** conversa por voz desse servidor.

> Os comandos de barra **não mudaram**: você não precisa rodar `npm run deploy:commands`.

---

## 🗣️ 4. Como usar na call

1. Entre num canal de voz e rode `/entrar-call`. A Yui entra e avisa no chat de texto como falar com ela. Com o TTS ligado, o aviso também explica como interrompê-la.
2. Comece a frase com o nome dela e fale a pergunta: **"Yui, que dia é hoje?"**. A palavra de ativação precisa estar **nas 3 primeiras palavras**.
3. Ela transcreve o que você disse, pensa e responde **primeiro em texto no chat** (com a sua menção) e **em seguida em voz na call**. Normalmente em 1 a 3 frases curtas.
4. Se a resposta for longa (lista, código, link), ela fala só o essencial e diz que **o resto está no chat**.
5. Se o nome dela vier só **depois** das 3 primeiras palavras ("então, o que você acha, Yui?"), ela responde **só em texto** e **não fala**. Continua valendo o modo voz: sem ferramentas, sem memória, sem gravar nada, e os comandos "Yui, para" / "Yui, sai da call" não valem nesse caso.

**Interromper:**
- **Quem fez o pedido** pode **falar por cima** dela (cerca de 1 segundo de fala): ela para. O que você falou por cima é descartado, então **repita o pedido** depois que ela parar.
- **"Yui, para"** também funciona (e "chega", "silêncio", "cala a boca"), para qualquer pessoa, **desde que a fala não coincida com a voz da Yui**. Esta é uma limitação aceita: o áudio captado enquanto ela fala (mais 1,5 s depois) é descartado antes de ser transcrito, para ela não ouvir a si mesma. Por isso o "Yui, para" de **outra pessoa**, dito em cima da voz dela, não é entendido. Quem fez o pedido consegue calá-la falando por cima, e o administrador consegue desligando o interruptor.
- **Sair da call** (`/sair-call`, ou "Yui, sai da call" com o *Assistente de Voz* ligado e o nome dela abrindo a frase) também interrompe a fala.

---

## 🧭 5. Quando ela fala e quando não fala

**Fala quando** TODAS as condições valem:
- o **🔊 TTS** está ligado no servidor e a Yui está na call (conexão pronta), com permissão de **Falar** no canal;
- o pedido veio **por voz**, com a palavra de ativação nas 3 primeiras palavras;
- quem pediu é **humano** (bots, como o de música da call, são ignorados), não está banido e está **no mesmo canal de voz** que ela;
- o **Modo Rádio** não está ligado;
- a resposta ainda é recente (30 s) e nenhum limite abaixo foi estourado.

**Nunca fala:**
- respostas a mensagens de texto, comandos, DMs ou botões (o TTS é só para quem pediu **por voz**);
- enquanto o **Modo Rádio** está ativo (a música nunca é cortada nem coberta);
- mensagens de erro, avisos do sistema ou JSON de ferramenta;
- respostas com dados pessoais (e-mail, telefone, CPF, tokens...);
- conteúdo de conversa privada ou sensível;
- coisas que a pessoa mandou ela repetir ("repita depois de mim"): ela responde só *"Essa eu passo."* no chat, sem chamar a IA; também não fala uma resposta que repete quase igual o que a pessoa disse;
- resposta que contenha palavras da lista de bloqueio (apenas deixa de falar; **ninguém é banido** por isso);
- resposta que contenha o nome de ativação ou um parecido que a transcrição costuma gerar (como "Yui" ou "Ricardo"), para ela não se acionar sozinha pelo eco;
- texto que a voz não sabe ler (por exemplo, só japonês ou russo).

Quando ela deixa de falar, **o texto continua no chat**: só a fala é cortada.

**Por voz ela só conversa (no modo voz, com o 🔊 ligado).** Baixar música, buscar na web, gerar imagem e as outras ferramentas ficam **desligadas** por voz: se a IA tentar usar uma, nada é executado e a resposta vira *"Isso eu faço só pelo chat."* Se ela só **prometer** pesquisar ("Vou pesquisar isso!"), a promessa também não fica sem resposta: vira *"Por voz eu não pesquiso na web. Pede no chat de texto."* e nenhuma busca roda (com `YUI_VOICE_TOOLS=false`, o padrão, o [agente de pesquisa](ENVIRONMENT.md#-agente-de-pesquisa) não pesquisa por voz; no chat de texto ele pesquisa normalmente). A exceção é **"Yui, sai da call"**, um comando fixo (sem IA) que vale se o *Assistente de Voz (Call)* estiver ligado no servidor. `YUI_VOICE_TOOLS=true` libera as ferramentas por voz, mas leia antes o [passo 8](#-8-privacidade).

**Limites** (contra abuso e eco do microfone):
- **Antes da IA (no modo voz):** 1 pedido por pessoa a cada 6 s; no máximo 1 pedido por pessoa e 2 por servidor esperando a vez. O que passar disso é **ignorado**, sem resposta no chat (só aparece no log). Pedido que passa de 30 s na fila da IA é descartado, e a pessoa recebe um aviso curto (*"Demorei demais para responder e perdi o fio. Pode pedir de novo?"*), podendo repetir o pedido.
- **Na fala:** 1 fala a cada 6 s por pessoa, 5 por minuto por pessoa, 8 por minuto por servidor, 12 por minuto no total, fila de 3 por servidor e no máximo 120 s falados por servidor a cada 10 minutos.
- **Em cada resposta:** no máximo ~220 caracteres, 3 frases e 25 s.

---

## ⚙️ 6. Configurações do `.env`

**Você não precisa configurar nada** para o básico. Tudo abaixo é opcional. O `.env_example` tem todas as variáveis, já comentadas com o padrão: copie a linha para o seu `.env` e tire o `#`.

| Variável | Para que serve | Padrão |
|----------|----------------|--------|
| `YUI_TTS_ENABLED` | Chave mestra. `false` = nunca fala e nem sobe o processo da voz. Um valor que ela não reconhece (por exemplo `falso`) também desliga | `true` |
| `YUI_TTS_PROVIDERS` | Provedores de voz, em ordem. Hoje só existe `sapi`; `piper` e `edge` ainda não existem e são ignorados com um aviso no log | `sapi` |
| `YUI_TTS_SAPI_VOICE` | Nome (ou parte do nome) de outra voz instalada | primeira voz pt-BR |
| `YUI_TTS_SAPI_RATE` | Velocidade da fala, de `-10` (lenta) a `10` (rápida) | `0` |
| `YUI_TTS_MAX_CHARS` | Quanto ela fala por resposta, em caracteres (60 a 600) | `220` |
| `YUI_TTS_BARGE_IN` | `false` impede que falar por cima a interrompa (use se ela se cortar sozinha por eco) | `true` |
| `YUI_VOICE_TOOLS` | `true` libera ferramentas por voz (veja o passo 8) | `false` |
| `YUI_PERSONA_VOICE_FILE` | Arquivo com o estilo da resposta falada (passo 7) | `persona/yui-voz.md` |

Depois de editar o `.env`, **reinicie a Yui**. A lista completa (limites por minuto, tempo ocioso, prazos) está em [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local).

---

## 🔤 7. Ajustar a pronúncia

Siglas e nomes estranhos ficam no arquivo `src/services/tts/lexicon.pt-BR.json` (palavra → como falar). Exemplos já incluídos: `Yui` → "Iúi", `YouTube` → "Iútube". As pronúncias de "Yui" e de nomes de jogos são palpites: **ouça com `npm run tts:amostra`, ajuste do seu jeito e reinicie a Yui**. Escreva a pronúncia como se lê em português, sem dígitos nem símbolos.

A lista de palavras que a Yui **não fala** está em `src/services/tts/blocklist.pt-BR.json` (reinicie a Yui depois de editar). Ela só impede a fala; não bane ninguém.

O estilo da resposta falada (curta, sem Markdown, sem emoji) vem de `persona/yui-voz.md`. Pode editar à vontade: ela é relida sozinha quando o arquivo muda, **sem reiniciar**. Se o arquivo sumir ou ficar vazio, vale um texto de reserva embutido. O caminho de `YUI_PERSONA_VOICE_FILE` precisa estar dentro da pasta `persona/` e terminar em `.md` ou `.txt` (o conteúdo vai ao prompt de todo pedido de voz); qualquer outro caminho (outra pasta, `..`, caminho absoluto, arquivo oculto) é ignorado e volta ao arquivo padrão.

---

## 🔒 8. Privacidade

- A **voz sintetizada nunca sai do seu PC**: o Windows gera o áudio localmente. Nenhum áudio e nenhuma transcrição são gravados em disco: a transcrição de voz não vai ao `historico.txt` e o log guarda só tamanhos e IDs, nunca o que foi dito.
- **Atenção, a parte que não é local:** para entender o que as pessoas dizem, o áudio de **todos** na call é enviado a serviços de transcrição na nuvem (Groq, Wit.ai, Gemini, Hugging Face e OpenAI, conforme as chaves que estiverem no `.env`) **antes** de a Yui saber se falaram com ela. Só ficaria no PC se você usasse apenas um transcritor local (`LOCAL_STT_URL`). Isso já era assim na escuta por voz e é dito na mensagem de entrada da call. Avise quem frequenta a call.
- O que a pessoa diz vira texto e segue o mesmo caminho de uma mensagem do chat: vai ao provedor de IA em uso (que pode ser de nuvem) e a resposta fica **escrita no canal de texto**, visível a quem tem acesso a ele. Como a voz é conversa pública, se o provedor local falhar a cadeia pode cair nos provedores **gratuitos e anônimos** (Pollinations, AI Horde, Hugging Face), e o texto do pedido sai para eles; conversa privada nunca usa esses.
- No modo voz (🔊 ligado) a voz é sempre tratada como **conversa pública**: sem memória pessoal, sem histórico do chat de texto, sem contexto privado e sem gravar nada na memória nem no `historico.txt`. Vale para **todo** pedido por voz do servidor, até o em que o nome da Yui vem depois das 3 primeiras palavras. Com o 🔊 desligado a conversa por voz segue as regras de sempre do chat (o pedido e a resposta podem ir ao `historico.txt`, se ele estiver ligado).
- **A moderação continua valendo por voz.** Se a frase de alguém, ou a resposta, tiver uma palavra proibida, o aviso de segurança vai ao webhook de avisos do dono (se houver um configurado), com o trecho. No modo voz o AutoMod **por gatilho** (`trigger` ou `both`) **não bane sozinho** por uma frase transcrita: a transcrição erra, e um ban global por uma palavra mal ouvida seria injusto. O dono recebe só o aviso no webhook, com os botões de banir ou ignorar (decisão provisória; veja [Moderação](MODERATION.md#-2-hierarquia-do-automod-automated-blocking)). Com o 🔊 desligado vale a regra de sempre, e a frase transcrita pode banir.
- `YUI_VOICE_TOOLS=true` permite que **qualquer pessoa na call**, só falando, peça download, imagem etc. (a pesquisa na web por voz é recusada mesmo assim) A transcrição pode errar ou ser manipulada por quem estiver falando. Mantenha `false`, a menos que confie em todos na call. Com o 🔊 ligado e `false`, nenhum pedido por voz executa ferramenta, nem o em que o nome da Yui vem **depois** das 3 primeiras palavras. Com o 🔊 desligado a voz tem as ferramentas de sempre.
- **Voz da nuvem (`YUI_TTS_CLOUD=true`):** o texto que a Yui fala sai do seu PC para a Microsoft. Só vale para respostas NÃO sensíveis (na call tudo é conversa pública), e se a nuvem falhar ou passar do teto diário, a voz do Windows assume. Com `false`, nada sai do PC.

---

## 🛠️ 9. Problemas comuns

Os logs ficam em `logs/app-AAAA-MM-DD.log`. Para ver só o TTS:

```powershell
Select-String -Path logs\app-*.log -Pattern '\[TTS\]' | Select-Object -Last 30
```

Depois de reiniciar, o log deve ter `[TTS] Provedor "sapi": disponível` e `[TTS] Pronto: provedores=sapi, nuvem=desligada, ...`. A linha `/yui-status` "Voz falada (TTS)" também mostra se ela está ativa, quantas falas fez e quantas foram recusadas.

| Sintoma | Causa provável | O que fazer |
|---------|----------------|-------------|
| A Yui responde só em texto | Interruptor 🔊 desligado no servidor, ou a frase não começou com "Yui" | `/yui-ferramentas` → [passo 3](#-3-ligar-no-servidor); fale **"Yui, ..."** logo no começo |
| `/entrar-call` diz que as ferramentas de voz estão desativadas | O **🎙️ Assistente de Voz (Call)** está desligado no servidor | Ligue-o em `/yui-ferramentas` ([passo 3](#-3-ligar-no-servidor)) |
| Log: `[TTS] Desligado: o codificador Opus não está disponível` | Faltam `opusscript`/`@noble/ciphers` | `npm install` e reinicie; confira `npm ls opusscript` |
| Log: `[TTS] Desligado (YUI_TTS_ENABLED=false)` | Chave mestra desligada no `.env` | Tire a linha ou volte para `true` e reinicie |
| Log: `[TTS] Desligado: nenhum provedor de voz implementado ...` | `YUI_TTS_PROVIDERS` só tem nomes que ainda não existem | Use `sapi` (ou apague a linha) |
| Log: `[TTS] Provedor "sapi": indisponível` | Não é Windows, ou o `powershell.exe` não foi encontrado | A fala só funciona no Windows |
| Log: `[TTS][SAPI] helper não ficou pronto (SAPI_NOVOICE)` ou `Provedor "sapi" falhou (SAPI_NOVOICE)` | Sem voz pt-BR instalada, ou o nome em `YUI_TTS_SAPI_VOICE` não bate com nenhuma | [Passo 2](#-2-conferir-a-voz-do-windows) |
| Log: `[TTS] Disjuntor aberto para "sapi" por 60 s` | 3 falhas da voz em 2 minutos: ela fica 1 minuto só em texto e volta sozinha | Espere; se repetir, veja as linhas `[TTS]` anteriores |
| Log: `[TTS] Sem fala: ... motivo=...` | Uma regra barrou. Veja a tabela abaixo | Isso é normal, não é erro |
| Ela entra na call mas não ouve | Opus ausente ou escuta desligada por falhas seguidas | Veja o aviso no chat de texto e os logs `[VOICE]`; rode `/entrar-call` de novo para religar a escuta |
| Ela não fala e o log diz `motivo=no-speak-permission` | Sem permissão de **Falar** no canal, silenciada pelo servidor ou em palco sem permissão | Dê a permissão *Falar* à Yui no canal de voz |
| Ela não fala com o rádio ligado | De propósito: a música nunca é coberta | Encerre o Modo Rádio (botão **👋 Sair** do painel do rádio) e use `/entrar-call` de novo |
| Ela se corta sozinha | Eco: o microfone de alguém capta o som dela | Use fone, ou `YUI_TTS_BARGE_IN=false` |
| Fala atropelada ou demorada | PC ocupado (jogo aberto) | Espere; ou `YUI_TTS_SAPI_RATE=1` |
| Não responde nada, nem em texto | Pedido ignorado pelos limites do modo voz (1 a cada 6 s; 1 por pessoa na fila) | Espere um pouco e repita |
| Ela diz "Demorei demais para responder e perdi o fio" | O pedido ficou mais de 30 s esperando a vez na fila da IA | Peça de novo |
| Responde em texto, mas não fala | A palavra de ativação não estava nas 3 primeiras palavras, ou a transcrição errou o nome | Repita mais devagar: **"Yui, ..."** |
| Pronuncia errado | Palpite do léxico | [Passo 7](#-7-ajustar-a-pronúncia) |

**Motivos mais comuns em `[TTS] Sem fala: ... motivo=...`:**

| Motivo | Quer dizer |
|--------|------------|
| `guild-disabled` / `not-voice` / `tts-off` | Interruptor desligado, pedido que não veio por voz, ou TTS desligado (esses três só entram no log uma vez a cada 10 minutos) |
| `radio-active` | O Modo Rádio está ligado |
| `user-not-in-call` / `banned` / `bot-user` | Quem pediu saiu da call, está banido ou é bot |
| `no-connection` / `no-speak-permission` | A Yui não está na call, ou não pode falar no canal |
| `stale` | A resposta demorou mais de 30 s |
| `rate-user-gap`, `rate-user`, `rate-guild`, `rate-global`, `rate-budget`, `queue-full` | Algum limite do [passo 5](#-5-quando-ela-fala-e-quando-não-fala) |
| `pii` | A resposta tinha dado pessoal |
| `blocked-word` | A resposta tinha palavra da lista de bloqueio |
| `self-trigger` | A resposta continha o nome de ativação |
| `echo-of-input` | A resposta repetia o que a pessoa disse |
| `system-text` / `tool-json` / `json-text` | Era aviso do sistema, resposta de ferramenta ou um JSON/lista que vazou como resposta |
| `no-transcript` / `nothing-to-say` / `not-speakable` | Sem transcrição do pedido, ou nada legível sobrou para falar |

A linha `[TTS] Fala: ... ms_primeiro_som=... motivo=...` mostra o tempo do pedido até o primeiro som. `motivo=done` é o fim normal; os outros dizem por que parou (interrompida, desligada no meio, falha da voz...).

Se mesmo assim travar, desligue com `YUI_TTS_ENABLED=false` e reinicie: tudo volta a ser só texto, sem efeito colateral.

---

## ☁️ 9b. Azure Speech (oficial): como criar a chave

O Azure tem mais vozes pt-BR e **estilos** (alegre, amigável...). A faixa gratuita (F0) dá 500 mil caracteres por mês, mais que o suficiente. Passo a passo:

1. Crie uma conta em https://portal.azure.com (pede um cartão para validar a identidade; no plano F0 não há cobrança).
2. Procure **"Speech"** (Serviços de IA) e clique em **Criar**. Escolha assinatura, grupo de recursos novo, **região** (ex.: `Brazil South`) e o plano **Free F0**.
3. Quando terminar, abra o recurso e vá em **Chaves e Ponto de Extremidade**. Copie a **Chave 1** e o nome da **região** (em minúsculas e sem espaço: `brazilsouth`).
4. Cole no `.env`: `AZURE_SPEECH_KEY=...` e `AZURE_SPEECH_REGION=brazilsouth`. Nunca cole a chave em chat nem em comando.
5. Abra `Testar Voz.bat`, escolha o motor **Azure** e a página lista as vozes reais do seu recurso (com os estilos de cada uma). Ajuste, ouça e copie as linhas `YUI_TTS_AZURE_*` para o `.env`.
6. Reinicie a Yui. Com `YUI_TTS_CLOUD=true` e a chave, a ordem passa a ser Azure, Edge e voz do Windows (cada um assume se o anterior falhar).

> O Azure é oficial e estável (o Edge usa um acesso não oficial). O texto falado também sai do PC. Há um teto mensal (`YUI_TTS_AZURE_MAX_CHARS_PER_MONTH`, 450 mil) para não passar da faixa gratuita.

## 🚀 10. Uma voz melhor, no futuro

> ✅ **Já feito:** a voz neural da nuvem (Francisca/Thalita) está disponível com `YUI_TTS_CLOUD=true`; veja as variáveis `YUI_TTS_EDGE_*` em [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local). Ela usa um acesso não oficial da Microsoft, que pode mudar sem aviso (por isso a voz do Windows fica de reserva). O Piper continua como ideia futura.

A voz Maria é clara, mas **robótica**. Há duas melhorias previstas que **ainda não foram feitas** (e que exigem a sua aprovação, porque baixam arquivos grandes):

- **Piper** (voz neural local): ~100 a 250 MB de download. As vozes pt-BR dele são provavelmente **masculinas**, então precisa ouvir amostras antes de decidir. Rodaria como um processo local sem porta de rede.
- **Edge TTS** (nuvem, voz feminina natural): usa uma API não oficial da Microsoft; o texto falado sairia do PC. Ficaria desligado por padrão.

Hoje `piper` e `edge` em `YUI_TTS_PROVIDERS` são ignorados (com um aviso no log). Quando quiser testar uma delas, é só pedir.

---

## ✅ 11. Testes

```powershell
npm run test:tts
```

Roda as 7 suítes do TTS em sequência (cerca de 1 minuto): texto, áudio, motor, saída, ponta a ponta, integração com o bot (voz, inicialização e rádio) e o lado da IA (ferramentas bloqueadas por voz, persona e fila). Dá 974 verificações. Não usam rede nem o Discord; só a de áudio abre a voz do Windows por alguns segundos, sem tocar som.

Cada uma também roda sozinha: `npm run test:tts-text`, `test:tts-audio`, `test:tts-engine`, `test:tts-output`, `test:tts-pipeline`, `test:tts-integration` e `test:tts-ia`. A tabela do que cada uma cobre está em [README_TESTES.md](../../README_TESTES.md).

**Ponta a ponta (opcional, fora do `test:tts`):**

```powershell
npm run test:tts-e2e            # modo rápido: 13 cenários e a auditoria final, cerca de 3 minutos
npm run test:tts-e2e -- --full  # todos (48 cenários e a auditoria), cerca de 15 minutos
npm run test:tts-e2e -- S1 S8   # só os cenários indicados
```

Liga as peças **reais** sem o Discord: voz Maria do Windows falando como se fosse uma pessoa, receptor de voz real do `@discordjs/voice`, `voiceHandler`, fila da IA, `llmHandler`, serviço de TTS, `AudioPlayer` e conexão de voz reais (só o gateway do Discord, a rede, a IA e a transcrição são falsos). Roda em tempo real e confere o texto no chat, os pacotes de áudio enviados, os logs (sem texto de ninguém) e o isolamento (nada é escrito no projeto). Se o PC não tiver a voz pt-BR, ele se pula sozinho com saída 0.
