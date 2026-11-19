# Monitores de busca e alertas por evento

A Yui costuma agir quando alguém pede. Os **monitores** e os **alertas por evento** são os primeiros passos para ela avisar sozinha, dentro de limites bem fechados. Os dois nascem **desligados** (`YUI_MONITORES=false` e `YUI_ALERTAS_EVENTOS=false`) e, desligados, nada muda: não há laço, não há arquivo, não há rota ligada.

> Os monitores existem **só com o cérebro separado** (`YUI_CEREBRO_EXTERNO=true`, veja [Operação](OPERACAO.md)): o laço roda no processo do cérebro e o aviso sai pelo bot. No processo único eles não existem.
>
> Os monitores são buscas na web em nome do dono, então dependem de **três coisas ao mesmo tempo**: o dono autorizado (só ele pede), `YUI_MONITORES=true` e a **pesquisa privada liberada ao dono** (`YUI_PRIVATE_SEARCH` em `owner` ou `all`; é a mesma regra que a Yui usa para pesquisar em conversa privada, nenhum valor novo; `off` não libera). A liberação é relida **a cada pedido e a cada busca**, nunca guardada na subida. Veja [Privacidade do assunto](#privacidade-do-assunto-onde-ele-fica-e-para-onde-vai).

## 1. Os monitores: "me avisa quando..."

O **dono** pede em conversa, em português, por uma mensagem dirigida à Yui (DM, menção, o nome dela ou resposta a ela). Quem lê o pedido é o **código**, não o modelo de IA.

| Você diz | O que acontece |
|---|---|
| `me avisa quando sair o patch 1.5 do jogo X` | cria o monitor e confirma de volta, com o número, o prazo e uma linha fixa dizendo onde o assunto fica guardado e para onde vai |
| `me avisa se aparecer notícia de Y por 7 dias` | o mesmo, com prazo de 7 dias |
| `monitora as notícias do GTA 6`, `fica de olho no preço do Hades por 10 dias`, `cria um monitor para ...` | o mesmo |
| `meus monitores` / `lista meus monitores` | lista (número, consulta, estado, próxima checagem, até quando vale) |
| `cancela o monitor 2` | encerra o monitor 2 e **apaga o assunto** dele do arquivo |
| `pausa o monitor 3` / `retoma o monitor 3` | pausa e volta |

O prazo vem de `por 7 dias`, `durante 2 semanas`, `pelos próximos 10 dias`, `por um mês` ou `por 12 horas`. **Sem prazo, vale 14 dias; o máximo é 60 dias** (acima disso a Yui limita e avisa). Frases com horário de lembrete (`em 7 dias`, `daqui a 3 dias`, `amanhã`) continuam sendo **lembretes**: a pré-rota de lembretes vem antes e fica com elas.

### Limites

- No máximo **5 monitores ativos** (os pausados e os encerrados não contam; retomar também respeita o limite).
- A mesma consulta não vira dois monitores.
- Intervalo entre as checagens: **6 horas** por padrão e **no mínimo 60 minutos** (o pedido por conversa não muda o intervalo).
- Um monitor encerrado fica na lista por 7 dias e depois sai do arquivo.

### Como funciona

1. A cada `YUI_MONITORES_MS` (padrão 10 min) o cérebro olha quais monitores estão devidos.
2. Antes de cada busca ele confere que a pesquisa privada está liberada ao dono (lida naquele instante) e limpa a consulta de novo (dado pessoal e segredo; falha fechada). Só então busca pela **porta central de pesquisa** (a mesma da conversa: cota por hora e por mês, falha fechada, diário), como busca **privada** (sem cache, nunca compartilhada nem reaproveitada) e com uma identidade própria que não gasta a cota de ninguém. O que vai ao buscador é sempre a consulta já limpa.
3. Compara o **conjunto** dos endereços dos 5 primeiros resultados com o conjunto que o monitor **já viu**. De cada resultado só fica o **hash curto do endereço** (12 caracteres, depois de tirar `www.`, âncora e parâmetros de rastreio): nunca o endereço, nem o título. O conjunto guarda no máximo 60 hashes (os mais antigos saem primeiro). Os resultados mudarem de ordem, um deles sair do topo e voltar, ou o mesmo endereço trazer outro título **nunca é novidade**.
4. **A primeira checagem só guarda a referência (o conjunto) e nunca avisa.** Sem nenhum endereço novo, não avisa. Com **pelo menos um endereço novo**, manda **uma** mensagem privada ao dono: `Achei novidade sobre <consulta>: <título do 1º resultado novo> (<fonte>)`. A chave de entrega do aviso vem do hash dos endereços novos: a mesma novidade nunca sai duas vezes. (Um monitor criado por uma versão anterior, que só tinha o hash dos 3 primeiros resultados em ordem, refaz a referência na próxima checagem, sem avisar.)
5. O monitor que passou do prazo **encerra sozinho**, tem o assunto apagado e avisa **uma vez** (o aviso do fim diz só "monitor #N": o assunto já não existe). **Se há um aviso de novidade ainda aberto** (a entrega não terminou), o fim **espera**: primeiro sai a novidade, depois o fim; o aviso aberto nunca é sobrescrito. O monitor vencido que ainda tem aviso aberto não busca mais.
6. Um reinício do cérebro **retoma** de onde estava, sem repetir aviso e sem recuperar o assunto de um monitor encerrado.

**Pesquisa privada desligada depois de criado:** o monitor que já existe **não busca, não gasta cota e não envia a consulta a ninguém**. Ele fica **adiado** (nada é encerrado nem apagado; a lista avisa que os monitores estão suspensos) e volta **sozinho** quando a chave voltar. O **prazo continua correndo**: um monitor que vence enquanto a pesquisa está desligada encerra do mesmo jeito. Cancelar, pausar, retomar e listar continuam funcionando.

### O texto da web é dado, nunca instrução

Do 1º resultado só entram o **título** (limpo: uma linha, sem menção, sem link, sem formatação, no máximo 120 caracteres) e o **domínio**. O trecho do resultado e qualquer texto que pareça uma ordem nunca chegam a ninguém. **O texto dos resultados nunca é guardado**: o arquivo `monitores.json` tem o assunto que a pessoa pediu (já limpo) e, da busca, só hashes (o hash curto de cada endereço já visto e a assinatura da última busca), nunca endereço nem título.

O estado fica em `<DATABASE_DIR>/monitores.json`. O **dono é o cérebro**: só o processo do cérebro o abre e grava (o bot nunca), com gravação atômica (arquivo temporário e troca), no mesmo padrão do arquivo dos lembretes. Se o disco não aceitar a gravação, a mudança não vale: a Yui diz que não conseguiu anotar e nenhum aviso sai sem o registro no disco.

**Leitura que falha não apaga nada.** Só um arquivo que **não existe** (`ENOENT`) significa "nenhum monitor ainda". Um erro passageiro do disco ao **ler** (`EBUSY`, `EPERM`, `EACCES`: antivírus, indexador) repete a leitura algumas vezes; se persistir, o estado fica **indisponível**: nada é lido, criado, mudado nem apagado (**falha fechada**), o log recebe **um** aviso (com o código do erro, nunca o assunto), a passada dos monitores só espera e a conversa responde que não conseguiu abrir o arquivo agora (nunca "você não tem monitores"). Quando a leitura volta a funcionar, tudo segue de onde estava. Só um arquivo que foi **lido** e não é um JSON de estado (ou é grande demais) é "ilegível": a Yui recomeça vazia, como antes.

**O que sobra no disco além do arquivo.** A cópia de um arquivo ilegível (`monitores.json.corrompido`) sai com o campo do assunto **mascarado** (não guarda o texto puro), limitada a 64 KB e **some depois de 7 dias**. Temporários de gravação (`monitores.json.<pid>.tmp`, que guardam o assunto em texto puro) que ficaram para trás porque o processo caiu no meio da gravação são apagados ao carregar (os de menos de 10 minutos ficam: podem ser de uma gravação em curso).

### Privacidade do assunto: onde ele fica e para onde vai

- **Limpeza antes de gravar e antes de enviar.** O assunto passa pela **mesma limpeza da pesquisa privada** (dado pessoal como CPF, e-mail, telefone, cartão, senha e chave; palavras proibidas; links, menções e blocos de código saem). Ela vale **independente** da pesquisa privada estar liberada: com a chave liberada, um assunto com dado pessoal continua sendo recusado. É **falha fechada**: se a limpeza lançar um erro, bloquear ou não provar que o texto está limpo, o monitor **não é criado** e a Yui responde uma frase fixa pedindo para reformular sem dados pessoais (sem repetir o texto). A limpeza roda de novo antes de **cada** busca; um monitor cujo assunto não prove limpeza não busca, é encerrado e o texto é apagado. O que fica gravado e o que vai ao buscador é sempre a **mesma versão limpa**.
- **Texto puro enquanto o monitor está aberto.** O assunto limpo fica em **texto puro** em `monitores.json`, no disco do computador da Yui, enquanto o monitor estiver **ativo ou pausado**, e é enviado de tempos em tempos ao **serviço de busca** (por isso a pesquisa privada precisa estar liberada). A confirmação da criação diz exatamente isto, em uma linha fixa.
- **Apagado ao encerrar.** Cancelado, vencido ou encerrado por qualquer motivo, o assunto é **apagado do registro na mesma gravação**: do monitor encerrado sobram só o número, o estado, o motivo, a data e as contagens (que saem do arquivo depois de 7 dias). Um arquivo de uma versão anterior que ainda tenha o assunto de um monitor encerrado é limpo, e regravado, ao carregar.
- **Fora do backup, dos logs e da auditoria.** O arquivo `monitores.json` **não entra no backup** (que só leva os bancos de memória, os bancos extras e os arquivos de configuração listados no código). A auditoria e os logs guardam só o número do monitor, o estado e palavras fixas, nunca o assunto, nem o original nem o limpo.
- **Nenhuma IA.** Nenhum ponto dos monitores chama um modelo: o código só lê o pedido, busca, compara os hashes dos endereços e manda a mensagem. A busca é privada (sem cache, sem compartilhamento, sem reaproveitamento).
- **Texto livre (segunda camada, só dos monitores).** Além dos padrões da pesquisa privada (documentos, e-mail, telefone, cartão, chaves, `senha: x`), a limpeza dos monitores barra: senha com palavras no meio (`senha do wifi: x`, `a senha do banco é x`), `usuário: x` e `login = x`, endereço com rua e número (`rua das flores, 123`, `av brasil, nº 1500`), CEP (`78000-000`, `cep 78000000`), e frases como `meu endereço`, `meu bairro`, `moro na...`. Assuntos públicos continuam passando (`senha do wifi` sozinho, `rodovia BR 116`, `avenida paulista`, `minha casa minha vida`). O que já estava gravado é barrado antes da próxima busca (o monitor é encerrado e o assunto apagado).
- **Limites conhecidos (heurística, não garantia):** a limpeza **não** reconhece nome de pessoa, endereço sem rua e número em sequência (`brasil 1500`), senha escrita de um jeito que nenhuma regra imagine (letras separadas, outro idioma), nem dado pessoal em frase livre sem os sinais acima. Por isso o assunto deve ser um tema público, e a confirmação da criação repete isso.

### Cota de busca: a conversa nunca perde a vez

Os monitores têm uma **reserva própria** (`YUI_MONITORES_RESERVA`, padrão 10% do limite por hora): enquanto restar menos que isso, só a conversa busca. Cota cheia, limite por hora, cota mensal perto do fim ou a porta de saída fechada (sem o dono da cota ou sem o registro em disco) **adiam a passada sem custo e sem erro**: nada é gasto e o monitor continua devido. Uma busca que falha (rede, buscador fora) ou que volta **sem resultado nenhum** não muda a referência e nunca vira aviso. A nova tentativa tem **espera crescente**: 30 min na primeira falha, depois 60, 120, 240, 480 e 720 min (dobra a cada falha seguida, até o teto de 12 h, e nunca mais que 4 vezes o intervalo do monitor). Uma busca boa **zera a conta** e volta ao intervalo normal.

### Entrega do aviso: uma vez, sem se perder em silêncio

O aviso sai pelo mesmo caminho dos lembretes: uma DM do bot ao dono, com chave de idempotência por monitor e assinatura, estados (`pendente`, `enviando`, `enviado`, `incerto`) e reconciliação (nonce do Discord e histórico da DM). Se o bot cair no meio, o aviso fica `enviando` (visível na lista) e, na volta, a Yui confere se a mensagem saiu antes de mandar. Quando não dá para provar, o aviso fica `incerto` e **visível**; ela tenta confirmar a cada 10 minutos, **nunca reenvia às cegas**, e depois de 24 horas descarta com registro na auditoria. Depois de um reinício o aviso de novidade sai sem o título (o título nunca foi guardado): diz só que houve novidade. O aviso do fim não cita o assunto (ele é apagado ao encerrar).

### Segurança

- **Só o dono** cria, lista, pausa, retoma e cancela. Para qualquer outra pessoa a frase segue para a conversa de sempre, e nada é criado. Com **vários donos** (`OWNER_IDS`), os avisos saem só para o **dono principal** (o mesmo que recebe os avisos de erro: `YUI_PANEL_USER_ID`, `YUI_OWNER_ID`, `OWNER_ID` ou o primeiro de `OWNER_IDS`): um segundo dono que pede um monitor recebe uma frase fixa dizendo isso e nada é criado (o monitor dele nunca avisaria).
- **Só mensagem dirigida à Yui**: conversa espontânea, voz e pedidos em nome de terceiros não criam monitor.
- O que muda estado passa pelo **motor de políticas** (a mesma ação dos lembretes do painel). Em `observe` só registra; em `enforce`, o dono num canal público é tratado como membro e não cria (em conversa privada funciona).
- Criar exige também a **pesquisa privada liberada ao dono** e a **limpeza de dados pessoais** do assunto (veja acima); sem uma delas, nada é criado.
- A auditoria guarda o número do monitor e nunca a consulta; o log não recebe a consulta nem texto de resultado.
- A passada respeita o guarda das tarefas automáticas: `POLICY_JOB_AUTONOMY=DENY` pausa os monitores.

### O que os monitores NÃO fazem

- Não agem sozinhos além de **avisar**: não abrem páginas, não resumem, não respondem por ninguém.
- Não guardam resultados, páginas nem trechos.
- Não funcionam no processo único, nem para outras pessoas, nem por voz, nem pelo comando `/yui` (o pedido vale por mensagem).
- Não avisam na primeira checagem nem por causa do que mudou enquanto estavam pausados.
- Não fazem busca fora da cota central.

### Painel e API (só o dono)

| Rota | O que faz |
|---|---|
| `GET /v1/admin/monitores` | Lista: `id`, `consulta` (curta; `null` nos encerrados, que não guardam o assunto), `estado` (`ativo`, `pausado` ou `encerrado`), `proximaChecagem`, `ate`, `avisos` e, se há um aviso em andamento, `entrega` (`pendente`, `enviando` ou `incerto`). Também traz `resumo` (só contadores). Com a chave desligada, devolve `{ "ligado": false, "monitores": [] }` |
| `DELETE /v1/admin/monitores/:id` | Cancela o monitor (`404` se não existe, já está encerrado ou a chave está desligada). Fica na auditoria como `admin.monitor.remove`, sem a consulta |

Detalhes e o formato das respostas estão em [Yui API](YUI_API.md).

## 2. Alertas por evento

Verificações leves e periódicas, a cada `YUI_ALERTAS_EVENTOS_MS` (padrão 5 min), que avisam o **dono** com o mesmo mecanismo dos avisos de erro (`alertOwner`): mensagem curta, com o limite por hora que ele já tem. Nada novo vai para mais ninguém.

**Cada tipo de evento tem o seu intervalo de repetição**, porque a condição pode durar horas e o aviso não deve se repetir a cada conferência (5 min) nem a cada 30 min: **disco 12 h, memória 3 h, internet 2 h**. A **volta da internet** é um fato novo (outro aviso, com intervalo de 5 min). O aviso do **supervisor** não tem intervalo próprio (cada religada é um fato novo, contado pela diferença) e fica com o intervalo geral do `alertOwner` (`YUI_ALERTS_COOLDOWN_MINUTES`, 30 min). Os intervalos são fixos no código (não há chave para mudá-los), valem no próprio verificador e também no `alertOwner`, e recomeçam se o cérebro reinicia. Sem `YUI_ALERTAS_EVENTOS=true`, nada roda; com `YUI_ALERTS=false` (que desliga todos os avisos automáticos) a conferência roda, mas nenhuma mensagem sai.

| Evento | Quando avisa | Chave |
|---|---|---|
| **Disco** | o espaço livre onde ficam os dados fica abaixo do limite | `YUI_ALERTA_DISCO_GB` (padrão 5; `0` desliga) |
| **Memória** | a RAM livre fica abaixo do limite **por vários minutos seguidos** (um pico curto não avisa) | `YUI_ALERTA_RAM_MB` (padrão 400; `0` desliga) e `YUI_ALERTA_RAM_MIN` (padrão 5) |
| **Internet** | 3 sondas seguidas falham contra o alvo configurado (conexão TCP, sem enviar nada); quando volta, um segundo aviso curto | `YUI_ALERTA_INTERNET_ALVO` (`host` ou `host:porta`; **vazio desliga**, que é o padrão) |
| **Supervisor** | o supervisor religou o bot ou o cérebro (lê `logs/supervisor-estado.json` em modo só leitura; o aviso leva só o nome do processo e a contagem). **Um reinício controlado não é queda**: o pedido do dono pelo app e a parada limpa pelo `logs/supervisor.parar` (atualizador, watchdog) não geram o aviso. Na primeira leitura só vale o arquivo de um supervisor **vivo** (renovado nos últimos 3 min, em `rodando`) que descreve **este** cérebro (o pid confere), e uma saída que o próprio reinício controlado causou não conta como religada | — |

Em teste (`NODE_ENV=test`) um alvo de internet fora do próprio computador não é sondado.

## 3. Chaves

Todas estão em [Variáveis de ambiente](ENVIRONMENT.md): `YUI_MONITORES`, `YUI_MONITORES_MS`, `YUI_MONITORES_RESERVA`, `YUI_ALERTAS_EVENTOS`, `YUI_ALERTAS_EVENTOS_MS`, `YUI_ALERTA_DISCO_GB`, `YUI_ALERTA_RAM_MB`, `YUI_ALERTA_RAM_MIN` e `YUI_ALERTA_INTERNET_ALVO`. Os monitores também dependem de `YUI_PRIVATE_SEARCH` (`owner` ou `all`, que libera a pesquisa privada ao dono).

## 4. Testes

`npm run test:monitoresunidade` (o pedido, a assinatura e o conjunto de endereços, o estado, a pré-rota, a execução com o buscador e o relógio falsos, os alertas e a API) e `npm run test:monitores` (cérebro e bot de verdade, com Discord, IA e busca falsos). A descrição de cada suíte está no `README_TESTES.md`.
