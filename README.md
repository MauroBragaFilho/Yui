# 🤖 GTA Online Updates

Bot Discord completo, autônomo e de alta performance para rastreamento de notícias do Rockstar Newswire e eventos diários/semanais do GTA Online.

Consulte a documentação completa do projeto e arquitetura em: [`.docs/README.md`](file:///d:/Projetos/Bot%20Discord/.docs/README.md)

---

## 🚀 Como Iniciar / Testar no Windows

Basta clicar duas vezes em [`start.bat`](file:///d:/Projetos/Bot%20Discord/start.bat) ou executar no terminal:

```cmd
start.bat
```

O menu interativo permitirá:
1. Iniciar o bot completo
2. Testar o motor do Newswire isoladamente (Puppeteer on-demand)
3. Testar o motor do GTA Online (resets e eventos)
4. Registrar os Slash Commands no Discord

---

## 🛠️ Comandos Disponíveis

- `/gta-setup` — Configura os canais de notícias, reset diário e semanal no servidor
- `/gta-daily` — Exibe o resumo do dia (Gun Van, Dealers, Shipwreck, Time Trials)
- `/gta-weekly` — Exibe o evento semanal (bônus, descontos, pódio)
- `/gta-news` — Exibe as últimas notícias da Rockstar
- `/status` — Telemetria de memória RAM, uptime e integridade do bot
