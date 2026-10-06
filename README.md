# Painel de Permissões

Painel web **somente leitura** que mostra, para cada usuário **ativo** do ERP Tecinco:

1. **Dados gerais** — nome completo, status, perfil, filial padrão e cargo;
2. **Permissões** — perfil, permissões individuais e grupos de acesso por sistema;
3. **Restrições** — sistemas, filiais, vendedores/consultores relacionados, desconto especial,
   condição de pagamento, operação fiscal, tipo de título, pedido de compras, contas contábeis,
   cargo, restrições de negócio, exceções individuais e restrições de telas/campos;
4. **Acessos** — telas e relatórios liberados, agrupados por sistema.

HTML, CSS e JavaScript puros (sem frameworks), em `index.html`, `style.css` e `script.js`.
Lista com busca por nome, indicador de carregamento, mensagens de erro de conexão e de "sem dados",
responsivo (computador e celular), tema claro/escuro automático e navegação por teclado.

## Como funciona

```
ERP (Firebird, somente leitura)
        │  scripts/exportar_usuarios_erp.py   (API: api-tecinco-bi-evoluido)
        ▼
tools/atualizar-dados.mjs  ── criptografa (AES-256-GCM, senha) ──►  data/usuarios.enc.json
                                                                          │  git push
                                                                          ▼
                                                              GitHub Pages (arquivos estáticos)
                                                                          │
                                         navegador baixa o arquivo, pede a senha e decifra localmente
```

O GitHub Pages só serve arquivos estáticos, então os dados são **gerados antes** (snapshot) e
publicados **criptografados**. Para atualizar, rode o passo "Atualizar os dados" abaixo.

## Segurança — leia antes de publicar

Os dados dizem quem pode fazer o quê no ERP; são informação interna.

- O repositório é público, mas o único arquivo com dados (`data/usuarios.enc.json`) está
  criptografado: AES-256-GCM, chave derivada da senha com PBKDF2-SHA256 (600.000 iterações) e
  conteúdo comprimido antes de cifrar. Sem a senha ele é ilegível.
- **A proteção é tão forte quanto a senha.** O arquivo é público, então qualquer pessoa pode baixá-lo e
  tentar adivinhar a senha offline. Use uma frase longa (4 ou mais palavras; a ferramenta exige no
  mínimo 14 caracteres) e não reutilize uma senha de outro lugar.
- **Trocar a senha não apaga o passado.** Versões antigas do arquivo continuam no histórico do Git.
  Se a senha vazar, considere os dados daquela época como expostos: tire o site do ar
  (Settings → Pages) e apague o arquivo também do histórico.
- Tornar o repositório privado **não** protege o site: o site do GitHub Pages continua público,
  salvo em planos Enterprise com Pages privado. A proteção real é a senha.
- Ficam visíveis sem a senha apenas: o formato do arquivo, a data de geração e o tamanho.
- Nunca entram no arquivo: senha do ERP (`USR_SENHA`), CPF, e-mail, data de nascimento, IMEI e login.
  Há testes que quebram se uma consulta passar a ler essas colunas.
- A página não envia nada para fora (CSP restritiva), não usa `innerHTML` (textos vêm sempre como
  texto), descarta os dados da memória em **Bloquear** e após 15 minutos sem uso, e só pede a senha
  no navegador — ela não é guardada.
- `.gitignore` impede subir qualquer outro arquivo dentro de `data/` (por exemplo, um JSON em claro).

## Atualizar os dados

Pré-requisitos: Node.js 20+ e a API (pasta `api-tecinco-bi-evoluido`, ao lado deste projeto; outro
local via `--api-dir` ou variável `API_DIR`) com acesso ao Firebird configurado no `.env` dela.

```bash
ATUALIZAR_DADOS.bat          # ou: npm run atualizar
```

A ferramenta lê os usuários ativos pela API (somente leitura), pede a senha duas vezes (sem eco),
criptografa e grava `data/usuarios.enc.json`. O JSON em claro só passa pela memória; nunca vai a disco.
Opções: `--api-dir <pasta>`, `--python <python.exe>`, `--saida <arquivo>`. Para automação, a senha pode
vir da variável `PAINEL_SENHA` (menos seguro). Depois publique:

```bash
git add data/usuarios.enc.json
git commit -m "Atualiza dados dos usuários"
git push
```

## Publicar no GitHub Pages

