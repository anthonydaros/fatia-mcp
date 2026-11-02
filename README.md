# Fatia MCP

**Prepare suas peças para imprimir no Bambu Studio conversando com seu assistente de IA.**

O Fatia MCP conecta o assistente aos arquivos e às ferramentas de preparação de impressão 3D do seu computador. Você explica o que precisa; ele pode analisar uma peça, ajustar o tamanho, preparar um projeto, comparar opções e estimar material e custo.

**Você continua no controle da impressão:** o Fatia prepara os arquivos. Você confere o resultado no Bambu Studio e inicia a impressão por lá. Ele não se conecta à impressora.

[Instalar](#como-instalar) · [Exemplos de uso](#como-usar-no-chat) · [Ferramentas](#o-que-ele-consegue-fazer) · [Resolver problemas](#se-algo-não-funcionar)

## O que você precisa

- Um assistente com suporte a MCP, como Codex, Claude Desktop ou Claude Code. MCP é a conexão que permite ao assistente usar as ferramentas do Fatia.
- O **Bambu Studio instalado** para preparar o fatiamento e revisar a impressão. [Baixar no site da Bambu Lab](https://bambulab.com/en/download/studio).
- Saber o **modelo exato da sua impressora**, o diâmetro do bico e o tipo de mesa usados. Essas informações definem como o arquivo deve ser preparado.
- Um arquivo da peça. Os fluxos principais trabalham com **STL** e **3MF**. O STL guarda a forma; o 3MF também pode guardar configurações, cores e organização das mesas.

Para instalar pelo código-fonte, também é necessário ter Node.js 24, npm e Git. O Blender é opcional.

## Como instalar

<a id="set-up-with-your-agent"></a>

### Opção 1 — Peça ao próprio assistente

Copie o pedido abaixo no assistente em que você quer usar o Fatia:

```text
Instale o Fatia MCP neste assistente usando este repositório:
https://github.com/anthonydaros/fatia-mcp

Leia o guia de instalação:
https://github.com/anthonydaros/fatia-mcp/blob/main/docs/SETUP.md

Identifique meu sistema e encontre o Bambu Studio instalado.
Preserve os outros servidores MCP e as configurações que já tenho.
Pergunte o modelo exato da minha impressora e confirme bico e mesa
antes de fatiar. Não preciso informar IP, número de série nem código
de acesso da impressora.

Use o pacote MCPB oficial deste fork, se o aplicativo aceitar,
ou instale pelo código-fonte com Node.js 24.
Valide que o MCP inicia e lista as ferramentas. Consulte slicer_info
com check_updates false. Não fatie nem abra a interface como teste
de instalação. Avise se preciso reiniciar o assistente.
```

Quando solicitado, informe o modelo real da sua impressora. Não escolha um modelo parecido para contornar um erro.

### Opção 2 — Pacote para Claude Desktop

1. Abra a página de [versões publicadas](https://github.com/anthonydaros/fatia-mcp/releases).
2. Baixe o arquivo **`fatia-mcp.mcpb`** da versão escolhida.
3. Abra o pacote no Claude Desktop e siga as instruções de instalação.
4. Reinicie o aplicativo se as ferramentas não aparecerem.

Use os pacotes deste repositório. O pacote público chamado `bambu-printer-mcp` pertence a outra implementação.

<details>
<summary>Instalação manual pelo código-fonte</summary>

No terminal, com Git e Node.js 24 instalados:

```bash
git clone https://github.com/anthonydaros/fatia-mcp.git
cd fatia-mcp
npm ci
npm run build
```

Depois, configure seu aplicativo para iniciar o servidor com:

```bash
node /caminho/completo/fatia-mcp/dist/index.js --stdio
```

Substitua o caminho pelo local real da instalação. Em aplicativos que não encontram o Node automaticamente, use também o caminho completo do executável do Node.

A configuração varia entre os aplicativos. O [guia de instalação](./docs/SETUP.md) explica as variáveis, os caminhos e a configuração manual. O nome técnico do pacote é `@anthonydaros/fatia-mcp`; a distribuição deste fork usa GitHub Releases e código-fonte.

</details>

## Como usar no chat

Depois de instalar, basta começar o pedido com:

> **Use o Fatia MCP: ...**

Isso é um pedido ao assistente, não um comando `/fatia`. Você não precisa decorar os nomes das ferramentas.

Exemplos que você pode copiar e adaptar:

| Quero… | Pedido no chat |
|---|---|
| Preparar uma peça | “Use o Fatia MCP: prepare este STL para minha impressora. Confirme meu modelo, bico e mesa antes de fatiar.” |
| Entender um problema | “Use o Fatia MCP: por que essa peça pode descolar da mesa? Explique o que você conseguiu verificar.” |
| Conferir um arquivo baixado | “Use o Fatia MCP: analise este 3MF antes de eu imprimir e mostre o que precisa de revisão.” |
| Comparar impressoras | “Use o Fatia MCP: compare este 3MF na A1 e na X2D, mantendo a qualidade configurada. Mostre tempo, material e custo estimados; meu filamento custa R$ 100/kg.” |
| Comparar posições | “Use o Fatia MCP: compare esta peça deitada e em pé. Mostre tempo, material e suportes estimados.” |
| Encontrar desperdício | “Use o Fatia MCP: analise este arquivo já fatiado e explique quanto material foi para suportes, torre e purga, quando for possível medir.” |
| Conferir o rolo | “Use o Fatia MCP: tenho 120 g disponíveis no rolo do slot 1. Isso basta para duas cópias deste projeto?” |
| Testar encaixes | “Use o Fatia MCP: crie pares de teste com folgas radiais de 0,1, 0,2 e 0,3 mm. Explique como conferir o encaixe.” |
| Preparar uma calibração | “Use o Fatia MCP: a partir deste projeto, crie testes de fluxo com valores 0,94, 0,98 e 1,02.” |
| Conferir a malha | “Use o Fatia MCP: procure bordas abertas, faces duplicadas e outros problemas na malha deste arquivo.” |
| Estimar custo | “Use o Fatia MCP: estime o custo deste projeto fatiado. Meu filamento custa R$ 100 por quilo.” |

Anexe o arquivo ou informe o caminho completo no computador em que o servidor roda. Se o assistente não tiver acesso ao arquivo, ele precisará de uma cópia acessível nesse computador.

Ao terminar a preparação:

1. Leia o resumo e as limitações encontradas.
2. Abra o projeto gerado no Bambu Studio.
3. Confira modelo da impressora, bico, mesa, material, cores, posição e prévia do fatiamento.
4. Inicie a impressão no Bambu Studio quando estiver satisfeito com a revisão.

## O que ele consegue fazer

- **Analisar antes de imprimir:** conferir configurações, dimensões, regras de preparação e problemas de topologia da malha.
- **Editar peças:** redimensionar, girar, centralizar, apoiar uma face na mesa e extrair objetos de um 3MF.
- **Preparar projetos:** fatiar com o Bambu Studio, comparar ajustes e organizar mesas. Fatiar significa calcular as camadas e os movimentos previstos para imprimir.
- **Comparar alternativas:** mostrar estimativas para duas impressoras, diferentes configurações ou orientações e salvar projetos separados para você revisar.
- **Planejar material e custo:** consultar consumo registrado no arquivo fatiado, comparar com o estoque que você informar e calcular custos com seus preços.
- **Criar testes:** gerar peças de encaixe e projetos de calibração para fluxo, temperatura e retração.
- **Usar o Blender, se configurado:** encaminhar operações de edição para uma conexão separada com o Blender.

O código atual oferece **32 ferramentas**. Uma versão publicada anteriormente pode ter menos; peça ao assistente para listar as ferramentas da sua instalação.

<details>
<summary>Ver os nomes das 32 ferramentas e suas funções</summary>

### Preparação e orientação de uso

| Ferramenta | Para que serve |
|---|---|
| `prepare_print_project` | Prepara um novo projeto, compara rodadas de ajustes e entrega um resumo para revisão. |
| `preflight_check` | Faz verificações antes de fatiar e explica problemas, evidências e próximos passos. |
| `consult_knowledge` | Consulta a base de conhecimento de impressão incluída no Fatia. |
| `slicer_info` | Mostra informações da instalação do Bambu Studio. |
| `open_in_slicer` | Abre um arquivo no Bambu Studio para você revisar. |

### Fatiamento e configurações

| Ferramenta | Para que serve |
|---|---|
| `slice_stl` | Fatia um modelo com a instalação local do slicer. |
| `slice_with_template` | Fatia usando configurações de um modelo salvo. |
| `get_slice_settings` | Lê configurações de um projeto ou perfil. |
| `list_slicer_profiles` | Lista perfis instalados de impressora, material e processo. |
| `list_templates` | Lista modelos de configuração salvos. |
| `save_template` | Salva um modelo de configuração sem substituir um arquivo existente. |

### Comparações, consumo e custo

| Ferramenta | Para que serve |
|---|---|
| `list_3mf_plate_objects` | Lista os objetos de uma mesa do projeto. |
| `compare_projects` | Compara dois projetos 3MF e mostra diferenças. |
| `compare_slice_scenarios` | Compara até seis opções de configurações por fatiamento. |
| `compare_print_orientations` | Compara até seis rotações da instância selecionada em um 3MF compatível, inclusive com várias peças e mesas. |
| `analyze_print_waste` | Analisa o material por função no G-code de uma mesa. Valores de purga ambíguos permanecem desconhecidos. |
| `estimate_print_cost` | Estima custo com base no consumo registrado e nos preços informados. |
| `check_filament_availability` | Compara o consumo por slot com as gramas disponíveis que você informar. |

### Geometria e testes

| Ferramenta | Para que serve |
|---|---|
| `get_stl_info` | Mostra informações básicas do modelo. |
| `scale_stl` | Altera o tamanho da peça. |
| `rotate_stl` | Gira a peça. |
| `extend_stl_base` | Acrescenta uma base retangular sob o modelo. A união precisa de revisão. |
| `merge_vertices` | Une vértices muito próximos, conforme a tolerância escolhida. |
| `center_model` | Centraliza o modelo. |
| `lay_flat` | Busca uma face plana adequada para apoiar na mesa. |
| `extract_3mf_objects` | Exporta objetos imprimíveis de um 3MF como arquivos STL separados. |
| `create_fit_test` | Gera pares de pino e furo para testar folgas de encaixe. |
| `create_calibration_project` | Gera projetos separados para testar fluxo, temperatura ou retração. |
| `analyze_mesh_health` | Analisa bordas, orientação das faces, duplicações e componentes da malha. |

### Conexão opcional com Blender

| Ferramenta | Para que serve |
|---|---|
| `blender_mcp_status` | Verifica a conexão configurada com o Blender MCP. |
| `blender_mcp_call` | Encaminha uma chamada para uma ferramenta dessa conexão. |
| `blender_mcp_edit_model` | Prepara ou executa uma edição de STL pelo Blender, com saída separada. |

</details>

## Análise e otimização com mais contexto

Para conferir a instalação sem fatiar, execute `fatia-mcp --check` se instalou o executável, ou `node /caminho/completo/fatia-mcp/dist/index.js --check`. O diagnóstico consulta o servidor e o Bambu Studio, sem abrir a interface nem reconhecer atualizações. Ele não consegue confirmar se o aplicativo de chat já recarregou as ferramentas: reinicie o assistente após registrar ou atualizar o MCP.

O preflight oferece `detail: "brief"` para um resumo. Os checks pendentes são separados por próximo passo; as sondas de Blender do preflight ainda não estão implementadas. A análise rápida de geometria não equivale a uma verificação completa de saúde da malha.

O relatório de configurações distingue o valor salvo, o padrão da impressora e o valor selecionado. “Mantido” significa que a escolha do projeto foi preservada; comparar com o padrão não significa que ele foi aplicado. Identificadores internos também são traduzidos para os nomes das impressoras, usando os perfis da instalação selecionada e a referência abaixo.

A análise de desperdício mostra massas observadas por função, incluindo o material não classificado. Uma soma parcial não é um total garantido; valores de purga continuam desconhecidos quando a contabilização é ambígua.

Nas comparações, é possível selecionar a mesa e a instância de uma peça. Peça explicitamente para permitir movimentação ou reorientação; as outras peças devem permanecer intactas. Perfis de altura variável e ajustes por objeto são preservados por padrão. Para trocar por altura uniforme, informe esse objetivo e o escopo; a confirmação depende do G-code, não apenas do valor salvo na configuração.

O modo opcional de otimização de `prepare_print_project` procura equilíbrio entre tempo e material. Sem limites adicionais, preserva paredes, densidades, camadas e limites de velocidade externa do projeto. Mudanças que reduzam esses limites e reorientações precisam ser explicitamente permitidas. A busca tem orçamento e pode terminar sem encontrar uma melhoria; não garante o melhor resultado possível nem resistência ou acabamento físico.

Exemplo técnico do modo conservador de otimização:

```json
{"path":"/caminho/projeto.3mf","bambu_model":"a1","optimization":{"objective":"balanced"},"open_in_studio":false,"max_slices":12,"max_minutes":20}
```

Para autorizar uma redução específica, use `optimization.constraints`, por exemplo `{"min_infill_density":8}`. Isso permite testar até esse piso de configuração; não comprova resistência física. Para reorientar uma instância, acrescente `"allow_reorientation":true` e `"targets":[{"plate_index":2,"item_index":1}]`, usando os índices retornados pela listagem de objetos, não nomes ambíguos. Sem autorização, a orientação original é mantida.

### Qual impressora compensa para este projeto?

Peça no chat: **“Use o Fatia MCP: compare este projeto na A1 e na X2D e diga qual compensa mais.”** O Fatia prepara duas cópias independentes e fatia todas as mesas de cada uma, usando os perfis exatos da instalação e o mesmo tamanho de bico configurado. O original permanece preservado.

O relatório mostra a mais rápida, a que usa menos material e, quando você informar preços, a de menor **custo desta impressão**. Informe o preço do filamento por quilo; se quiser incluir energia, informe a tarifa e a potência média estimada de cada impressora. Também é possível informar um custo de máquina por hora para as duas. Valores ausentes permanecem desconhecidos, e os componentes incluídos no custo aparecem no relatório.

O objetivo padrão equilibra tempo com os custos informados; sem preço de material, equilibra tempo e consumo, sem concluir qual é financeiramente melhor. Você pode pedir prioridade em tempo, material ou custo. Diferenças de até 3% são tratadas como empate. A comparação não calcula o retorno da compra de uma impressora e não garante o mesmo acabamento físico.

Se um modelo não tiver perfil instalado, o projeto não couber, faltar uma mesa fatiada ou as configurações não puderem ser verificadas, o relatório explica a limitação e não recomenda um vencedor. O teste mantém posição, orientação, parâmetros de qualidade e perfis de altura salvos; não reorganiza as mesas automaticamente. Ajustes por objeto e perfis de altura variável ainda não têm comprovação efetiva neste modo: as estimativas aparecem, mas esses casos ficam sem recomendação de vencedor.

Exemplo técnico, na ferramenta existente `compare_slice_scenarios`:

```json
{
  "path": "/caminho/projeto.3mf",
  "printers": [
    {"bambu_model": "a1", "power_w": 100},
    {"bambu_model": "x2d", "power_w": 200}
  ],
  "material_price_per_kg": 100,
  "electricity_price_per_kwh": 1,
  "currency": "BRL",
  "objective": "balanced",
  "max_slices": 6,
  "max_minutes": 10
}
```

Os valores de potência acima são exemplos de entrada, não medições dessas impressoras. Use `printers` para comparar modelos ou `scenarios` para comparar ajustes de uma impressora; os modos não podem ser misturados. O orçamento inclui tentativas de fatiamento que falham e eventuais fatiamentos necessários para adaptar o projeto.

### Análise com menos leituras repetidas

O Fatia coleta o cabeçalho de configurações durante a própria análise do G-code. Isso elimina uma leitura adicional do arquivo por mesa, mantendo a verificação integral de integridade e o cancelamento. Nos testes de contagem de leituras, uma mesa passou de 3 para 2 leituras do arquivo, e duas mesas de 5 para 3. O ganho de tempo real depende do tamanho do arquivo, do disco e do custo do fatiamento no Studio.

### Codinomes das impressoras Bambu Lab

Alguns arquivos 3MF guardam um código interno no lugar do nome que aparece na impressora. Por exemplo, `N2S` significa **A1** e `N6` significa **X2D**. O Fatia reconhece o código, o nome completo e o nome curto, sem diferenciar maiúsculas e minúsculas.

Referência verificada em **2 de novembro de 2026**, nos arquivos oficiais do Bambu Studio:

| Impressora | Código interno | Nome curto | Fonte oficial |
|---|---|---|---|
| A1 mini | `N1` | `a1mini` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20A1%20mini.json) |
| A1 | `N2S` | `a1` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20A1.json) |
| A2L | `N9` | `a2l` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20A2L.json) |
| H2C | `O1C2` | `h2c` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20H2C.json) |
| H2D Pro | `O1E` | `h2dpro` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20H2D%20Pro.json) |
| H2D | `O1D` | `h2d` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20H2D.json) |
| H2S | `O1S` | `h2s` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20H2S.json) |
| P1P | `C11` | `p1p` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20P1P.json) |
| P1S | `C12` | `p1s` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20P1S.json) |
| P2S | `N7` | `p2s` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20P2S.json) |
| X1 Carbon | `BL-P001` | `x1c` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20X1%20Carbon.json) |
| X1 | `BL-P002` | `x1` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20X1.json) |
| X1E | `C13` | `x1e` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20X1E.json) |
| X2D | `N6` | `x2d` | [Perfil Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20X2D.json) |

