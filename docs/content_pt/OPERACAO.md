# 🛠️ Operação no dia a dia

Como a Yui roda hoje, como reiniciá-la, onde ficam os logs e os dados e o que fazer quando algo dá errado. Para instalar pela primeira vez, veja [Primeiros passos](GET_STARTED.md).

---

## 📂 Sumário

1. [Como a Yui roda](#-1-como-a-yui-roda)
2. [Portas e serviços](#-2-portas-e-serviços)
3. [Iniciar, parar e reiniciar](#-3-iniciar-parar-e-reiniciar)
4. [O `Yui.bat`](#-4-o-yuibat)
5. [Logs e auditoria](#-5-logs-e-auditoria)
6. [Dados e backups](#-6-dados-e-backups)
7. [Atualizar o código](#-7-atualizar-o-código)
8. [A VPS da AWS](#-8-a-vps-da-aws)
9. [Problemas comuns](#-9-problemas-comuns)
10. [Checklist de segurança](#-10-checklist-de-segurança)
11. [Checklist da fala (TTS)](#-11-checklist-da-fala-tts)

---

## 🖥️ 1. Como a Yui roda

Desde **03/11/2026** a Yui roda num **notebook servidor dedicado**, e não mais no PC do dono:

| Item | Como está (conferido por SSH em 10/11/2026) |
|------|---------------------------------------------|
| Máquina | ASUS X450LD (i7-4500U, 4 GB de RAM, HD), Windows 10 em português |
| Rede | Wi-Fi, com IP por **DHCP** (muda; em 10/11/2026 era `192.168.15.12`); também está na tailnet (Tailscale) |
| Acesso | SSH com chave, conta `Yui` (o shell padrão é o PowerShell) |
| Código | `C:\Yui`, **sem** pasta `.git`: lá não existe `git pull` (veja a [seção 7](#-7-atualizar-o-código)) |

Três tarefas do **Agendador de Tarefas do Windows** cuidam da Yui, todas como conta **SYSTEM**. As duas primeiras têm gatilho **na inicialização do sistema**: o notebook liga e a Yui sobe, sem ninguém precisar fazer login.

| Tarefa | O que executa | Quando |
|--------|---------------|--------|
| `YuiBot` | `node src/index.js` em `C:\Yui` (bot do Discord + Core + API + Gateway) | Na inicialização do sistema |
| `YuiWebApp` | `node scripts/serve-web.mjs` em `C:\Yui\apps\yui-app` (app web em `127.0.0.1:8081`) | Na inicialização do sistema |
| `YuiAtualizar` | `C:\Tools\atualizar-yui.ps1`: traz a versão nova do GitHub e volta a anterior se ela não subir ([seção 7](#-7-atualizar-o-código)) | Uma vez por dia, por volta das 04:00 (visto no `C:\Tools\atualizar-yui.log`) |

`YuiBot` e `YuiWebApp` rodam um PowerShell oculto com um laço (`while ($true) { node src/index.js; Start-Sleep 15 }`, e o equivalente com o `serve-web.mjs`) que religa o processo **15 segundos depois de qualquer saída**: erro, queda ou o **Reiniciar a Yui** do painel. Assim a Yui volta sozinha, sem precisar reiniciar o Windows. O instalador (`scripts/instalar-tudo-offline.ps1`) registra as duas com atraso de 45 s e 50 s depois do boot, para dar tempo ao Wi-Fi conectar.

**Outros serviços no mesmo notebook** (projetos separados; só aparecem aqui porque dividem a máquina, e os 4 GB de RAM, com a Yui):

| Tarefa | O que é |
|--------|---------|
| `OmniRoute` | Gateway de IA em `C:\OmniRoute`, porta `20128`; a Yui pode usá-lo como provedor próprio (há um atalho **OmniRoute** para cadastrá-lo em **Admin → IA**) |
| `BDSServer` | Servidor de arquivos (biblioteca de filmes e séries), porta `80`; é o que a Yui consulta na **Biblioteca por conversa** (`YUI_BDS_URL`; veja [Conversa e comandos](CONVERSA_E_COMANDOS.md)) |
| `NgrokMinecraft`, `MinecraftFabric` | Servidor de Minecraft e o túnel dele |
| `MinecraftServer`, `ModpackServer` | Manuais (não sobem sozinhas) |

**No PC de desenvolvimento** (o "Neon", onde fica `D:\Projetos\Yui` com o Git), as tarefas `YuiBot` e `YuiWebApp` continuam registradas, mas **desativadas**. Mantenha assim.

> ⚠️ **Nunca rode duas Yuis com o mesmo token do Discord** (notebook + PC, notebook + VPS, tarefa + `Yui.bat`...): ela responde **em dobro**. Para testar algo no PC com a produção no ar, use um bot de testes, com outro token, ou desative antes a `YuiBot` do notebook ([seção 3](#-3-iniciar-parar-e-reiniciar)).

Consequências práticas:

- A Yui **só responde com o notebook ligado e com Wi-Fi**. Não precisa de ninguém logado: as tarefas sobem no boot. Se o notebook desligar, ela volta sozinha quando ele for ligado de novo; se o Wi-Fi cair, ela reconecta ao Discord quando a rede volta (foi o que aconteceu na noite de 09 para 10/11/2026, com o Wi-Fi fora de ~23h41 a ~00h20).
- Deixe o notebook **na tomada**: o `scripts/instalar-ssh.ps1` desliga a suspensão, a hibernação e a ação de fechar a tampa só para quando ele está na tomada.
- As ferramentas que olham o computador (informações do PC, busca de arquivos, abrir projetos e a aba **Código**) agem **no notebook**, e não no PC de desenvolvimento. Se for usá-las, ajuste `YUI_PROJECTS` e `YUI_FILE_ROOTS` no `.env` do notebook (o instalador avisa quando ainda apontam para caminhos do PC antigo).

### 🩺 Watchdog: religa só a Yui travada (`scripts/supervisor-yui.ps1`)

O laço da tarefa `YuiBot` já religa o `node` quando o processo **morre**. O watchdog cobre o outro caso: a Yui **de pé mas travada**. A tarefa `YuiWatchdog` (SYSTEM) roda a cada 2 minutos e consulta `http://127.0.0.1:3939/v1/health`, que também informa `uptimeSeconds` e `discord.online`.

- **Quando religa:** a API não responde 3 vezes seguidas (cerca de 6 min), ou o Discord fica fora por mais de 10 min com a API de pé, ou a tarefa está rodando mas não há processo da Yui por vários minutos. Se a tarefa `YuiBot` nem está rodando e não há processo, ele só a inicia.
- **Como religa:** só pela tarefa do agendador (`Stop-ScheduledTask YuiBot`, espera o `node` sair, `Start-ScheduledTask YuiBot`). Nunca encerra processo por PID achado em varredura e **nunca inicia um segundo `node` por fora da tarefa**. Se o `node` antigo não sair, ele não inicia outro e registra o erro.
- **Quando não age:** durante a atualização (mutex `Global\YuiAtualizar`) e nos 5 minutos depois de a Yui subir. No máximo **3 religadas por hora**; passou disso, só registra.
- **Registro:** `C:\Tools\supervisor\supervisor.log` (linhas `RELIGADA: motivo`) e `estado.json`. O relatório diário de saúde mostra quantas religadas houve nas últimas 24 h e avisa se houve alguma.
- **Testar sem religar:** `powershell -ExecutionPolicy Bypass -File scripts/supervisor-yui.ps1 -DryRun`.
- **Diferença para o `yui-supervisor.ps1` abaixo:** aquele inicia o seu próprio `node` (por isso não pode rodar junto com a `YuiBot`); este só usa a tarefa existente.

### 🐕 Supervisor, Watchdog e Auto-Start no Windows (R08)

> **Não está instalado no notebook.** A produção usa o laço das tarefas acima. O `YuiSupervisor` **inicia o seu próprio** `node src/index.js`: instalado junto com a `YuiBot`, haveria duas Yuis com o mesmo token. Se um dia for usá-lo, é **no lugar** da `YuiBot` (desativada), lembrando que o instalador dele registra a tarefa **no logon do usuário**, e não no boot.

O script unificado `scripts/yui-supervisor.ps1` reúne watchdog ativo via `/v1/health`, auto-recuperação do Tailscale Serve e rotação de logs:

- **Monitoramento contínuo:** consulta `http://127.0.0.1:3939/v1/health` periodicamente (padrão a cada 15 segundos). Depois de 3 falhas seguidas (`-FailThreshold`), reinicia a Yui de forma controlada.
- **Proteção contra encerramento indevido:** o script NUNCA faz varredura de processos por PID solto. Ele guarda e encerra **exclusivamente o processo que ele mesmo iniciou** via arquivo de controle (`logs/yui-supervisor.pid`).
- **Garantia de Tailscale:** verifica se a publicação segura do Tailscale Serve está ativa na porta 3939 e a recria sem expor portas à internet (apenas Tailnet, sem funnel).
- **Rotação de logs:** ao iniciar, renomeia para `.bak` os `*.log` de `logs/` com mais de 10 MB.
- **Modo Dry-Run:** execute a qualquer momento com `-DryRun` para simular sem afetar nenhum processo:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/yui-supervisor.ps1 -DryRun
  ```

#### Instalação da Tarefa Agendada no Windows:
Para registrar ou remover a tarefa agendada oficial `YuiSupervisor`:
```powershell
# Simular instalação:
powershell -ExecutionPolicy Bypass -File scripts/instalar-supervisor-windows.ps1 -DryRun

# Instalar de fato:
powershell -ExecutionPolicy Bypass -File scripts/instalar-supervisor-windows.ps1

# Desinstalar se necessário:
powershell -ExecutionPolicy Bypass -File scripts/instalar-supervisor-windows.ps1 -Uninstall
```

---

## 🔌 2. Portas e serviços

Tudo escuta apenas em **`127.0.0.1`** (acessível só pela própria máquina; na produção, o notebook):

| Porta | Serviço | Ativação |
|-------|---------|----------|
| `3939` | **Yui API** | `YUI_API_ENABLED=true` |
| `8081` | **App web** (arquivos do `apps/yui-app/dist`) | tarefa `YuiWebApp` |
| `20130` | **Yui Gateway** (servidor de IA, compatível com OpenAI) | `YUI_GATEWAY_ENABLED=true` + `YUI_GATEWAY_KEYS` |

Acesso de outros aparelhos, **somente pela sua rede privada do Tailscale**. Os comandos rodam na máquina da Yui (hoje, o notebook, que já está na tailnet); confira com `tailscale serve status` o que está publicado antes de mudar:

```powershell
tailscale serve --bg --https=3939 http://127.0.0.1:3939     # publica a API em https://<máquina>.<tailnet>.ts.net:3939
tailscale serve status                                     # confere o que está publicado
tailscale serve --https=3939 off                           # desfaz
```

Para abrir o **app no celular**, publique também o app web (só na sua tailnet) e libere a origem na API:

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:8081     # app em https://<máquina>.<tailnet>.ts.net:8443
```

```env
YUI_API_CORS_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,https://<máquina>.<tailnet>.ts.net:8443
```

Na própria máquina da Yui, abra `http://localhost:8081`. O app usa o mesmo endereço em que a página foi aberta, na porta `3939`: abrir pelo **IP da rede local** (ex.: `192.168.x.x:8081`) não funciona, porque a API só escuta em `127.0.0.1`.

De outro computador da mesma rede, sem publicar nada, dá para usar um **túnel SSH** até o notebook e abrir `http://localhost:8081` no navegador do seu PC (as portas `8081` e `3939` precisam estar livres no PC, e `http://localhost:8081` precisa estar em `YUI_API_CORS_ORIGINS` no `.env` do notebook):

```powershell
ssh -L 8081:127.0.0.1:8081 -L 3939:127.0.0.1:3939 Yui@<ip-do-notebook>
```

Pelo túnel, os pedidos chegam à Yui por `127.0.0.1`, sem os cabeçalhos do Tailscale: ela os trata como vindos da própria máquina, então as aprovações da aba **Código** passam a valer por ele (diferente do celular pela tailnet).

Nunca use `tailscale funnel` (ele abre para a internet).

---

## ▶️ 3. Iniciar, parar e reiniciar

Na produção, tudo isto é feito **no notebook**, por SSH a partir de um computador da mesma rede local (o `instalar-ssh.ps1` libera a porta 22 só para a rede local):

```powershell
ssh Yui@192.168.15.12        # IP de 10/11/2026; ele muda (DHCP). Se não conectar, veja a seção 9
```

Já no PowerShell do notebook (a sessão SSH abre nele):

```powershell
Get-ScheduledTask -TaskName YuiBot,YuiWebApp,YuiAtualizar     # estado (Running / Ready / Disabled)
Invoke-RestMethod http://127.0.0.1:3939/v1/health             # a API responde? (só funciona na própria máquina)

# Reiniciar a Yui (carrega mudanças do .env ou do código)
Stop-ScheduledTask -TaskName YuiBot
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src.index.js' }   # deve voltar vazio
Start-ScheduledTask -TaskName YuiBot
```

O atualizador reinicia do mesmo jeito: para a tarefa, espera até 30 s o `node` da Yui sair e só então a inicia de novo. Se o processo ainda aparecer na lista depois disso, encerre **só ele** (o filtro pela linha de comando `src.index.js` não pega outros programas Node) e depois rode o `Start-ScheduledTask`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src.index.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Espere cerca de 30 segundos para a Yui logar no Discord e subir a API. O app web é igual, com a tarefa `YuiWebApp`.

Pelo app, o dono também pode usar **Admin → Geral → Reiniciar a Yui** (a saída é limpa e o laço da tarefa a religa em ~15 s).

Para **desligar** sem apagar as tarefas: `Stop-ScheduledTask -TaskName YuiBot` e depois `Disable-ScheduledTask -TaskName YuiBot` (para voltar: `Enable-ScheduledTask` e `Start-ScheduledTask`). Só parar não basta: ela volta no próximo boot, e o atualizador chama `Start-ScheduledTask YuiBot` sempre que aplica uma versão nova. Para remover de vez: `Unregister-ScheduledTask -TaskName YuiBot -Confirm:$false` (e o mesmo para `YuiWebApp`).

**Recriar as tarefas** (por exemplo, num notebook novo): o `scripts/instalar-tudo-offline.ps1` registra `YuiBot` e `YuiWebApp` ([Primeiros passos](GET_STARTED.md#-instalação-no-notebook-servidor-sem-internet)). A `YuiAtualizar` **não** é criada pelo instalador: registre-a à parte, rodando uma cópia de `scripts/atualizar-yui.ps1` guardada em `C:\Tools`. À mão, o que importa é: conta SYSTEM, gatilho "na inicialização do sistema" e `powershell -WindowStyle Hidden` rodando `while ($true) { node src/index.js; Start-Sleep 15 }` na pasta da Yui.

**No PC de desenvolvimento**, as mesmas tarefas existem **desativadas**: não as reative enquanto o notebook estiver no ar.

---

## 🪟 4. O `Yui.bat`

Menu para uso manual. O `yui.bat` **está versionado** no Git (a regra `*.bat` do `.gitignore` só vale para arquivos que ainda não estavam no repositório), então também chega ao notebook pelo atualizador.

| Opção | Função |
|-------|--------|
| `1` | **Iniciar a Yui** em uma janela: sobe o app web junto (se não estiver no ar) e **não duplica o bot da mesma máquina** |
| `2` / `3` | Testes isolados do Newswire e do GTAO Engine |
| `4` | Registrar/atualizar os slash commands |
| `5` | Conectar por SSH na **VPS da AWS** (endereço fixo no arquivo; não serve para o notebook) |

**Importante:** a opção `1` só enxerga a Yui **da mesma máquina**, procurando um `node` com `src/index.js` na linha de comando. No notebook, a instância da tarefa `YuiBot` roda como SYSTEM e, num console **sem** administrador, o Windows pode esconder a linha de comando de processos de outra conta, e aí a detecção falha: lá, **pare a tarefa antes** de usar a opção `1` (é também o jeito de rodar em janela e ver o console). **No PC de desenvolvimento ela não vê a Yui do notebook** e iniciaria uma segunda Yui com o mesmo token, que responderia **em dobro**: lá, só use a opção `1` com outro token ou com a `YuiBot` do notebook desativada.

---

## 📜 5. Logs e auditoria

Os caminhos são relativos à pasta da Yui: na produção, `C:\Yui\logs` no notebook (os logs do PC de desenvolvimento são outros).

| Arquivo | Conteúdo |
|---------|----------|
| `logs/app-AAAA-MM-DD.log` | Log da aplicação (inicialização, agendador, API, Gateway). Um por dia, guardados por 14 dias, até 10 MB cada |
| `logs/error-AAAA-MM-DD.log` | Só os erros (guardados por 30 dias) |
| `logs/core-audit.jsonl` | **Auditoria** do Core com hash encadeado (R04): cada evento possui `seq`, `prev_hash` e `hash` (SHA-256). Registra decisões, aprovador, comando exato/caminhos e metadados, sem jamais conter senhas, tokens ou dados de memória |
| `C:\Tools\atualizar-yui.log` (notebook) | O que o atualizador fez em cada execução ([seção 7](#-7-atualizar-o-código)) |

### 🔗 Auditoria com Hash Encadeado (R04)

- **Integridade verificável:** qualquer linha alterada, removida ou reordenada quebra a cadeia e é detectada por `verifyAudit()`.
- **Registro completo de aprovações:** aprovações no módulo Código registram o comando exato, caminhos, cwd e o aprovador (`approverId` e `approverRole`).
- **Resiliência:** falhas de escrita disparam alerta de erro ao dono (`alerts.js`). Linhas legadas continuam sendo lidas normalmente.
- **Rotação:** configurável via `YUI_AUDIT_MAX_BYTES` (padrão 10MB) e `YUI_AUDIT_MAX_ROTATE` (padrão 5 arquivos).
- **Verificação de integridade via comando:**
  ```powershell
  npm run test:audit
  ```

O que procurar quando investigar (no notebook, comece com `cd C:\Yui`):

```powershell
Get-Content logs\app-$(Get-Date -Format yyyy-MM-dd).log -Tail 50          # o fim do log de hoje
Select-String -Path logs\app-*.log -Pattern '\[error\]|\[warn\]' | Select -Last 20
Get-Content logs\core-audit.jsonl -Tail 30
Select-String -Path logs\app-*.log -Pattern '\[Pesquisa\]' | Select -Last 20   # agente de pesquisa: só metadados, nunca a pergunta
```

O agente de pesquisa escreve uma linha `[Pesquisa] tipo=... passos=... buscas=... paginas=... fontes=... ms=... provedor=... motivo=... privado=...` por pedido (nunca o texto da pergunta, da consulta ou da página) e linhas `[Pesquisa] guarda: acao=... motivo=...` quando troca uma promessa. Com `YUI_RESEARCH_GUARD=observe` elas viram `guarda (observe)` e `guarda final (observe)` e nada é trocado.

> 💡 No Windows, o tamanho e a data de modificação do log do dia (que a Yui mantém aberto) podem aparecer **desatualizados** no Explorer e no `Get-ChildItem`. Não conclua pelo tamanho que o log parou: leia o conteúdo (`Get-Content ... -Tail`, que abre o arquivo em modo compartilhado, enquanto a Yui continua escrevendo).

O painel mostra a auditoria em **Admin → Auditoria** e os logs da aplicação em **Admin → Logs** (com filtros por nível, texto e dia, e segredos mascarados). O caminho do arquivo pode ser trocado com `YUI_AUDIT_FILE`.

---

## 💾 6. Dados e backups

| Onde | O que guarda | Observação |
|------|--------------|------------|
| `.env` | Tokens, chaves, senhas | **Nunca** vai para o Git |
| `database/*.db` | Servidores configurados, publicações, resets, inscrições YouTube/Twitch, notícias | SQLite via `sql.js`, gravado a cada alteração de forma atômica (arquivo temporário na mesma pasta e depois rename: um processo morto no meio não deixa o `.db` ilegível). Sobras `*.db.<pid>.tmp` com mais de 5 minutos são apagadas na subida |
| `database/memory-personal.db` | Memória permanente do dono | **Privado**, ignorado pelo Git |
| `database/memory-discord.db` | Memória temporária dos usuários | **Privado**, ignorado pelo Git |
| `database/memory-context.db`, `database/memory-context-personal.db` | Contexto das conversas por horas (só existem com `YUI_CONTEXT_ENABLED=true`) | **Privado**, ignorados pelo Git (`database/memory-*.db`); as falas vencem sozinhas (6 h por padrão) |
| `secrets/search-budget.json` | Contador mensal de pesquisas da Brave e da Tavily | `secrets/` é ignorado pelo Git; apagar zera o contador |
| `src/data/*.json` | Configuração dos servidores (`server_settings`), TOS aceitos, banimentos (`bans.json`), ferramentas por servidor, rádio | Estado de runtime. Vários estão no Git, e no notebook o atualizador só preserva alguns ([seção 7](#-7-atualizar-o-código)) |
| `src/data/temp_audio`, `temp_videos`, `temp_spotify` | Uma subpasta por download, apagada depois do envio | Temporário e ignorado pelo Git; pode apagar o que sobrar com a Yui parada |
| `.venv-deemix/` | Ambiente Python do `deemix` (Deezer) | Ignorado pelo Git; recrie com `requirements-deemix.txt` (veja [Primeiros passos](GET_STARTED.md)) |
| `.venv-spotdl/` | Ambiente Python do `spotdl` (Spotify) | Ignorado pelo Git; recrie com `requirements-spotdl.txt` e o lock `requirements-spotdl.lock.txt` (veja [Primeiros passos](GET_STARTED.md#-spotify-opcional-ambiente-python-do-spotdl)) |
| `C:\Yui-backup\` (notebook) | Cópia de `src/`, `package.json` e `package-lock.json` feita pelo atualizador antes de cada versão nova | Só as 3 mais recentes; é o que ele usa para voltar a versão anterior. **Não** inclui o `.env` nem `database/`: não substitui o backup dos dados |

### 🔒 Backup e Restauração Cifrada da Memória (R05)

A memória da Yui (`memory-personal.db`, `memory-discord.db`, `memory-context*.db`) possui rotina de backup rotativo, cifrado com **XChaCha20-Poly1305** (AEAD) e verificação de integridade via hash SHA-256:

- **Chave de cifragem:** nunca fica no repositório. Configure via variável de ambiente `YUI_BACKUP_KEY` (string hex de 64 caracteres ou passphrase) ou `YUI_BACKUP_KEY_FILE` apontando para um arquivo fora do repositório.
- **Destino do backup:** configurável via `YUI_BACKUP_DIR` (padrão: `../yui-backups` fora do repositório).
- **Rotação:** retenção configurável via `YUI_BACKUP_MAX_KEEP` (padrão: últimos 7 backups).
- **Alerta de falha:** se o backup falhar, um alerta automático de erro é disparado ao dono (`alerts.js`).

#### Comandos de Backup e Restauração:

1. **Fazer backup agora:**
   ```powershell
   node scripts/backup-memory.mjs --dir "D:\Backups\Yui-Memory" --keep 7
   ```

2. **Restaurar um backup existente:**
   ```powershell
   node scripts/restore-memory.mjs --from "D:\Backups\Yui-Memory\backup-2026-11-05T04-33-26-042Z" --to "database"
   ```

3. **Rodar teste automatizado do ciclo completo de backup/restauração:**
   ```powershell
   npm run test:backup
   ```

#### Backup fora do notebook, num repositório privado do GitHub (`scripts/backup-offsite.mjs`)

Todo dia, depois da atualização das 04:00, a tarefa `YuiBackup` (SYSTEM) cifra os bancos e os envia para o repositório **privado** `MauroBragaFilho/Yui-backup`. Só vão arquivos cifrados; o texto em claro nunca sai do notebook. Entram: memória e contexto, `core.db`, os seguidos do YouTube e da Twitch, e de `src/data` os bloqueios, os servidores que aceitaram os Termos e as configurações por servidor. **Não entram** `.env`, tokens e chaves: se o notebook morrer, recrie-os.

- **Só envia se algo mudou** desde o último envio, e mantém os últimos 30 backups (`YUI_BACKUP_KEEP`).
- **Acesso:** uma *deploy key* do repositório (`C:\Tools\backup\yui_backup_deploy`), com escrita só nele. **Nunca** use o repositório público da Yui para isso.
- **Chave de cifra:** `C:\Tools\backup\backup.key` (64 caracteres hex). **Guarde uma cópia FORA do notebook** (gerenciador de senhas): sem ela o backup não abre, e só no notebook ela some junto com o disco.
- **Teste de restauração:** `node scripts/backup-offsite.mjs --verify` baixa o último backup, decifra e abre cada banco (`PRAGMA integrity_check`). Rode depois de criar a tarefa e de vez em quando.
- **Aviso:** o relatório diário de saúde mostra o último resultado (`C:\Tools\backup\backup.log`) e avisa se o backup falhou ou passou de 36 h.
- **Restaurar de verdade:** baixe o repositório num PC, rode `node scripts/restore-memory.mjs --from <pasta backup-...> --to <destino>` com `YUI_BACKUP_KEY_FILE` apontando para a sua cópia da chave, e copie os `.db` para `C:\Yui\database` e os `.json` para `C:\Yui\src\data` com a Yui parada.

**Backup manual recomendado** (copie para um disco externo ou nuvem pessoal, com a Yui parada ou não). Os dados que valem são os **da produção**: rode na pasta da Yui do notebook (`C:\Yui`) e leve a cópia para fora dele:

```powershell
$dest = "D:\Backups\Yui-$(Get-Date -Format yyyyMMdd)"   # troque por um destino fora do notebook
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item .env, database, src\data -Destination $dest -Recurse -Force
```

> ⚠️ Os bancos `core.db`, `gta-diario.db` etc. são **versionados** no Git (apenas os de memória são ignorados), mas os do Git são os do PC de desenvolvimento: o atualizador **não** copia `*.db` nem a pasta `database/`, então eles nunca sobrescrevem os da produção. Antes de um `git push`, confira com `git status` que nada sensível está indo junto (o repositório é público), e prefira não versionar dados de runtime.

---

## ⬆️ 7. Atualizar o código

**Na produção, atualizar = `commit` + `push` no branch `main` do GitHub.** O notebook não tem Git: a tarefa `YuiAtualizar` roda uma vez por dia o `C:\Tools\atualizar-yui.ps1` (cópia de `scripts/atualizar-yui.ps1`), que aplica sozinho o que estiver no `main`. Por isso, **rode os testes antes do push**: o que chega ao `main` vai para a produção na próxima execução.

O que o atualizador faz, em ordem:

1. Pergunta à API do GitHub qual é o último commit de `MauroBragaFilho/Yui` no `main` e compara com `C:\Yui\.versao-instalada`. Se for o mesmo, só anota "Sem novidades" no log e para. (Ele não usa senha nem token: o repositório precisa continuar público.)
2. Baixa o zip desse commit e confere que é a Yui (tem `package.json`).
3. Faz backup de `src/`, `package.json` e `package-lock.json` em `C:\Yui-backup\` (guarda os 3 mais recentes).
4. Copia a versão nova por cima de `C:\Yui`, **sem tocar** em: `.env`, `Yui.pem`, `database/`, `logs/`, `secrets/`, `node_modules/`, `.venv-deemix/`, `.venv-spotdl/`, `.git/`, `apps/`, nos arquivos `*.db` e em `bans.json`, `vehicles.json`, `tunables-decrypted.json`, `cache.json` e `reddit-cookies-cache.json`.
5. Se o `package-lock.json` mudou, roda `npm install`.
6. Reinicia a tarefa `YuiBot` (esperando antes a tarefa antiga sair de "Running") e espera até 4 minutos para o `node src/index.js` ficar de pé há pelo menos 60 s (no notebook o primeiro carregamento depois de trocar o código passa de 30 s). Se estiver, grava a versão nova em `.versao-instalada`. Se não, **volta** `src/` e os `package*.json` do backup, reinstala as dependências se for o caso, reinicia a Yui e **não** marca a versão (tenta de novo no dia seguinte).

Uma execução por vez (uma segunda sai com "Ja existe uma atualizacao em andamento"). Tudo vai para `C:\Tools\atualizar-yui.log`, com linhas como `Sem novidades (versao abc1234).`, `Atualizando de 'abc1234' para def5678...`, `OK: Yui rodando na versao def5678.`, `ERRO: a Yui nao ficou de pe. Voltando a versao anterior...`, `Rollback concluido...` e `FALHA: <motivo>`.

**Aplicar agora, sem esperar o dia seguinte** (por SSH, no notebook):

```powershell
Start-ScheduledTask -TaskName YuiAtualizar                                       # a mesma rotina diária, agora
powershell -ExecutionPolicy Bypass -File C:\Tools\atualizar-yui.ps1 -Forcar      # reaplica o main mesmo sem commit novo
Get-Content C:\Tools\atualizar-yui.log -Tail 20                                  # o que aconteceu
```

O que o atualizador **não** faz (continua manual no notebook):

- **Não atualiza o app web** (`apps/` fica de fora). Se o app mudou, gere o build no PC (`npm run web:build` em `apps\yui-app`) e copie a pasta `apps\yui-app\dist` para `C:\Yui\apps\yui-app\dist` (por exemplo com `scp -r`). O `serve-web.mjs` lê os arquivos a cada pedido, então basta atualizar o navegador.
- **Não reinstala os ambientes Python** (`.venv-deemix`, `.venv-spotdl`): se os `requirements-*.txt` mudaram, rode no notebook os comandos `pip` do bloco abaixo.
- **Não apaga** arquivos que saíram do repositório (ele copia por cima, sem espelhar).
- **Não se atualiza:** a tarefa roda a cópia em `C:\Tools`. Se `scripts/atualizar-yui.ps1` mudar, copie-o de novo para lá.
- **Confere só o processo**, não o Discord nem a API: depois de uma atualização, vale olhar o log da Yui e o `/v1/health`.

> ⚠️ Os arquivos de estado de `src/data/` que estão no Git e **não** estão na lista do passo 4 (por exemplo `server_settings.json`, `accepted_servers.json`, `server_tools.json`) **são sobrescritos** no notebook pela versão do GitHub sempre que forem diferentes. Evite mandar ao `main` mudanças nesses arquivos vindas do PC de desenvolvimento.

**No PC de desenvolvimento** (com Git), para testar localmente:

```powershell
git pull
npm install                         # se package.json mudou (inclui o Opus: opusscript e @noble/ciphers)
.venv-deemix\Scripts\python.exe -m pip install -r requirements-deemix.txt   # só se requirements-deemix.txt mudou
.venv-spotdl\Scripts\python.exe -m pip install --only-binary=:all: -c requirements-spotdl.lock.txt -r requirements-spotdl.txt   # só se os requirements do spotdl mudaram
cd apps\yui-app; npm install; npm run web:build; cd ..\..   # só se o app mudou
```

Lembre que rodar a Yui no PC com o mesmo token do notebook a faz responder em dobro ([seção 1](#-1-como-a-yui-roda)).

Se os slash commands mudaram, a Yui os registra sozinha na inicialização (globais podem levar até 1 hora para aparecerem; defina `DISCORD_GUILD_ID` para testes instantâneos em um servidor).

**Depois de reiniciar,** confira no log (`logs/app-*.log`) as linhas `[MediaTools]`: `yt-dlp`, `ffmpeg`, `Opus: OK`, criptografia de voz, DAVE, `Deemix` e `Spotdl` (`OK` ou `FALTANDO`; a falta de um deles não impede a Yui de subir). Se aparecer `Opus: AUSENTE`, rode `npm install` e reinicie; enquanto isso a Yui recusa `/entrar-call` e o Modo Rádio. Confira também as linhas `[TTS]`: `[TTS] Provedor "sapi": disponível` e `[TTS] Pronto: provedores=sapi, ...` (a fala por voz; veja o [guia de TTS](TTS.md)). `[TTS] Desligado: ...` explica o motivo e, nesse caso, a Yui segue só em texto.

**yt-dlp sozinho:** a Yui atualiza o `yt-dlp` em segundo plano, uma vez 30 segundos depois de iniciar e uma vez por dia a partir das 4h (`YTDLP_UPDATE_HOUR`). Falha de atualização vira só um aviso no log. `YTDLP_AUTO_UPDATE=false` desliga. Isso cobre só o `yt-dlp` da Yui: o `yt-dlp` que vem dentro do `.venv-spotdl` é independente e se atualiza à mão (`.venv-spotdl\Scripts\python.exe -m pip install -U "yt-dlp[default]"`; se algo quebrar, reinstale com o lock).

**Testes antes do push (e de reiniciar):** as suítes `test:*` rodam offline e com bancos temporários (veja [README_TESTES.md](../../README_TESTES.md)); não precisam parar a Yui nem conectar ao Discord, então rodam no PC de desenvolvimento.

---

## ☁️ 8. A VPS da AWS

A VPS **não é a produção**: a Yui roda no notebook ([seção 1](#-1-como-a-yui-roda)). Pelo último registro, feito quando o bot saiu de lá, o processo `yui` do PM2 na VPS ficou **parado** (`pm2 stop yui` + `pm2 save`, para não voltar no boot), mas a instância continuava ligada e custando, e ainda guardava um `.env` com tokens. **O estado atual da VPS não foi conferido** desde a mudança para o notebook.

- **A VPS não deve rodar o bot enquanto o notebook estiver no ar:** o mesmo token em duas máquinas faz a Yui responder em dobro.
- Para desativar de vez: apague o `.env` da VPS e encerre a instância no console da AWS.
- Para voltar temporariamente para a VPS: no notebook, **pare e desative** a `YuiBot` (`Stop-ScheduledTask` + `Disable-ScheduledTask`; só parar não basta, porque o boot e o atualizador a religam) e só então rode `pm2 start yui` na VPS. O atualizador só existe no notebook: o código da VPS só muda se você o atualizar lá.
- A VPS é uma `t3.micro` (1 GB de RAM, 6,7 GB de disco): pequena demais para Minecraft Java ou para o OmniRoute.
- O acesso SSH exige que o *security group* libere a porta 22 para o seu IP atual (o IP residencial muda). A opção `5` do `Yui.bat` conecta nela.

---

### Avisos automáticos

A Yui manda uma **mensagem privada** para o dono no Discord quando algo dá errado, sem você precisar olhar o painel:

| Aviso | Quando |
|-------|--------|
| 🚨 Todos os provedores de IA falharam | Nenhuma IA conseguiu responder (com o último erro) |
| ⚠️ Provedor parou de responder | Um provedor ficou em descanso longo (sem crédito, chave inválida, modelo removido) |
| 🚨 Erro grave / erro inesperado | Exceção não tratada ou promessa rejeitada no processo. A DM começa por `Origem na Yui: src/arquivo:linha` (o primeiro ponto do código da Yui na pilha) e a mesma causa gera **uma DM só**, seja exceção ou promessa rejeitada. Falha de rede numa conexão do Discord que a própria biblioteca já descartou (`Opening handshake has timed out`) **não** gera DM: vai só para o log como aviso, porque a Yui reconecta sozinha |
| ⚠️ Voz e rádio sem codificador Opus | Na inicialização, se o Opus não for encontrado (repete no máximo a cada 12 horas) |
| ⚠️ Falha no evento semanal, YouTube, Twitch ou limpeza de memória | Tarefas agendadas que falharam |
| 🚨 Login do painel / chaves por DM bloqueados | Várias tentativas erradas seguidas (possível invasão) |
| ℹ️ Estou no ar | A Yui iniciou (ou reiniciou). Reconexões do Discord, que são normais, ficam só no log |

Para não encher a sua caixa: cada tipo de aviso só se repete depois de 30 minutos (`YUI_ALERTS_COOLDOWN_MINUTES`) e há um teto de 10 por hora. O texto passa pelo filtro que mascara chaves e senhas. Desligue tudo com `YUI_ALERTS=false`. Se o Discord estiver fora do ar, o aviso naturalmente não chega; os logs continuam em **Admin → Logs**.

## 🩺 9. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---------|----------------|-------------|
| Yui offline no Discord | Notebook desligado, sem energia ou sem Wi-Fi; tarefa `YuiBot` parada ou desativada; ou a Yui caiu logo depois de uma atualização | Confira se o notebook está ligado e na rede. Por SSH: `Get-ScheduledTask YuiBot`, `Invoke-RestMethod http://127.0.0.1:3939/v1/health`, o fim de `C:\Yui\logs\app-*.log` e de `C:\Tools\atualizar-yui.log`. Ligar o notebook basta: as tarefas sobem sozinhas no boot, sem login |
| SSH não conecta (`Connection timed out`, `No route to host`) | O IP do notebook mudou (DHCP), o notebook está desligado ou você não está na mesma rede local (a porta 22 só aceita a rede local) | Descubra o IP novo na lista de aparelhos do roteador (ou com `ipconfig` no próprio notebook) e reserve um IP fixo para ele no roteador, como o `instalar-ssh.ps1` sugere |
| Mudança enviada ao GitHub não chegou à produção | A `YuiAtualizar` ainda não rodou, falhou (sem internet, GitHub fora) ou voltou a versão anterior porque a nova não subiu | Veja `C:\Tools\atualizar-yui.log` (`Sem novidades`, `FALHA:`, `Rollback concluido`); para aplicar já, `Start-ScheduledTask YuiAtualizar` ([seção 7](#-7-atualizar-o-código)). O app web nunca chega por esse caminho |
| Responde **em dobro** | Duas instâncias com o mesmo token: a Yui do PC de desenvolvimento ligada junto com a do notebook (tarefa reativada, `Yui.bat` ou `npm start`), a VPS ligada, ou `Yui.bat` aberto no notebook com a tarefa | Pare e desative a instância extra; a produção é só a do notebook |
| App: "Não foi possível conectar ao servidor" | Yui parada ou ainda iniciando (leva ~30 s), página aberta por um endereço não liberado (IP da rede local, ou origem fora de `YUI_API_CORS_ORIGINS`), celular sem Tailscale conectado, ou build apontando para outra porta | Confira a porta `3939` (`/v1/health`); gere o app de novo com `npm run web:build` e force a atualização do navegador (Ctrl+F5) |
| App: "Servidor não configurado neste app" | Build Android sem `EXPO_PUBLIC_YUI_SERVER_URL` | Gere o app com a variável (veja o [README do app](../../apps/yui-app/README.md)) |
| Chave por DM não chega | O Discord bloqueou DMs da Yui, ou ela está offline | Libere DMs de membros do servidor, ou entre por usuário e senha |
| Login bloqueado ("Muitas tentativas") | 5 erros seguidos | Espere 15 minutos; reiniciar a Yui também zera |
| `EADDRINUSE` / porta em uso | Outra instância ou serviço na mesma porta (no notebook, a `YuiBot` e um `Yui.bat` ou `npm start` ao mesmo tempo) | Veja quem usa a porta (`Get-NetTCPConnection -LocalPort 3939` mostra o processo dono) e pare a instância extra pelo caminho dela (tarefa ou janela), em vez de encerrar processos soltos |
| Gemini com erro 404 | Modelo aposentado no `.env` | Use `gemini-flash-lite-latest` / `gemini-flash-latest` |
| Hugging Face com erro 402 | Créditos esgotados | Esperado; o Gateway deixa o provedor descansando 30 min |
| `[Weekly] ... Could not find Chrome` | Navegador não encontrado | Instale o Chrome/Edge ou defina `REDDIT_BROWSER_PATH` |
| `falha ao persistir banco em disco` | Arquivo bloqueado por outro programa (antivírus, backup) | Pontual; os bancos continuam íntegros, confira com `PRAGMA integrity_check` |
| Slash command novo não aparece | Registro global demora | Aguarde até 1 hora, ou use `DISCORD_GUILD_ID` |
| DM "🚨 Erro grave na Yui: `Opening handshake has timed out`" (versões anteriores a 10/11/2026) | A internet do servidor caiu durante uma reconexão do Discord e um defeito da biblioteca `@discordjs/ws` deixou a conexão antiga sem tratador de erro | Nada a fazer: a Yui reconecta sozinha. Corrigido em `src/discord/gatewayGuard.js`; agora a falha aparece só no log como aviso `[Discord] ... conexão antiga ...`. Se aparecer muitas vezes, confira o Wi-Fi do servidor |
| "A voz e o Modo Rádio estão indisponíveis... codificador Opus" | `opusscript` não instalado (log: `[MediaTools] Opus: AUSENTE`) | `npm install` e reinicie a Yui |
| A Yui responde na call só em texto (não fala) | O interruptor **🔊 Resposta por Voz (TTS)** vem desligado em cada servidor, ou uma regra de fala barrou (rádio ligado, limite, dado pessoal...) | Veja os [problemas comuns do guia de TTS](TTS.md#-9-problemas-comuns) e a linha `[TTS] Sem fala: ... motivo=...` no log |
| Yui parou de ouvir a call ("escuta desligada") | 5 falhas seguidas na captura de voz de uma sessão | Veja o log (`[VOICE]`); `/entrar-call` de novo religa a escuta |
| Rádio parou sozinha com aviso no canal | Ambiente de áudio quebrado (Opus ou ffmpeg) ou 5 faixas seguidas sem tocar | Confira Opus/ffmpeg nos logs de inicialização e reinicie o Modo Rádio |
| Música veio com o aviso "a qualidade desta faixa pode ser menor que a original" | O `deemix` falhou (ARL vencido, Python sem os pacotes, tempo esgotado); a Yui usa o plano B. O aviso não diz a fonte; ela fica no log | Confira `DEEZER_ARL` e `PYTHON_PATH`, e a linha `deemix` do log (`pip install -r requirements-deemix.txt` no ambiente) |
| Faixa do Spotify não baixa | `spotdl` ausente (log: `[MediaTools] Spotdl: FALTANDO`; o `yt-dlp` não baixa áudio do Spotify), relógio do PC errado, pasta com nome começando em `.` ou terminando em `.`, `*` ou `$` no caminho de `src/data/temp_spotify`, ou o Spotify/a rede bloqueou (depois de 3 falhas seguidas os pedidos são recusados por 5 minutos) | Veja as linhas `[SpotifyHandler]` do log; sincronize a hora do Windows; instale o ambiente ([Primeiros passos](GET_STARTED.md#-spotify-opcional-ambiente-python-do-spotdl)); para ver o motivo, `YUI_SPOTDL_LOG_LEVEL=DEBUG` e reinicie |
| "O arquivo ficou maior que o limite de envio do Discord" | MP3 acima de 10 MB (`YUI_UPLOAD_LIMIT_MB`) que nem recomprimido a 96 kbps coube (faixa com mais de uns 13 minutos), ou `YUI_AUDIO_REENCODE=false` | Peça uma faixa mais curta. Se o servidor tem Boost, o limite dele é maior (50 ou 100 MB) |
| "Há muitos downloads acontecendo ao mesmo tempo" | Teto global de `YUI_DL_MAX_CONCURRENT` (3) downloads simultâneos atingido | Esperado; tente de novo em instantes ou aumente o teto (`0` desliga) |
| "Você já tem pedidos na fila, ou a fila está cheia" | `YUI_QUEUE_MAX_PER_USER` (2) ou `YUI_QUEUE_MAX` (30) atingido | Esperado; espere a resposta. Nas menções o aviso de recusa sai no máximo 1 vez a cada 30 s por pessoa |
| A Yui diz que não leu o anexo | Anexo que não é `.txt`, `.md` ou `.log`, maior que `YUI_ATTACH_TEXT_MAX_KB` (100 KB), binário, vazio, ou a leitura de anexos está desligada | Mande o texto em `.txt`/`.md`/`.log` menor ou cole na conversa; `YUI_READ_TEXT_ATTACHMENTS` liga e desliga |
| Pergunta do `/yui` recusada ("Texto grande demais") | Mais de `YUI_ASK_MAX_CHARS` (4000) caracteres | Mande o texto como mensagem normal mencionando a Yui, com um anexo `.txt` ou `.md` |
| "Esse conteúdo é longo demais para baixar" | Passou de `YUI_DL_MAX_MINUTES` (20) ou é transmissão ao vivo | Aumente o limite no `.env` (`0` desliga) ou use outro link |
| "O download demorou demais" | Passou de `YUI_DL_TIMEOUT_SECONDS` (300 s) | Tente um conteúdo menor ou aumente o tempo |
| Pesquisa na web não acontece | Conversa privada com `YUI_PRIVATE_SEARCH=off` (a Yui diz "Não pesquiso na web numa conversa privada."), voz, ferramenta `search_web` desligada no servidor ("A pesquisa na web está desativada neste servidor."), limite de 5 pesquisas por hora por pessoa ("Você já fez várias pesquisas na última hora..."), teto global de 20 por hora ("A pesquisa na web atingiu o limite desta hora (somando todo mundo)..."), ou todos os provedores descansando/sem cota ("Os buscadores estão com limite ou em descanso...") | Veja as linhas `[Pesquisa]` e `[Search]` do log e **Admin → Integrações**; ajuste `YUI_SEARCH_USER_PER_HOUR`, `YUI_SEARCH_GLOBAL_PER_HOUR`, `YUI_PRIVATE_SEARCH` ou as chaves. Cada pedido de pesquisa termina em resposta, resumo com links ou um destes motivos |
| Pedido de pesquisa na conversa privada recusado ("Tem dado pessoal ou segredo aí..." ou "Não consigo pesquisar isso...") | A mensagem tem e-mail, CPF, telefone, cartão, senha, token, IP, agência/conta, número de 9 ou mais dígitos, token de 32 ou mais caracteres, ou uma palavra proibida do AutoMod; vale para a consulta de qualquer pessoa | Esperado: peça para a pessoa reescrever sem isso. Nada saiu para o buscador |
| Na conversa privada a Yui explica que só pesquisa em pedido explícito | `YUI_PRIVATE_SEARCH` liberou a conversa privada, mas o pedido não foi explícito (promessa do modelo, pergunta solta ou assunto em outra mensagem) | Esperado: pedir assim, "pesquise o preço do PS5" (assunto na mesma mensagem) |
| A resposta de pesquisa veio como "resumo automático (sem IA)" com 1 a 3 links | A IA não respondeu a tempo, devolveu vazio, JSON ou outra promessa, ou o prazo de 60 s (`YUI_RESEARCH_DEADLINE_MS`) acabou | Esperado, e melhor que silêncio. Se acontecer sempre, veja a cadeia de provedores de IA em **Admin → IA** |
| "Desculpe, tive um erro ao fechar essa resposta. Pode perguntar de novo?" | A IA respondeu só com uma promessa ("Vou pesquisar isso!") e a guarda final a trocou. A promessa não é guardada no histórico | Pergunte de novo. Para ver quantas vezes acontece, use `YUI_RESEARCH_GUARD=observe` e procure `[Pesquisa] guarda` no log |
| Resposta longa veio como arquivo `.md` | Passou de 4 mensagens (`YUI_REPLY_MAX_PARTS`) ou de 20000 caracteres | Esperado; aumente o limite de partes se preferir mensagens, ou `YUI_REPLY_ATTACH_EXT=txt` para o texto cru |
| Resposta longa terminou com "Faltaram N caracteres" | O canal não deixa a Yui anexar arquivos (falta a permissão "Anexar arquivos"), então só as primeiras partes foram entregues | Dê a permissão à Yui no canal |

Painel de saúde: **Admin → Geral** (Discord, RAM, bloqueios) e **Admin → IA** (provedores de IA).

---

## ✅ 10. Checklist de segurança

- [ ] `.env` fora do Git e com backup em local seguro.
- [ ] Tokens do app **por dispositivo**; senha do painel como **hash** (`npm run panel:password`).
- [ ] API, app web e gateway **somente em `127.0.0.1`**; acesso externo só por `tailscale serve`, sem `funnel`.
- [ ] `YUI_READ_ONLY` ligado (padrão) e `YUI_APPS` vazio, a menos que você precise.
- [ ] Revisar `git status` antes de cada `push`; não versionar `.env`, `*.pem`, bancos de memória nem logs. Lembre que o repositório é público e que **todo push no `main` vai para a produção** pelo atualizador.
- [ ] **Uma Yui por token:** só a do notebook ligada; tarefas `YuiBot`/`YuiWebApp` do PC de desenvolvimento desativadas; VPS sem o bot rodando.
- [ ] SSH do notebook **só com chave** (`instalar-ssh.ps1 -PublicKey "..." -DesativarSenha`, depois de testar a chave) e porta 22 só para a rede local.
- [ ] VPS antiga sem o `.env` ou encerrada.
- [ ] Backup periódico de `database/` e `src/data/` **do notebook** (os do PC de desenvolvimento não são os de produção).
- [ ] `DEEZER_ARL` e chaves de busca só no `.env` (nunca em comando, chat ou log); chaves opcionais comentadas, sem texto-modelo.
- [ ] `YUI_CONTEXT_SCOPE=all` só depois de avisar nos Termos de Uso; `YUI_TTS_CLOUD` e `YUI_VOICE_TOOLS` mantidos em `false`, a menos que você precise.
- [ ] `YUI_PRIVATE_SEARCH` em `off` (padrão) ou `owner`. Em `all`, o pedido de pesquisa de qualquer pessoa em conversa privada (o `/yui` na DM de qualquer pessoa no Discord, já que mensagens comuns no privado só são respondidas para o dono, e o app/API de qualquer papel) sai para buscadores de terceiros (Tavily, Brave, DuckDuckGo, Bing); os Termos de Uso (`tosHandler.js`) não citam isso, então avalie antes. Em qualquer modo o log guarda só metadados da pesquisa.
- [ ] `apps/yui-app/logs/` fora do Git (`git rm --cached -r apps/yui-app/logs`, por sua conta, se ainda estiver rastreado).
- [ ] **🔊 Resposta por Voz (TTS)** ligado só nos servidores que você escolheu (todos na call ouvem a Yui, e o áudio da call vai a serviços de transcrição na nuvem). Veja o [guia de TTS](TTS.md#-8-privacidade).

---

## 🔊 11. Checklist da fala (TTS)

A fala da Yui na call passou em todos os testes automáticos, mas **nunca foi testada numa call de verdade**. Faça o primeiro teste num servidor seu, com a Yui no ar, e peça só coisas inofensivas (nada de "apagar" ou "formatar", e não peça para ela repetir frases suas). O guia completo está em [TTS](TTS.md).

**Antes (uma vez):**

- [ ] `npm run test:tts` passou (cerca de 1 minuto, offline; pode rodar com a Yui no ar).
- [ ] A voz do Windows está instalada **na máquina onde a Yui roda** (hoje, o notebook; [passo 2 do guia](TTS.md#-2-conferir-a-voz-do-windows)) e você ouviu `npm run tts:amostra` (ele gera arquivos WAV; rodando no notebook por SSH, copie-os para o PC para ouvir).
- [ ] Reiniciou a Yui ([seção 3](#-3-iniciar-parar-e-reiniciar)) e o log tem `[TTS] Provedor "sapi": disponível` e `[TTS] Pronto: provedores=sapi, ...`.
- [ ] No servidor de teste, ligou **🎙️ Assistente de Voz (Call)** e **🔊 Resposta por Voz (TTS)** em `/yui-ferramentas` e conferiu com *Listar Status das Tools*.

**Na call** (anote o que não bater; as linhas `[TTS]` e `[VOICE]` ficam em `logs/app-*.log`):

- [ ] `/entrar-call`: a Yui entra e avisa no chat como falar com ela. No log: `[VOICE] Conectada e pronta`.
- [ ] *"Yui, qual a capital da Austrália?"*: o texto aparece no chat e ela **fala**. Todos na call a ouvem desde a primeira fala (criptografia DAVE), com volume e clareza razoáveis. Confira a pronúncia de "Yui".
- [ ] Tempo de resposta: leia `ms_primeiro_som` na linha `[TTS] Fala:` do log. A meta é chegar ao primeiro som em até uns 8 segundos no caso comum.
- [ ] Falar por cima dela (quem fez o pedido): ela para. Repita o pedido depois.
- [ ] *"Yui, para"* dito **sem** ela estar falando: a IA não é chamada e o log mostra `Pedido de parada por voz`. (Dito por outra pessoa em cima da voz da Yui ele não é entendido: é a limitação aceita do [guia](TTS.md#-4-como-usar-na-call).)
- [ ] Eco, com **fone** e com **alto-falante**: ela não responde a si mesma nem se corta sozinha. Se se cortar, use `YUI_TTS_BARGE_IN=false`.
- [ ] Duas ou mais pessoas na call: só quem pediu a interrompe falando por cima; um bot de música na call é ignorado.
- [ ] Pedido de quem **não está na call** ou está banido: ela não fala (log `motivo=user-not-in-call` ou `banned`).
- [ ] Desligar **🔊 Resposta por Voz (TTS)** no meio de uma resposta de várias frases: a fala é cortada na hora (não termina nem a frase atual) e a fila de fala do servidor é descartada; o texto no chat continua.
- [ ] Pedir uma ferramenta por voz (por exemplo, *"Yui, baixa uma música"*): a resposta é *"Isso eu faço só pelo chat."* e nada é baixado.
- [ ] Modo Rádio ligado: ela não fala e a música segue intacta. Ligar o rádio no meio de uma fala corta a fala.
- [ ] `/sair-call` no meio de uma fala corta a fala; mover a Yui de canal ou derrubar a conexão não deixa a fala presa; canal sem permissão de *Falar* aparece no log como `motivo=no-speak-permission`.
- [ ] Recursos: o processo da voz (um `powershell.exe`, uns 130 a 150 MB) some sozinho depois de 10 minutos sem falar e ao reiniciar a Yui. No notebook (4 GB de RAM, divididos com os outros serviços), confira em **Admin → Geral** que a memória não fica no limite durante a fala.

Se algo der errado, desligue com `YUI_TTS_ENABLED=false` e reinicie: tudo volta a ser só texto. Depois do teste, atualize a pendência 16 em [Assistente pessoal](ASSISTENTE_PESSOAL.md#-pendências).
