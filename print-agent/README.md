# Orquestra — Agente de Impressão (estação Windows)

O backend do Orquestra roda na VPS (Linux) e **não enxerga** a impressora da sua
LAN. Este agente roda **na máquina Windows** onde a impressora está instalada e
recebe o ZPL do navegador para imprimir **direto na impressora compartilhada que
você configurar pelo nome** — sem diálogo, sempre a mesma.

## Pré-requisito
- **Node.js 18+** instalado na estação (https://nodejs.org).

## Como rodar
1. Copie esta pasta `print-agent` para a máquina Windows.
2. Dê dois cliques em **`iniciar-agente.bat`** (ou rode `node agent.mjs`).
3. Deixe a janela aberta. O agente fica ouvindo em `http://127.0.0.1:9110`.

## Compartilhar a impressora (uma vez)
1. Painel de Controle → Dispositivos e Impressoras → botão direito na impressora →
   **Propriedades da impressora** → aba **Compartilhamento**.
2. Marque **Compartilhar esta impressora** e defina um nome simples, **sem espaços**
   (ex.: `ZEBRA_RAW1`).
3. Na tela de Etiquetagem do Orquestra, em **⚙ Configurações → Impressora**, cole
   esse nome (`ZEBRA_RAW1`) e clique em **Testar**. Pronto: toda etiqueta vai direto.

> Dica de fidelidade: para o ZPL sair perfeito, a impressora deve usar um driver
> que repasse dados crus (o **ZDesigner ZPL** da Zebra ou **Generic / Text Only**).

## Iniciar junto com o Windows (opcional)
- Tecle `Win + R`, digite `shell:startup` e Enter.
- Crie um atalho para `iniciar-agente.bat` dentro dessa pasta. O agente passa a
  subir sozinho no login.

## Configuração
- Porta: variável de ambiente `PORT` (padrão `9110`). Ex.: `set PORT=9200 && node agent.mjs`.
- Segurança: o agente escuta **somente** em `127.0.0.1` (apenas o navegador da
  própria máquina consegue chamá-lo).

## Endpoints (uso interno do navegador)
- `GET  /health`   → `{ ok, platform }`
- `GET  /printers` → `{ ok, printers: [{ name, shareName, shared }] }`
- `POST /print`    → body `{ zpl, printer, host? }` → imprime cru via `copy /B`.