Os perfis da instalação selecionada têm prioridade. Quando não houver informação instalada sobre um modelo, o Fatia usa esta referência versionada. Se houver conflito ou o código for desconhecido, o resultado continua desconhecido; a ferramenta não escolhe uma impressora por aproximação.

Reconhecer o codinome ajuda a ler e comparar projetos. Para fatiar, continua sendo obrigatório selecionar um modelo aceito pelo Fatia e ter o perfil exato de impressora e bico instalado. **X1 e A2L são reconhecidas nesta tabela, mas não estão habilitadas para fatiamento.** Essa tradução não adiciona conexão ou controle da impressora.

## Onde ficam os arquivos

Por padrão, os resultados são salvos em:

```text
~/.fatia-mcp/outputs
```

O símbolo `~` representa a pasta do seu usuário. Os arquivos entregues continuam lá depois de fechar o MCP. Edições e testes recebem caminhos próprios para preservar resultados anteriores.

O assistente deve informar o caminho do resultado. Se quiser outro destino, peça que ele configure `FATIA_OUTPUT_DIR`; a ferramenta de preparação também aceita `output_dir`.

## O que conferir nos resultados

- **Estimativa não é medição física.** Tempo, custo, consumo, suporte e contato com a mesa não garantem uma impressão bem-sucedida.
- **“Desconhecido” significa que falta informação.** Isso pode acontecer quando alguma mesa não foi fatiada, o consumo por slot está incompleto ou a purga não pode ser contabilizada com confiança.
- **Estoque é informado por você.** A checagem usa uma margem padrão de 10%, não reserva nem desconta material e não consulta o AMS ou um serviço de estoque. Não conte o mesmo rolo duas vezes em slots diferentes.
- **Calibrações precisam ser impressas e avaliadas.** Cada valor gera um projeto separado. O teste de temperatura mantém a temperatura inicial do projeto e usa o valor escolhido nas demais camadas; não é uma torre com temperaturas variando por altura.
- **Teste de encaixe usa folga radial.** Uma folga radial de 0,2 mm aumenta o diâmetro do furo em 0,4 mm em relação ao pino. As identificações ficam nos nomes dos arquivos e no manifesto, não gravadas na peça.
- **Uma malha fechada ainda pode ter problemas.** A análise de saúde não verifica auto-interseções nem faz reparos. Por padrão, aceita até 100 mil triângulos, com limite configurável de até 250 mil nessa ferramenta.
- **Extrair para STL preserva a geometria, mas perde informações do projeto**, como pintura, materiais, modificadores e configurações de fatiamento. Guarde o 3MF original.
- **Comparações têm orçamento.** Mais alternativas podem exigir vários minutos de processamento. Um resultado parcial não significa que todas as possibilidades foram testadas.