1. No repositório: **Settings → Pages → Build and deployment → Deploy from a branch**.
2. Branch `main`, pasta `/ (root)`, **Save**.
3. A página fica em `https://<usuario>.github.io/<repositorio>/`.

## Testar localmente

```bash
SERVIR_LOCAL.bat             # ou: npm run servir  → http://127.0.0.1:8080/
```

Abrir `index.html` direto do disco (`file://`) não funciona: o navegador bloqueia o download do arquivo de dados.

## Regras usadas para calcular o que cada usuário pode fazer

Derivadas da própria procedure `SP_RETORNA_SECUR_RESTRICAO` do ERP:

- **Níveis de restrição de tela:** 0 sem restrição · 1 habilitado · 2 visível · 3 desabilitado · 4 invisível.
  Não existir linha para o item significa **sem restrição**.
- Usuário em mais de um grupo para o mesmo item: vale o **nível mais alto** (o mais restritivo).
- **Exceção individual** (`SECUR_RESTRICAO_USUARIO`) substitui o nível que vem dos grupos.
- **Tela liberada** = o usuário tem o sistema (pacote) dela no cadastro **e** nenhum grupo a deixa
  desabilitada (3) ou invisível (4). Itens de menu que só agrupam telas não são contados.
- **Ativo** = `USUARIO.USR_SITUACAO = 'A'`.

| Aba / seção | Tabelas do ERP |
| --- | --- |
| Dados gerais | `USUARIO`, `SECUR_USUARIO`, `SECUR_PERFIL`, `FILIAL`, `USUARIOCARGO`/`CARGO` |
| Permissões individuais | colunas `USR_PERMITE*` e similares de `USUARIO` |
| Grupos de acesso | `SECUR_USUARIO_GRUPO`, `SECUR_GRUPO` |
| Sistemas / Filiais | `USUARIOPACKAGE`/`PACKAGE`, `USUARIOFILIAL` |
| Vendedores / Consultores | `USUARIOVENDEDOR`/`VENDEDOR`, `USUARIOCONSULTOR`/`AT_CONSULTOR`/`AT_PRODUTIVO` |
| Desconto especial | `PG_USUARIODESCONTO` (+ centro de consumo, grupo, subgrupo, marca) |
| Condição de pagamento | `PG_USUARIO_CONDPGTO`/`COND_PAGTO` |
| Operação fiscal / Tipo de título | `USUARIOOPERACAO`/`TP_OPERACAO`, `USUARIO_TIPOTITULO`/`FN_TIPOTITULO` |
| Pedido de compras / Contas contábeis | `USUARIO_PEDIDOCOMPRA`, `USUARIOCONTASCONTABEIS`/`CT_PLANOCONTA` |
| Restrições de negócio | `USUARIOGRUPO`/`GRUPO`, `GRUPORESTRICAO`/`RESTRICAO`, `USUARIORESTRICAO` |
| Exceções e restrições de tela | `SECUR_RESTRICAO_USUARIO`, `SECUR_RESTRICAO`, `SECUR_OBJETOS` |

Por enquanto não há registros de **condição de pagamento** nem de **pedido de compras** para nenhum
usuário ativo; essas seções aparecem como "Nenhum registro" e passam a mostrar dados assim que existirem.

## Limitações conhecidas

- Os rótulos das permissões individuais foram derivados dos nomes das colunas do ERP; vale uma
  conferência de quem conhece o TCar.
- Nomes de tela e relatório vêm do ERP e podem estar cortados em 40 caracteres.
- O painel é um retrato do momento da última atualização (data exibida no topo).
- Em `Restrições de negócio`, só entram restrições herdadas dos grupos (`USUARIOGRUPO`);
  limites individuais (`USUARIORESTRICAO`) aparecem se existirem (hoje não há).

## Testes

```bash
npm test                                   # criptografia (Node)
```

Na API: `venv\Scripts\python.exe -m pytest tests\test_usuarios_erp_service.py tests\test_usuarios_erp_routes.py tests\test_firebird_usuarios_reader.py`.

## Estrutura

```
index.html  style.css  script.js     painel (3 arquivos)
data/usuarios.enc.json               dados criptografados (gerado)
tools/atualizar-dados.mjs            lê a API, criptografa e grava
tools/cripto.mjs                     AES-GCM + PBKDF2 (mesmo formato que o navegador decifra)
tools/servir.mjs                     servidor local para testes
ATUALIZAR_DADOS.bat  SERVIR_LOCAL.bat
```
