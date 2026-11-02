# Instalação e configuração do Fatia MCP

[Voltar ao README](../README.md#set-up-with-your-agent) · [Guia técnico de fatiamento](./SLICING.md)

O Fatia prepara arquivos no seu computador. Não há IP, número de série ou código de acesso de impressora para configurar. Preserve os outros servidores MCP que você já usa.

## Escolha a instalação pelo seu aplicativo

| Aplicativo | Instalação |
|---|---|
| Claude Desktop | Pacote `fatia-mcp.mcpb` ou código-fonte |
| Claude Code, Codex, Cursor e outros clientes stdio | Código-fonte e configuração do comando Node |

O pacote MCPB é uma extensão para aplicativos compatíveis, como Claude Desktop. Ele não é um instalador para o Claude Code CLI ou para o Codex.

### Pré-requisitos

- Node.js 24 e npm para executar o servidor; Git para baixar o código.
- Bambu Studio instalado para fatiar e revisar os resultados. Use a árvore de perfis dessa mesma instalação, incluindo o perfil exato da sua impressora e do bico.
- Confirme o modelo real, o diâmetro/material/vazão do bico e o tipo de mesa. Não adivinhe esses dados.

### Código-fonte

```bash
git clone https://github.com/anthonydaros/fatia-mcp.git
cd fatia-mcp
npm ci
npm run build
```

Configure o cliente para executar:

```bash
node /caminho/completo/fatia-mcp/dist/index.js --stdio
```

Substitua o caminho pelo local real da instalação. Se o aplicativo não encontrar o Node, informe também o caminho completo do executável. Não instale o pacote público `bambu-printer-mcp`: ele pertence a outra implementação.

### Claude Desktop: pacote MCPB

Baixe `fatia-mcp.mcpb` das [versões publicadas](https://github.com/anthonydaros/fatia-mcp/releases), abra o arquivo no Claude Desktop e siga o assistente. Ele solicita o modelo da impressora e as opções de slicer/Blender. Para desenvolvimento, instalações que permitam podem usar **Settings → Extensions → Advanced Settings → Extension Developer → Install Unpacked**, selecionando a pasta com `manifest.json` após compilar.

Para gerar um pacote local:

```bash
npm ci
npm run package:mcpb
```

O pacote é preparado em uma pasta temporária isolada, com dependências de produção, fontes e licenças. Credenciais/modelos privados ficam de fora; as dependências de desenvolvimento não são apagadas.

## Configuração do cliente MCP

Este exemplo JSON funciona em clientes que usam `mcpServers`, como Claude Desktop e Claude Code. O modelo `p1s` é apenas um exemplo: substitua pelo seu modelo real.

```json
{
  "mcpServers": {
    "fatia": {
      "command": "node",
      "args": ["/caminho/completo/fatia-mcp/dist/index.js", "--stdio"],
      "env": {
        "BAMBU_MODEL": "p1s",
        "SLICER_TYPE": "bambustudio",
        "SLICER_PATH": "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"
      }
    }
  }
}
```

| Cliente | Onde configurar |
|---|---|
| Claude Desktop no macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop no Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code por projeto | `.mcp.json` na pasta do projeto |
| Claude Code por usuário | `~/.claude.json`; [referência oficial](https://code.claude.com/docs/en/mcp) |
| Cursor | Configurações MCP nas preferências do aplicativo |
| Codex CLI/aplicativo | `~/.codex/config.toml`, em TOML; [referência oficial](https://developers.openai.com/codex/mcp/) |

**Reinicie o cliente depois de registrar ou editar a configuração.** Um servidor conectado em um teste separado não comprova que as ferramentas já estão disponíveis no chat que estava aberto.

## Verificar sem fatiar

Após compilar ou instalar, execute:

```bash
node /caminho/completo/fatia-mcp/dist/index.js --check
```

Se o comando local `fatia-mcp` estiver no PATH, também pode usar `fatia-mcp --check`. O diagnóstico verifica Node, inicialização MCP, lista de ferramentas e informações locais do Studio. Não fatia, abre GUI, imprime nem reconhece uma versão do Studio por você.

Compare as ferramentas anunciadas com a [referência do README](../README.md). O resultado do servidor é a fonte para saber quais ferramentas sua versão realmente oferece. Se acabou de registrar o MCP, reinicie o cliente antes de tentar usá-las nativamente.

## Variáveis de ambiente

Você pode informar estas variáveis na configuração do cliente ou em um `.env` na pasta de execução do servidor. Em geral, basta configurar modelo, bico, mesa e caminho do Studio. Caminhos com espaços devem ser passados como argumentos separados na configuração MCP, não como comandos de shell.

### Exemplo mínimo para macOS

```env
BAMBU_MODEL=p1s
NOZZLE_DIAMETER=0.4
BED_TYPE=textured_plate
SLICER_TYPE=bambustudio
SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
MCP_TRANSPORT=stdio
```

### Referência completa

| Variável | Padrão | Para que serve |
|---|---|---|
| `BAMBU_MODEL` |  | **Obrigatório para fatiar.** Modelo exato: `p1s`, `p1p`, `p2s`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`, `h2dpro`, `h2s`, `h2c`, `x2d`. Alias: `BAMBU_PRINTER_MODEL`. Se faltar, o cliente pode perguntar. Não substitua H2D Pro/H2C/X2D por H2D. Um arquivo preparado para outra máquina pode causar danos ao imprimir. |
| `BED_TYPE` | `textured_plate` | Tipo de mesa: `textured_plate`, `cool_plate`, `engineering_plate`, `hot_plate`, `supertack_plate` (veja a ressalva abaixo). |
| `NOZZLE_DIAMETER` | `0.4` | Diâmetro do bico em milímetros; seleciona o perfil exato de modelo/bico. |
| `BAMBU_NOZZLE_TYPE` | bico original do perfil | Material do bico instalado: `stainless_steel`, `hardened_steel`, `tungsten_carbide` ou `brass`. Informe se trocou o bico original. |
| `BAMBU_NOZZLE_VOLUME_TYPE` | `standard` | Vazão do bico instalado: `standard` ou `high_flow`. Use High Flow somente se instalado e suportado pelo perfil. |
| `BAMBU_CONFIRMATION_TIMEOUT_MS` | `600000` | Espera pelas respostas sobre impressora e configurações, de 1000 a 3600000 ms. Ao expirar, nada é fatiado. |
| `SLICER_TYPE` | `bambustudio` | Slicer escolhido: `bambustudio`, `prusaslicer`, `cura` ou `slic3r`. O fluxo principal usa Bambu Studio. |
| `SLICER_PATH` | padrão do sistema | Caminho completo do executável. `BAMBU_STUDIO_PATH` define o padrão apenas do Bambu Studio. |
| `SLICER_PROFILE` |  | Arquivo de configurações do processo; `BAMBU_SLICER_PROFILE` tem prioridade. Não substitui o perfil obrigatório da máquina. |
| `MCP_ALLOW_EXECUTABLE_ARG` | desativado | Permite substituição de executáveis por chamada. Prefira os caminhos fixos da configuração do servidor. |
| `BAMBU_TEMPLATE_DIR` | `~/Sync/bambu/templates` | Pasta dos modelos de configuração salvos. |
| `BAMBU_TEMPLATE_3MF_PATH` |  | Arquivo 3MF usado como modelo padrão de fatiamento. |
| `TEMP_DIR` | pasta temporária privada | Arquivos de trabalho. A pasta criada automaticamente é removida no encerramento; caminhos relativos partem da pasta de execução do servidor. |
| `FATIA_OUTPUT_DIR` | `~/.fatia-mcp/outputs` | Resultados persistentes. Não são removidos no encerramento; `prepare_print_project.output_dir` substitui o destino para uma chamada. |
| `MCP_TRANSPORT` | `stdio` | Transporte: `stdio` ou `streamable-http`. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Endereço local de escuta HTTP. |
| `MCP_HTTP_PORT` | `3000` | Porta HTTP. |
| `MCP_HTTP_PATH` | `/mcp` | Caminho do endpoint HTTP. |
| `MCP_HTTP_STATEFUL` | `true` | Ativa sessões HTTP independentes por cliente. |
| `MCP_HTTP_JSON_RESPONSE` | `true` | Habilita respostas HTTP em JSON. |
| `MCP_HTTP_ALLOWED_ORIGINS` |  | Origens de navegador permitidas, separadas por vírgula. |
| `BLENDER_MCP_COMMAND` |  | Executável confiável de um servidor Blender MCP por stdio, como o caminho completo de `uvx`. |
| `BLENDER_MCP_ARGS` | `[]` | Lista JSON de argumentos, como `["blender-mcp"]`. Não é uma linha de comando de shell. |
| `BLENDER_MCP_TIMEOUT_MS` | `120000` | Prazo para conexão/descoberta/chamadas: 100 a 300000 ms. Edições interrompidas não são repetidas automaticamente. |
| `DISABLE_TELEMETRY` |  | `DISABLE_TELEMETRY=1` é repassado ao processo Blender MCP para desativar a telemetria desse servidor. Somente esta variável e as variáveis `BLENDER_*` são repassadas além do ambiente mínimo. |
| `BLENDER_MCP_BRIDGE_COMMAND` |  | Ponte executável legada que recebe `MCP_BLENDER_PAYLOAD`; é diferente da conexão MCP padrão. |
| `BAMBU_CLI_FLATTEN` | automático | Opção legada. Dependências `inherits` e `include` dos perfis BBL são sempre resolvidas quando existem; esta opção não desativa a validação obrigatória. Arquivos independentes sem dependências são aceitos. |
| `BAMBU_PROFILES_ROOT` | derivado de `SLICER_PATH` | Caminho para `Resources/profiles` da instalação selecionada, contendo `BBL`. Essa árvore é a fonte exclusiva dos perfis incluídos no aplicativo. |
| `SLICER_STATE_FILE` | `~/.bambu-printer-mcp/slicers.json` | Arquivo JSON com versões do Studio/perfis aprovadas por você através de `slicer_info` com `acknowledge: true`. A pasta é criada na primeira gravação. O diagnóstico não reconhece versões por você. |

O identificador CLI de `supertack_plate` ainda não está validado. Use a GUI do Bambu Studio para fatiar projetos SuperTack até haver suporte confirmado.

Os resultados ficam em `~/.fatia-mcp/outputs`; arquivos temporários são separados. Consulte o [guia de fatiamento](./SLICING.md) para perfis, mapeamento de filamentos e limitações.

## HTTP opcional

O padrão recomendado para aplicativos locais é `stdio`. Para HTTP, configure `MCP_TRANSPORT=streamable-http`; os padrões são host `127.0.0.1`, porta `3000`, endpoint `/mcp` e sessões independentes por cliente.

Host e Origin são validados. O navegador precisa usar a origem do endpoint ou uma origem explicitamente incluída em `MCP_HTTP_ALLOWED_ORIGINS`; clientes nativos sem Origin são aceitos. O modo sem estado cria um transporte por requisição. Esse transporte local não oferece autenticação para hospedagem pública.

## Blender opcional

As ferramentas principais funcionam sem Blender. Para a ponte padrão, use `BLENDER_MCP_COMMAND=uvx` (ou caminho completo), `BLENDER_MCP_ARGS='["blender-mcp"]'` e inicie o complemento correspondente dentro do Blender. Um servidor MCP responder não comprova que o complemento está conectado. Edições exigem saída nova e são verificadas; depois de uma interrupção, confira a cena antes de repetir qualquer pedido.

A ponte não implementa as sondas de Blender do preflight: esses checks continuam identificados como não implementados.

<a id="optional-code-mode"></a>

## Execução de código opcional

Se o seu assistente já oferece execução de código ou mecanismo equivalente, use esse recurso para compor chamadas quando útil. Uma integração adicional é opcional, nunca um pré-requisito para usar o Fatia. Consulte a documentação atual do cliente escolhido antes de instalar outra integração. [Referência da abordagem](https://www.anthropic.com/engineering/code-execution-with-mcp).
