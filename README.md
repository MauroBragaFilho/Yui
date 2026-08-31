# Atualização — Dados de Veículos e Armas (gta-v-data-dumps)

Integra o repositório [DurtyFree/gta-v-data-dumps](https://github.com/DurtyFree/gta-v-data-dumps)
ao `/yui-perguntar`, permitindo que a IA responda com dados técnicos reais
de veículos e armas do jogo (classe, fabricante, categoria, etc.) em vez
de depender só do conhecimento genérico de treinamento do modelo.

## Arquivos novos

- **`src/utils/vehicleData.js`** — baixa `vehicles.json` do dump, filtra
  só os campos relevantes (nome PT/EN, classe, fabricante, stats de
  handling) e salva em cache local (`src/data/vehicles.json`).
- **`src/utils/weaponData.js`** — baixa `weapons.json` do dump, filtra
  campos relevantes (nome PT, categoria, tipo de dano/munição) e salva em
  cache local (`src/data/weaponsDump.json`).

## Arquivos alterados

- **`src/discord/commands/ask.js`** — adiciona `buildVehicleWeaponContext()`,
  que extrai palavras/bigramas da pergunta do usuário, busca correspondências
  nos dois dumps e injeta os resultados no prompt da IA como "dados técnicos
  oficiais". Também troquei as referências "Gun Van"/"Street Dealers"/"Time
  Trials" no texto do contexto para os nomes já traduzidos usados no resto
  do bot (Van de Armas / Comerciantes / Desafios Contra o Relógio).
- **`src/index.js`** — chama `downloadVehicleData()` e `downloadWeaponData()`
  no bootstrap, logo após o `downloadTunables()` já existente. Falha em
  qualquer um dos dois não é fatal: o bot loga um aviso e segue normalmente
  (a funcionalidade de busca só fica indisponível até o cache ser baixado
  com sucesso, seja no próximo restart ou manualmente).

> Este pacote assume que você já aplicou a separação de bancos de dados
> combinada anteriormente (`core.db`, `newswire.db`, `gta-diario.db`,
> `gta-semanal.db`) — o `src/index.js` aqui já vem com essa parte incluída,
> então **substitua o arquivo inteiro**, não faça merge manual se você tiver
> feito outras edições nele.

## ✅ Conversão de velocidade — fórmula confirmada

O campo `MaxSpeed` do dump é o valor bruto do handling do jogo
(`fInitialDriveMaxFlatVel`). Pesquisei a fórmula oficial documentada pela
comunidade de modding (GTAMods Wiki — referência técnica padrão para o
`handling.meta` do GTA V):

> **km/h = MaxSpeed × 1.32**
> (fonte: https://gtamods.com/wiki/Handling.meta)

Esse é o valor teórico máximo do veículo em pista plana/reta, calculado
pela própria engine do jogo — pode divergir levemente do que aparece no
HUD em condições reais de estrada/tração/vento, mas é a fórmula correta
e documentada, não mais uma estimativa arbitrária.

O código em `ask.js` já usa esse fator (`v.maxSpeed * 1.32`), e o texto
enviado pra IA explica essa nuance (valor teórico em pista plana) sem
tratar como "chute" — porque agora não é mais um chute.

## Sobre o dump de armas

Confirmado na conversa anterior: `weapons.json` **não traz dano numérico,
alcance ou precisão** — essas informações ficam em `weaponinfo.meta`, que
não está neste repositório específico. Por isso `weaponData.js` só expõe
categoria, tipo de munição e tipo de dano. Se você quiser esses números
no futuro, vou precisar localizar outra fonte de dados pra isso.

## Onde colocar cada arquivo

```
src/utils/vehicleData.js                (NOVO)
src/utils/weaponData.js                 (NOVO)
src/discord/commands/ask.js             (SUBSTITUI)
src/index.js                            (SUBSTITUI — já inclui a separação de bancos)
```

## Passos após copiar os arquivos

```bash
npm start
```

Na primeira inicialização, os dois dumps serão baixados automaticamente
e salvos em `src/data/vehicles.json` e `src/data/weaponsDump.json`. Nas
próximas inicializações, o bot tenta baixar a versão mais atual, mas usa
o cache local como fallback caso o GitHub esteja indisponível.

## Testando

Depois de reiniciar o bot, teste com:

```
/yui-perguntar mensagem: qual a classe do Truffled Adder?
/yui-perguntar mensagem: me fala sobre a Carbine Rifle
```

Se a IA responder com dados específicos (classe, fabricante, categoria)
em vez de resposta genérica, a integração está funcionando.
