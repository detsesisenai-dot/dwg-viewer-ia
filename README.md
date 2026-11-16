# Visualizador DWG

Sistema web (HTML + JavaScript) para visualizar arquivos **AutoCAD DWG/DXF** direto no navegador,
com zoom/pan e um painel lateral com informações do desenho e **áreas dos polígonos fechados**.

O arquivo é decodificado **no navegador** com o [LibreDWG](https://www.gnu.org/software/libredwg/)
compilado para WebAssembly (`@mlightcad/libredwg-web`). Nada é enviado a servidor, por isso o site é
100% estático e roda na Vercel sem funções serverless.

## Funcionalidades

- Abrir arquivo pelo botão **ou arrastando** o `.dwg`/`.dxf` para a janela
- Renderização em Canvas: linhas, polilinhas (com arcos/bulge), círculos, arcos, elipses, splines,
  hachuras, sólidos, textos/MTEXT, blocos (INSERT, inclusive arrays) e cotas
- Zoom com a roda do mouse (centrado no cursor), pinça no celular, botões `+`/`−`/ajustar,
  atalhos `+`, `-`, `F`; arrastar para mover; duplo clique ajusta à tela
- Painel à direita:
  - arquivo: nome, tamanho, versão do AutoCAD, extensão e **unidade** (lida de `INSUNITS`, ajustável)
  - resumo: entidades, layers, nº de polígonos e área somada
  - **lista de polígonos com área e perímetro** (polilinhas fechadas, círculos, elipses e hachuras —
    furos/ilhas das hachuras são descontados), filtro por layer, ordenação e exportação CSV
  - clique num polígono (na lista ou no desenho) para destacá-lo e ver detalhes
  - layers com liga/desliga e contagem de entidades por tipo

### Como a área é calculada

- Polilinhas: fórmula de Gauss (shoelace) **mais a área exata dos segmentos circulares** (bulge)
- Círculo `πr²`, elipse `πab`
- Hachura: soma dos contornos externos menos os contornos internos (regra par/ímpar)
- Polígonos dentro de blocos consideram a escala do bloco (opção “Incluir polígonos dentro de blocos”)

## Rodar localmente

Requer Node.js 20+.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # gera dist/
npm run preview   # serve o build de produção
```

## Deploy na Vercel

O projeto já está configurado ([vercel.json](vercel.json)): framework **Vite**, build `npm run build`,
saída `dist/`, cache longo para os arquivos com hash em `/assets` (incluindo o `.wasm` de ~7,8 MB).

**Pelo painel:** em <https://vercel.com/new>, importe este repositório do GitHub e clique em *Deploy*
(nenhuma variável de ambiente é necessária).

**Pela CLI:**

```bash
npm i -g vercel
vercel          # deploy de pré-visualização
vercel --prod   # deploy de produção
```

## Estrutura

```
index.html               página e layout (canvas + painel direito)
src/main.js              UI: abrir/arrastar arquivo, painel, filtros, CSV
src/parser.worker.js     Web Worker que decodifica o DWG/DXF com LibreDWG (WASM)
src/scene.js             conversão das entidades em geometria 2D + cálculo de áreas
src/viewer.js            renderizador Canvas com zoom/pan e seleção
src/aci.js               paleta de cores AutoCAD (ACI)
vercel.json              configuração de deploy
```

## Limitações conhecidas

- Mostra apenas o **espaço do modelo** (layouts/paper space não são desenhados)
- Hachuras com padrão são exibidas com preenchimento translúcido, não com o padrão de linhas
- Tipos de linha (tracejado), espessuras e fontes SHX não são reproduzidos
- Entidades 3D (sólidos ACIS, malhas) não são desenhadas
- Arquivos muito grandes dependem da memória do navegador

## Licença

O código deste repositório está sob a licença MIT ([LICENSE](LICENSE)). A biblioteca
`@mlightcad/libredwg-web` (LibreDWG) é distribuída sob **GPL-3.0** e é incluída no bundle publicado.