## Se algo não funcionar

| Situação | O que fazer |
|---|---|
| O assistente não encontra o Fatia | Reinicie o aplicativo e peça para verificar a configuração MCP e listar as ferramentas. |
| O Bambu Studio não é encontrado | Informe onde ele está instalado. O assistente pode configurar `SLICER_PATH`. |
| Falta o perfil da impressora | Confira a instalação e os perfis do Bambu Studio. Use o perfil exato do modelo e do bico. |
| O assistente pede o modelo | Informe o modelo real. Isso é necessário para selecionar as configurações de fatiamento. |
| Uma comparação recusa o arquivo | Prepare primeiro um 3MF para a impressora escolhida. Para comparar orientações, informe a mesa e selecione o item quando houver várias peças. |
| O custo ou estoque aparece como desconhecido | Use um projeto já fatiado e confira se todas as mesas e os consumos por material estão registrados. |
| O processamento demora | Peças grandes e várias alternativas exigem mais trabalho. Peça menos opções ou um orçamento menor de fatiamentos. |

<a id="blender-mcp"></a>

Para editar com Blender, é preciso instalar e configurar uma conexão Blender MCP separada e ativar o complemento correspondente dentro do Blender. As outras funções do Fatia funcionam sem ele.

## Guias técnicos

Os guias abaixo têm os detalhes de configuração e funcionamento; o guia de fatiamento permanece em inglês:

- [Instalação, variáveis e configuração manual](./docs/SETUP.md)
- [Fatiamento, perfis e compatibilidade](./docs/SLICING.md)
- [Histórico de mudanças](./CHANGELOG.md)

## Autoria e licença

Fatia MCP é um fork mantido por [Anthony Daros](https://github.com/anthonydaros), baseado no [bambu-printer-mcp de David Montgomery](https://github.com/DMontgomery40/bambu-printer-mcp), que deriva do [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server).

O projeto preserva a licença **GPL-2.0** e os créditos dos autores e [colaboradores](./CONTRIBUTORS.md). Consulte a [licença completa](./LICENSE).

Versões anteriores tiveram referências de fluxos e comandos no [Bambuddy](https://github.com/maziggy/bambuddy), sob AGPL-3.0. Este projeto não incorpora código dele. As funções de contato e controle de impressora foram removidas deste fork.
