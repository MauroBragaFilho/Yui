# Diagnóstico e Plano de Recuperação: Tarefas Agendadas da Yui

Este relatório investiga a situação das tarefas agendadas no sistema operacional (Windows Task Scheduler) e as tarefas periódicas internas da Yui (`src/scheduler/scheduler.js`), em atendimento à tarefa do Braga AI Hub.

---

## 1. Diagnóstico do Windows Task Scheduler

### Situação Atual:
Foram localizadas duas tarefas agendadas legadas no Agendador de Tarefas do Windows:
- **`YuiBot`**: `State = Disabled` (Desativada)
  - Executável: `powershell.exe -WindowStyle Hidden -Command "Set-Location 'D:\Projetos\Yui'; while ($true) { & node src/index.js; Start-Sleep -Seconds 15 }"`
- **`YuiWebApp`**: `State = Disabled` (Desativada)
  - Executável: `powershell.exe -WindowStyle Hidden -Command "Set-Location 'D:\Projetos\Yui\apps\yui-app'; while ($true) { & node scripts/serve-web.mjs; Start-Sleep -Seconds 15 }"`

### Por que estão desativadas?
1. **Intencionalidade no desenvolvimento:** Durante a realização de testes locais, depurações, execuções do painel de controle interativo (`Yui.bat`) e auditorias técnicas, manter um loop oculto reiniciando o bot em segundo plano a cada 15 segundos causava duplicação de processos, respostas duplicadas no Discord e concorrência sobre os bancos SQLite (`database/*.db`).
2. **Deficiências do modelo legado:**
   - Laço infinito cego sem verificação de saúde (`/v1/health`), prendendo o processo mesmo se ele estivesse travado sem responder à rede.
   - Sem registro de PID para desligamento limpo, exigindo matar processos arbitrariamente.
   - Sem verificação do Tailscale Serve.
3. **Decisão de migração de máquina:** Como informado pelo proprietário, a Yui será migrada para rodar em outro computador dedicado. Ativar o auto-start neste computador de desenvolvimento era contraproducente.

---

## 2. Diagnóstico do Agendador Interno da Aplicação (`src/scheduler/scheduler.js`)

Ao contrário das tarefas do sistema operacional, o **agendador interno da Yui via `node-cron` está totalmente ativo e funcional** quando o processo principal roda:
- **Resets diários do GTA Online:** Execução diária às 06:00 UTC (`0 6 * * *`).
- **Resets semanais do GTA Online:** Execução às quintas-feiras a cada 30 minutos entre 06:00 e 18:00 UTC (`*/30 6-18 * * 4`).
- **YouTube Engine:** Checagem periódica a cada N minutos (`YOUTUBE_INTERVAL_MINUTES`, padrão a cada 10 min).
- **Twitch Engine:** Checagem periódica (`TWITCH_INTERVAL_MINUTES`, padrão a cada 2 min).
- **Purge de Memória:** Limpeza diária de registros expirados da memória pública (`0 3 * * *`).

---

## 3. Plano Seguro de Reativação e Recuperação

Para a recuperação no ambiente de produção (novo computador dedicado ou reativação deliberada neste PC):

### A. Substituição do Modelo Legado pelo Supervisor R08
Não reativar as tarefas legadas `YuiBot` e `YuiWebApp`. Utilizar a solução moderna desenvolvida na Fase 0:
- O script unificado [`scripts/yui-supervisor.ps1`](file:///d:/Projetos/Yui/scripts/yui-supervisor.ps1) + [`scripts/instalar-supervisor-windows.ps1`](file:///d:/Projetos/Yui/scripts/instalar-supervisor-windows.ps1).
- **Vantagens do novo supervisor:**
  1. Monitora o endpoint de integridade HTTP `/v1/health` a cada 15s.
  2. Gerencia unicamente o processo sob sua custódia (via PID seguro).
  3. Garante a publicação HTTPS exclusiva da Tailnet via Tailscale Serve.
  4. Realiza rotação automática de logs grandes.

### B. Procedimento para Reativação pelo Proprietário
Quando aprovado, executar no PowerShell:
```powershell
# 1. Remover resquícios legados
Unregister-ScheduledTask -TaskName YuiBot -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName YuiWebApp -Confirm:$false -ErrorAction SilentlyContinue

# 2. Registrar o supervisor oficial moderno
powershell -ExecutionPolicy Bypass -File scripts/instalar-supervisor-windows.ps1
```

O sistema permanece no estado atual (desativado neste PC) até a aprovação e migração pelo proprietário.
