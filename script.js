'use strict';

/* ============================================================================
 * Painel de Permissões — somente leitura
 *
 * Como funciona:
 *   1. A página baixa data/usuarios.enc.json (dados CRIPTOGRAFADOS: AES-256-GCM,
 *      chave derivada da senha com PBKDF2). Sem a senha o arquivo é ilegível.
 *   2. O usuário digita a senha; a decifragem acontece aqui, no navegador (WebCrypto).
 *      A senha nunca é enviada a lugar nenhum nem guardada.
 *   3. Os dados decifrados ficam só na memória da aba. "Bloquear" (ou 15 minutos
 *      sem uso) descarta tudo.
 *
 * Segurança de exibição: todo texto vindo dos dados entra na página com
 * textContent / createTextNode (função criar). Não existe innerHTML neste arquivo,
 * então um nome ou descrição com HTML/JS é mostrado como texto, nunca executado.
 *
 * Os dados são gerados por tools/atualizar-dados.mjs a partir da API (somente leitura).
 * ========================================================================== */


/* ============================================================================
 * 1. CONFIGURAÇÃO — único lugar para URL do arquivo, cabeçalhos e limites
 * ========================================================================== */
const CONFIG = Object.freeze({
  /** Arquivo de dados criptografado (relativo a esta página). */
  URL_DADOS: 'data/usuarios.enc.json',
  /** Opções do fetch (cabeçalhos incluídos). Sem cookies/credenciais. */
  OPCOES_FETCH: Object.freeze({
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-cache', // sempre confere se há versão mais nova do arquivo
    credentials: 'omit',
  }),
  /** Formato do envelope criptografado e versão do conteúdo que esta tela entende. */
  FORMATO_ENVELOPE: 'painel-permissoes/1',
  VERSAO_DADOS: 1,
  /** Limites de segurança para o que vem do arquivo (evita travar o navegador). */
  ITERACOES_MIN: 100000,
  ITERACOES_MAX: 3000000,
  /** Bloqueio automático por inatividade (minutos). */
  BLOQUEIO_INATIVIDADE_MIN: 15,
  /** Quantos itens mostrar por vez nas listas grandes. */
  TAMANHO_LOTE: 80,
});

/** Níveis de restrição do ERP agrupados por significado. */
const NIVEIS_RESTRICAO = new Set([3, 4]); // desabilitado, invisível
const NIVEIS_LIBERACAO = new Set([1, 2]); // habilitado, visível (liberação explícita)

const FILTROS_NIVEL = {
  restricoes: { rotulo: 'Restrições (desabilitado ou invisível)', niveis: NIVEIS_RESTRICAO },
  liberacoes: { rotulo: 'Liberações explícitas (habilitado ou visível)', niveis: NIVEIS_LIBERACAO },
  todos: { rotulo: 'Todos os níveis', niveis: null },
};

const CLASSE_NIVEL = { 1: 'selo-ok', 2: 'selo-info', 3: 'selo-aviso', 4: 'selo-erro' };

const MENSAGENS = {
  rede: 'Não foi possível conectar para baixar os dados. Verifique sua conexão com a internet e tente novamente.',
  ausente: 'O arquivo de dados ainda não foi publicado. Peça a quem mantém o painel para gerar os dados.',
  http: 'O servidor respondeu com erro ao buscar os dados. Tente novamente em instantes.',
  formato: 'Os dados estão em um formato que este painel não reconhece. Peça a quem mantém o painel para atualizá-los.',
  navegador: 'Este navegador não oferece os recursos de segurança necessários. Use uma versão recente do Chrome, Edge, Firefox ou Safari.',
  senha: 'Senha incorreta. Confira e tente novamente.',
};


/* ============================================================================
 * 2. ESTADO E REFERÊNCIAS DO DOM
 * ========================================================================== */
const $ = (id) => document.getElementById(id);

const estado = {
  envelope: null, // arquivo criptografado (só metadados + texto cifrado)
  dados: null, // conteúdo decifrado (somente em memória)
  indices: null, // mapas de consulta montados a partir de `dados`
  usuario: null, // usuário selecionado
  aba: 'gerais',
  ultimaAtividade: Date.now(),
  temporizadorBloqueio: null,
};

const ABAS = ['gerais', 'permissoes', 'restricoes', 'acessos'];

/** Layout de celular/tablet em pé (mesmo ponto de corte do style.css). */
const LAYOUT_CELULAR = window.matchMedia('(max-width: 900px)');
const renderizadores = {}; // preenchido na seção 8
const abasRenderizadas = new Set(); // abas já desenhadas para o usuário atual

class ErroPainel extends Error {
  constructor(tipo, mensagem) {
    super(mensagem || MENSAGENS[tipo] || 'Erro inesperado.');
    this.tipo = tipo;
  }
}


/* ============================================================================
 * 3. UTILITÁRIOS: DOM SEGURO E FORMATAÇÃO
 * ========================================================================== */

/**
 * Cria um elemento sem usar innerHTML.
 * props: classe, texto (vira textContent), attrs ({atributo: valor}), eventos ({click: fn}).
 * filhos: Nodes ou textos (textos viram nós de texto, nunca HTML).
 */
function criar(tag, props = {}, ...filhos) {
  const no = document.createElement(tag);
  if (props.classe) no.className = props.classe;
  if (props.texto != null) no.textContent = String(props.texto);
  for (const [nome, valor] of Object.entries(props.attrs || {})) {
    if (valor != null && valor !== false) no.setAttribute(nome, valor === true ? '' : String(valor));
  }
  for (const [evento, funcao] of Object.entries(props.eventos || {})) no.addEventListener(evento, funcao);
  for (const filho of filhos.flat()) {
    if (filho == null || filho === false) continue;
    no.append(typeof filho === 'string' || typeof filho === 'number' ? document.createTextNode(String(filho)) : filho);
  }
  return no;
}

/** Texto sem acento e em minúsculas, para buscas. */
function semAcento(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const comparar = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { sensitivity: 'base', numeric: true });

/** Iniciais (primeira e última palavra que começam com letra) para o avatar. */
function iniciais(nome) {
  const partes = String(nome || '').split(/\s+/).filter((p) => /^\p{L}/u.test(p));
  if (!partes.length) return '?';
  const primeira = partes[0][0];
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
  return (primeira + ultima).toUpperCase();
}

const fmtNumero = (n) => Number(n).toLocaleString('pt-BR');
const fmtPercentual = (n) => (n == null ? '—' : `${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const fmtMoeda = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const fmtDataHora = (iso) => {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '—' : data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
};
const ouTraco = (valor) => (valor == null || valor === '' ? '—' : valor);

/** Mensagem para quando uma lista está vazia. */
const vazio = (texto = 'Nenhum registro para este usuário.') => criar('p', { classe: 'mensagem-vazia', texto });

/** Tabela simples. colunas: [{titulo, numero}], linhas: arrays de texto/Node. */
function tabela(colunas, linhas) {
  if (!linhas.length) return vazio();
  const cabecalho = criar('tr', {}, colunas.map((c) => criar('th', { classe: c.numero ? 'numero' : '', texto: c.titulo, attrs: { scope: 'col' } })));
  const corpo = linhas.map((linha) => criar('tr', {}, linha.map((celula, i) => criar('td', { classe: colunas[i].numero ? 'numero' : '' }, celula))));
  return criar('div', { classe: 'tabela-rolagem' }, criar('table', { classe: 'tabela' }, criar('thead', {}, cabecalho), criar('tbody', {}, corpo)));
}

function chips(textos) {
  if (!textos.length) return vazio();
  return criar('ul', { classe: 'chips' }, textos.map((t) => criar('li', { classe: 'chip' }, t)));
}

/** Lista "nome + código" usada em várias seções. */
function listaCodigoNome(itens) {
  if (!itens.length) return vazio();
  return criar('ul', { classe: 'lista-simples' }, itens.map((i) => criar('li', {},
    criar('span', { classe: 'item-texto', texto: i.nome }),
    criar('span', { classe: 'item-codigo', texto: i.codigo }),
  )));
}

function selo(texto, variante = '') {
  return criar('span', { classe: `selo ${variante}`.trim(), texto });
}

function seloNivel(nivel) {
  return selo(estado.dados.niveis[String(nivel)] ?? `Nível ${nivel}`, CLASSE_NIVEL[nivel] ?? '');
}

function bloco(titulo, conteudo, apoio) {
  return criar('section', { classe: 'bloco' },
    criar('h3', { classe: 'bloco-titulo', texto: titulo }),
    apoio ? criar('p', { classe: 'bloco-apoio', texto: apoio }) : null,
    conteudo,
  );
}

/**
 * Seção recolhível (<details>). O corpo é uma função e só é construído na primeira
 * abertura: telas com milhares de itens continuam rápidas.
 */
function secao(titulo, { contagem = null, aberto = false, corpo }) {
  const detalhes = criar('details', { classe: 'secao' });
  const resumo = criar('summary', {}, criar('span', { classe: 'secao-titulo', texto: titulo }));
  if (contagem !== null) resumo.append(selo(fmtNumero(contagem)));
  const area = criar('div', { classe: 'secao-corpo' });
  detalhes.append(resumo, area);

  let montado = false;
  const montar = () => {
    if (montado) return;
    montado = true;
    area.append(corpo());
  };
  detalhes.open = aberto;
  if (aberto) montar();
  detalhes.addEventListener('toggle', () => detalhes.open && montar());
  return detalhes;
}

/** Executa `funcao` só depois de o usuário parar de digitar. */
function atrasar(funcao, ms = 200) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => funcao(...args), ms);
  };
}


/* ============================================================================
 * 4. CARREGAMENTO E DECIFRAGEM DOS DADOS
 * ========================================================================== */

const base64ParaBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Baixa o arquivo criptografado e confere se tem a forma esperada. */
async function carregarEnvelope() {
  let resposta;
  try {
    resposta = await fetch(CONFIG.URL_DADOS, CONFIG.OPCOES_FETCH);
  } catch {
    throw new ErroPainel('rede');
  }
  if (!resposta.ok) throw new ErroPainel(resposta.status === 404 ? 'ausente' : 'http');

  let envelope;
  try {
    envelope = await resposta.json();
  } catch {
    throw new ErroPainel('formato');
  }
  validarEnvelope(envelope);
  return envelope;
}

function validarEnvelope(e) {
  const iteracoes = e?.kdf?.iteracoes;
  const valido =
    e && e.formato === CONFIG.FORMATO_ENVELOPE &&
    e.kdf?.nome === 'PBKDF2-SHA256' && typeof e.kdf.salt === 'string' &&
    Number.isInteger(iteracoes) && iteracoes >= CONFIG.ITERACOES_MIN && iteracoes <= CONFIG.ITERACOES_MAX &&
    e.cifra?.nome === 'AES-256-GCM' && typeof e.cifra.iv === 'string' &&
    e.compressao === 'gzip' && typeof e.dados === 'string';
  if (!valido) throw new ErroPainel('formato');
}

/** Descomprime gzip usando o recurso nativo do navegador. */
async function descomprimir(bytes) {
  const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(fluxo).text();
}

/**
 * Deriva a chave a partir da senha (PBKDF2-SHA256) e decifra (AES-256-GCM).
 * O GCM também autentica: senha errada ou arquivo adulterado falham aqui.
 */
async function decifrar(envelope, senha) {
  if (!globalThis.crypto?.subtle || typeof DecompressionStream === 'undefined') throw new ErroPainel('navegador');

  const codificador = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', codificador.encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const chave = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64ParaBytes(envelope.kdf.salt), iterations: envelope.kdf.iteracoes },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  let comprimido;
  try {
    comprimido = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ParaBytes(envelope.cifra.iv),
        // Parâmetros do cabeçalho ficam "colados" ao conteúdo: se alguém trocá-los, a decifragem falha.
        additionalData: codificador.encode(`${envelope.formato}|${envelope.kdf.iteracoes}`),
      },
      chave,
      base64ParaBytes(envelope.dados),
    );
  } catch {
    throw new ErroPainel('senha');
  }

  let dados;
  try {
    dados = JSON.parse(await descomprimir(comprimido));
  } catch {
    throw new ErroPainel('formato');
  }
  validarDados(dados);
  return dados;
}

function validarDados(d) {
  const valido =
    d && d.versao === CONFIG.VERSAO_DADOS && Array.isArray(d.usuarios) && Array.isArray(d.objetos) &&
    Array.isArray(d.sistemas) && Array.isArray(d.filiais) && Array.isArray(d.grupos) &&
    d.niveis && d.tipos_objeto && d.formularios;
  if (!valido) throw new ErroPainel('formato', 'Os dados têm uma versão que este painel não entende. Atualize o painel e os dados.');
}

/** Mapas de consulta rápida (por código/sigla) montados uma vez após decifrar. */
function montarIndices(dados) {
  return {
    filiais: new Map(dados.filiais.map((f) => [f.codigo, f.nome])),
    sistemas: new Map(dados.sistemas.map((s) => [s.sigla, s])),
    grupos: new Map(dados.grupos.map((g) => [g.id, g])),
  };
}

const nomeFilial = (codigo) => estado.indices.filiais.get(codigo) ?? `Filial ${codigo}`;
const nomeSistema = (sigla) => estado.indices.sistemas.get(sigla)?.nome ?? sigla;


/* ============================================================================
 * 5. TELAS (senha / carregando / erro / painel) E BLOQUEIO
 * ========================================================================== */
const TELAS = ['senha', 'carregando', 'erro', 'painel'];

function mostrarTela(nome, textoCarregando) {
  for (const tela of TELAS) $(`tela-${tela}`).hidden = tela !== nome;
  $('topo-acoes').hidden = nome !== 'painel';
  if (nome === 'carregando') $('texto-carregando').textContent = textoCarregando || 'Carregando…';
  // No celular, focar sozinho abriria o teclado por cima da tela; o usuário toca no campo.
  if (nome === 'senha' && !LAYOUT_CELULAR.matches) $('campo-senha').focus();
}

function mostrarErro(erro, aoTentar) {
  const tipo = erro instanceof ErroPainel ? erro.tipo : 'desconhecido';
  $('titulo-erro').textContent = tipo === 'rede' ? 'Sem conexão' : 'Não foi possível carregar';
  $('texto-erro').textContent = erro instanceof ErroPainel ? erro.message : 'Ocorreu um erro inesperado. Tente novamente.';
  $('btn-tentar').onclick = aoTentar || prepararEnvelope;
  mostrarTela('erro');
}

function mostrarErroSenha(mensagem) {
  const caixa = $('erro-senha');
  caixa.textContent = mensagem || '';
  caixa.hidden = !mensagem;
  $('campo-senha').setAttribute('aria-invalid', mensagem ? 'true' : 'false');
}

/** Descarta os dados decifrados da memória e volta para a tela de senha. */
function bloquear(motivo) {
  estado.dados = null;
  estado.indices = null;
  estado.usuario = null;
  abasRenderizadas.clear();
  clearInterval(estado.temporizadorBloqueio);
  $('lista-usuarios').replaceChildren();
  for (const aba of ABAS) $(`painel-${aba}`).replaceChildren();
  $('detalhe-conteudo').hidden = true;
  $('detalhe-vazio').hidden = false;
  const estavaNoDetalhe = document.body.classList.contains('mostrando-detalhe');
  document.body.classList.remove('mostrando-detalhe');
  if (estavaNoDetalhe && history.state?.detalhe) history.back(); // desfaz o passo de histórico do detalhe
  $('busca').value = '';
  mostrarErroSenha(motivo || '');
  mostrarTela('senha');
}

/** Inicia o vigia de inatividade (os ouvintes de atividade são registrados uma vez, em ligarEventos). */
function vigiarInatividade() {
  clearInterval(estado.temporizadorBloqueio);
  estado.ultimaAtividade = Date.now();
  estado.temporizadorBloqueio = setInterval(() => {
    if (Date.now() - estado.ultimaAtividade > CONFIG.BLOQUEIO_INATIVIDADE_MIN * 60000) {
      bloquear('Bloqueado por inatividade. Digite a senha para continuar.');
    }
  }, 30000);
}


/* ============================================================================
 * 6. LISTA DE USUÁRIOS (busca por nome) E SELEÇÃO
 * ========================================================================== */

function desenharLista() {
  const termo = semAcento($('busca').value.trim());
  const todos = estado.dados.usuarios;
  const visiveis = todos.filter((u) => !termo || semAcento(`${u.nome} ${u.apelido}`).includes(termo));

  $('contagem').textContent = termo
    ? `${fmtNumero(visiveis.length)} de ${fmtNumero(todos.length)} usuários`
    : `${fmtNumero(todos.length)} usuários ativos`;

  const lista = $('lista-usuarios');
  lista.replaceChildren();
  if (!todos.length) {
    lista.append(criar('li', { classe: 'lista-vazia', texto: 'Nenhum usuário ativo encontrado.' }));
    return;
  }
  if (!visiveis.length) {
    lista.append(criar('li', { classe: 'lista-vazia', texto: 'Nenhum usuário encontrado para esta busca.' }));
    return;
  }
  for (const u of visiveis) {
    const botao = criar('button', {
      classe: 'lista-item',
      attrs: { type: 'button', 'data-codigo': u.codigo, 'aria-current': estado.usuario?.codigo === u.codigo ? 'true' : 'false' },
      eventos: { click: () => selecionarUsuario(u.codigo) },
    },
      criar('span', { classe: 'avatar', texto: iniciais(u.nome), attrs: { 'aria-hidden': 'true' } }),
      criar('span', { classe: 'lista-item-textos' },
        criar('span', { classe: 'lista-item-nome', texto: u.nome || u.apelido }),
        criar('span', { classe: 'lista-item-sub', texto: u.perfil || 'Sem perfil definido' }),
      ),
    );
    lista.append(criar('li', {}, botao));
  }
}

function selecionarUsuario(codigo) {
  const usuario = estado.dados.usuarios.find((u) => u.codigo === codigo);
  if (!usuario) return;
  estado.usuario = usuario;
  abasRenderizadas.clear();

  for (const botao of $('lista-usuarios').querySelectorAll('.lista-item')) {
    botao.setAttribute('aria-current', botao.dataset.codigo === String(codigo) ? 'true' : 'false');
  }

  $('det-avatar').textContent = iniciais(usuario.nome);
  $('det-nome').textContent = usuario.nome || usuario.apelido;
  $('det-sub').textContent = `${usuario.perfil || 'Sem perfil definido'} · apelido ${usuario.apelido}`;
  $('det-status').textContent = usuario.situacao;
  $('detalhe-vazio').hidden = true;
  $('detalhe-conteudo').hidden = false;

  ativarAba(estado.aba);
  abrirDetalheNoCelular();
  $('det-nome').focus({ preventScroll: true }); // tira o foco da busca (fecha o teclado do celular)
}

/*
 * Celular: lista e detalhe são "telas" separadas. Abrir o detalhe registra um passo no histórico,
 * então o botão/gesto "voltar" do aparelho volta para a lista (em vez de sair do site), na mesma
 * posição em que o usuário estava.
 */
function abrirDetalheNoCelular() {
  if (!LAYOUT_CELULAR.matches) return;
  if (!document.body.classList.contains('mostrando-detalhe')) estado.rolagemLista = window.scrollY;
  if (!history.state?.detalhe) history.pushState({ detalhe: true }, '');
  document.body.classList.add('mostrando-detalhe');
  window.scrollTo({ top: 0 });
}

function mostrarListaNoCelular() {
  if (!document.body.classList.contains('mostrando-detalhe')) return;
  document.body.classList.remove('mostrando-detalhe');
  window.scrollTo({ top: estado.rolagemLista || 0 });
}

function voltarParaLista() {
  // history.back() dispara "popstate", que chama mostrarListaNoCelular.
  if (history.state?.detalhe) history.back();
  else mostrarListaNoCelular();
}

/** Botão voltar/avançar do navegador. */
function aoMudarHistorico() {
  if (history.state?.detalhe && estado.usuario && LAYOUT_CELULAR.matches) {
    document.body.classList.add('mostrando-detalhe');
    window.scrollTo({ top: 0 });
  } else {
    mostrarListaNoCelular();
  }
}

/** Ao trocar de aba num conteúdo longo, volta ao início da aba (as abas ficam fixas no topo no celular). */
function irParaInicioDasAbas() {
  const cabecalho = document.querySelector('.detalhe-cabecalho').getBoundingClientRect();
  const inicio = cabecalho.bottom + window.scrollY;
  if (window.scrollY > inicio) window.scrollTo({ top: inicio });
}


/* ============================================================================
 * 7. ABAS (padrão WAI-ARIA: setas, Home e End)
 * ========================================================================== */

function ativarAba(nome) {
  estado.aba = nome;
  for (const aba of ABAS) {
    const selecionada = aba === nome;
    const botao = $(`aba-${aba}`);
    botao.setAttribute('aria-selected', String(selecionada));
    botao.tabIndex = selecionada ? 0 : -1;
    $(`painel-${aba}`).hidden = !selecionada;
  }
  // Cada aba só é desenhada quando aberta (e redesenhada ao trocar de usuário).
  if (!abasRenderizadas.has(nome)) {
    abasRenderizadas.add(nome);
    $(`painel-${nome}`).replaceChildren(renderizadores[nome](estado.usuario));
  }
}

function aoTeclarNasAbas(evento) {
  const atual = ABAS.indexOf(estado.aba);
  const destino = { ArrowRight: (atual + 1) % ABAS.length, ArrowLeft: (atual - 1 + ABAS.length) % ABAS.length, Home: 0, End: ABAS.length - 1 }[evento.key];
  if (destino === undefined) return;
  evento.preventDefault();
  ativarAba(ABAS[destino]);
  $(`aba-${ABAS[destino]}`).focus();
}


/* ============================================================================
 * 8. CONTEÚDO DAS ABAS
 * ========================================================================== */

const objeto = (indice) => {
  const [form, sistema, nome, tipo, descricao] = estado.dados.objetos[indice];
  return { form, sistema, codigo: nome, tipo, nome: descricao || nome };
};

/** Nome da tela: "Emissão de notas fiscais (EP095)" ou "Tela AT045A" quando o ERP não informa o nome. */
function nomeTela(form) {
  const codigo = String(form).replace(/^TovF_/, '');
  const amigavel = estado.dados.formularios[form];
  return amigavel ? `${amigavel} (${codigo})` : `Tela ${codigo}`;
}

/** Pares [índice do objeto, nível] viram itens prontos para exibir e buscar. */
function itensDeObjetos(pares) {
  return pares.map(([indice, nivel]) => {
    const o = objeto(indice);
    return { ...o, nivel, busca: semAcento(`${o.nome} ${o.codigo} ${o.form} ${estado.dados.formularios[o.form] ?? ''}`) };
  });
}

/* ---- Aba 1: Dados gerais ---- */
renderizadores.gerais = (u) => {
  const restricoesDeTela = u.campos_restritos.filter(([, nivel]) => NIVEIS_RESTRICAO.has(nivel)).length;
  const indicador = (valor, rotulo) => criar('div', { classe: 'indicador' },
    criar('span', { classe: 'indicador-valor', texto: fmtNumero(valor) }),
    criar('span', { classe: 'indicador-rotulo', texto: rotulo }),
  );
  const linha = (rotulo, valor) => [criar('dt', { texto: rotulo }), criar('dd', {}, valor)];

  return criar('div', {},
    criar('div', { classe: 'grade-resumo' },
      indicador(u.grupos_acesso.length, 'Grupos de acesso'),
      indicador(u.sistemas.length, 'Sistemas'),
      indicador(u.filiais.length, 'Filiais'),
      indicador(u.telas_liberadas.length, 'Telas liberadas'),
      indicador(restricoesDeTela, 'Itens bloqueados'),
    ),
    criar('dl', { classe: 'definicoes' },
      linha('Nome completo', ouTraco(u.nome)),
      linha('Apelido no ERP', ouTraco(u.apelido)),
      linha('Código no ERP', String(u.codigo)),
      linha('Status', selo(u.situacao, 'selo-ok')),
      linha('Perfil', ouTraco(u.perfil)),
      linha('Filial padrão', u.filial_padrao == null ? '—' : nomeFilial(u.filial_padrao)),
      linha('Cargo', u.cargos.length ? u.cargos.map((c) => c.nome).join(', ') : '—'),
    ),
  );
};

/* ---- Aba 2: Permissões ---- */

/** Grupos de acesso agrupados por sistema (tabela Sistema x Grupo). */
function tabelaGrupos(u) {
  const linhas = u.grupos_acesso
    .map((id) => estado.indices.grupos.get(id))
    .filter(Boolean)
    .sort((a, b) => comparar(nomeSistema(a.sistema), nomeSistema(b.sistema)) || comparar(a.nome, b.nome))
    .map((g) => [nomeSistema(g.sistema), g.nome]);
  return tabela([{ titulo: 'Sistema' }, { titulo: 'Grupo de acesso' }], linhas);
}

renderizadores.permissoes = (u) => {
  const rotuloPermissao = (valor) => (valor === true ? selo('Sim', 'selo-ok') : valor === false ? selo('Não') : selo('Não definido', 'selo-aviso'));
  const concedidas = u.permissoes_pontuais.filter(([, valor]) => valor === true).length;

  return criar('div', {},
    bloco('Perfil', u.perfil ? chips([u.perfil]) : vazio('Este usuário não tem perfil definido no ERP.'),
      'O perfil agrupa o conjunto padrão de permissões da função.'),
    bloco('Permissões individuais', criar('ul', { classe: 'grade-permissoes' },
      u.permissoes_pontuais.map(([nome, valor]) => criar('li', { classe: 'permissao' }, criar('span', { texto: nome }), rotuloPermissao(valor)))),
      `${fmtNumero(concedidas)} de ${fmtNumero(u.permissoes_pontuais.length)} concedidas no cadastro do usuário.`),
    bloco('Grupos de acesso por sistema', tabelaGrupos(u),
      'Cada grupo define quais telas e funções o usuário vê em um sistema do ERP.'),
  );
};

/* ---- Aba 3: Restrições ---- */

/**
 * Lista com filtro (texto + nível) e itens agrupados em seções recolhíveis.
 * Usada nas duas listas grandes de restrições de tela.
 */
function listaRestritos(itens, rotuloDoGrupo) {
  const busca = criar('input', { classe: 'campo', attrs: { type: 'search', placeholder: 'Filtrar por nome ou código…', 'aria-label': 'Filtrar por nome ou código', autocomplete: 'off' } });
  const nivel = criar('select', { classe: 'campo', attrs: { 'aria-label': 'Filtrar por nível' } },
    Object.entries(FILTROS_NIVEL).map(([valor, f]) => criar('option', { texto: f.rotulo, attrs: { value: valor } })));
  const resumo = criar('p', { classe: 'bloco-apoio', attrs: { 'aria-live': 'polite' } });
  const resultado = criar('div');

  const desenhar = () => {
    const termo = semAcento(busca.value.trim());
    const niveis = FILTROS_NIVEL[nivel.value].niveis;
    const filtrados = itens.filter((i) => (!niveis || niveis.has(i.nivel)) && (!termo || i.busca.includes(termo)));
    resumo.textContent = `${fmtNumero(filtrados.length)} de ${fmtNumero(itens.length)} itens`;
    resultado.replaceChildren();
    if (!filtrados.length) {
      resultado.append(vazio('Nenhum item encontrado com este filtro.'));
      return;
    }
    const grupos = new Map();
    for (const item of filtrados) {
      const rotulo = rotuloDoGrupo(item);
      if (!grupos.has(rotulo)) grupos.set(rotulo, []);
      grupos.get(rotulo).push(item);
    }
    const ordenados = [...grupos.entries()].sort((a, b) => comparar(a[0], b[0]));
    for (const [rotulo, lista] of ordenados) {
      resultado.append(secao(rotulo, { contagem: lista.length, aberto: Boolean(termo) && ordenados.length <= 4, corpo: () => listaPaginada(lista) }));
    }
  };

  busca.addEventListener('input', atrasar(desenhar));
  nivel.addEventListener('change', desenhar);
  desenhar();
  return criar('div', {}, criar('div', { classe: 'barra-filtros' }, busca, nivel), resumo, resultado);
}

/** Mostra os itens em lotes, com botão "Mostrar mais". */
function listaPaginada(itens) {
  const ul = criar('ul', { classe: 'lista-simples' });
  const raiz = criar('div', {}, ul);
  let mostrados = 0;
  const maisUm = () => {
    for (const i of itens.slice(mostrados, mostrados + CONFIG.TAMANHO_LOTE)) {
      const tipo = estado.dados.tipos_objeto[i.tipo];
      ul.append(criar('li', {},
        seloNivel(i.nivel),
        criar('span', { classe: 'item-texto', texto: tipo && i.tipo !== 'T' ? `${i.nome} · ${tipo}` : i.nome }),
        criar('span', { classe: 'item-codigo', texto: i.codigo }),
      ));
    }
    mostrados = Math.min(itens.length, mostrados + CONFIG.TAMANHO_LOTE);
    botao.hidden = mostrados >= itens.length;
    botao.textContent = `Mostrar mais (${fmtNumero(itens.length - mostrados)} restantes)`;
  };
  const botao = criar('button', { classe: 'botao botao-secundario mais', attrs: { type: 'button' }, eventos: { click: maisUm } });
  raiz.append(botao);
  maisUm();
  return raiz;
}

function restricoesDeNegocio(u) {
  const negocio = u.restricoes_negocio;
  const partes = [];
  if (negocio.grupos.length) {
    partes.push(bloco('Grupos de restrição', chips(negocio.grupos.map((g) => `${g.nome} · ${nomeFilial(g.filial)}`))));
  }
  partes.push(bloco('Restrições aplicadas', tabela(
    [{ titulo: 'Restrição' }, { titulo: 'Categoria' }, { titulo: 'Sistema' }, { titulo: 'Origem (grupos)' }],
    negocio.itens.map((i) => [i.descricao, ouTraco(i.categoria), ouTraco(i.sistema), i.grupos.join(', ')]),
  )));
  if (negocio.limites.length) {
    partes.push(bloco('Limites individuais', tabela(
      [{ titulo: 'Restrição' }, { titulo: 'Valor inicial', numero: true }, { titulo: 'Valor final', numero: true }],
      negocio.limites.map((l) => [l.descricao, ouTraco(l.valor_inicial), ouTraco(l.valor_final)]),
    )));
  }
  return criar('div', {}, partes);
}

renderizadores.restricoes = (u) => {
  const filialDe = (codigo) => (codigo == null ? '—' : nomeFilial(codigo));
  const telas = itensDeObjetos(u.campos_restritos.filter(([i]) => ['T', 'M'].includes(estado.dados.objetos[i][3])));
  const campos = itensDeObjetos(u.campos_restritos.filter(([i]) => ['C', 'A'].includes(estado.dados.objetos[i][3])));
  const rotuloCampo = (i) => `${nomeTela(i.form)} — ${nomeSistema(i.sistema)}`;
  const quantasRestringem = (itens) => itens.filter((i) => NIVEIS_RESTRICAO.has(i.nivel)).length;

  // Ordem: o que o usuário "pode usar" (vínculos do cadastro) e, por fim, as restrições de tela.
  const secoes = [
    ['Sistemas', u.sistemas.length, () => chips(u.sistemas.map(nomeSistema).sort(comparar))],
    ['Filiais', u.filiais.length, () => chips(u.filiais.map((c) => (c === u.filial_padrao ? `${nomeFilial(c)} (padrão)` : nomeFilial(c))).sort(comparar))],
    ['Permissões de acesso ao sistema', u.grupos_acesso.length, () => tabelaGrupos(u)],
    ['Vendedores relacionados', u.vendedores.length, () => tabela(
      [{ titulo: 'Filial' }, { titulo: 'Código', numero: true }, { titulo: 'Vendedor' }],
      u.vendedores.map((v) => [filialDe(v.filial), String(v.codigo), v.nome]))],
    ['Consultores relacionados', u.consultores.length, () => tabela(
      [{ titulo: 'Tipo' }, { titulo: 'Filial' }, { titulo: 'Código', numero: true }, { titulo: 'Nome' }],
      u.consultores.map((c) => [c.tipo, filialDe(c.filial), String(c.codigo), c.nome]))],
    ['Desconto especial', u.descontos.length, () => tabela(
      [{ titulo: 'Centro de consumo' }, { titulo: 'Grupo' }, { titulo: 'Subgrupo' }, { titulo: 'Marca' },
        { titulo: 'À vista', numero: true }, { titulo: 'A prazo', numero: true }, { titulo: 'Promo à vista', numero: true }, { titulo: 'Promo a prazo', numero: true }],
      u.descontos.map((d) => [ouTraco(d.centro_consumo), ouTraco(d.grupo), ouTraco(d.subgrupo), ouTraco(d.marca),
        fmtPercentual(d.perc_vista), fmtPercentual(d.perc_prazo), fmtPercentual(d.perc_vista_promo), fmtPercentual(d.perc_prazo_promo)]))],
    ['Condição de pagamento', u.condicoes_pagamento.length, () => listaCodigoNome(u.condicoes_pagamento.map((c) => ({ nome: c.nome, codigo: String(c.codigo) })))],
    ['Operação fiscal', u.operacoes_fiscais.length, () => listaCodigoNome(u.operacoes_fiscais)],
    ['Tipo de título', u.tipos_titulo.length, () => listaCodigoNome(u.tipos_titulo.map((t) => ({ nome: t.nome, codigo: String(t.codigo) })))],
    ['Pedido de compras', u.pedidos_compra.length, () => tabela(
      [{ titulo: 'Tipo de pedido' }, { titulo: 'Departamento' }, { titulo: 'Valor máximo', numero: true }],
      u.pedidos_compra.map((p) => [ouTraco(p.tipo_pedido), ouTraco(p.departamento), fmtMoeda(p.valor_maximo)]))],
    ['Contas contábeis', u.contas_contabeis.length, () => listaCodigoNome(u.contas_contabeis.map((c) => ({ nome: c.nome, codigo: c.conta })))],
    ['Cargo', u.cargos.length, () => chips(u.cargos.map((c) => c.nome))],
    ['Restrições de negócio', u.restricoes_negocio.itens.length, () => restricoesDeNegocio(u)],
    ['Exceções individuais', u.excecoes.length, () => (u.excecoes.length
      ? tabela([{ titulo: 'Item' }, { titulo: 'Tela' }, { titulo: 'Sistema' }, { titulo: 'Nível' }],
        itensDeObjetos(u.excecoes).map((i) => [`${i.nome} (${i.codigo})`, nomeTela(i.form), nomeSistema(i.sistema), seloNivel(i.nivel)]))
      : vazio('Este usuário não tem ajustes individuais além dos grupos.'))],
    ['Telas e menus restritos', quantasRestringem(telas), () => listaRestritos(telas, (i) => nomeSistema(i.sistema))],
    ['Campos, botões e abas restritos', quantasRestringem(campos), () => listaRestritos(campos, rotuloCampo)],
  ];

  return criar('div', {},
    criar('p', { classe: 'bloco-apoio', texto: 'Cada seção mostra um tipo de limite aplicado a este usuário. Clique para abrir.' }),
    secoes.map(([titulo, contagem, corpo], posicao) => secao(titulo, { contagem, corpo, aberto: posicao < 2 && contagem > 0 })),
    criar('p', { classe: 'nota', texto: 'Nível de restrição de tela: "Invisível" esconde o item e "Desabilitado" o mostra sem permitir uso. "Habilitado" e "Visível" são liberações explícitas. Quando o usuário está em mais de um grupo, vale o nível mais restritivo; ajustes individuais substituem o do grupo.' }),
  );
};

/* ---- Aba 4: Acessos ---- */

renderizadores.acessos = (u) => {
  const todas = u.telas_liberadas.map((i) => objeto(i));
  const busca = criar('input', { classe: 'campo', attrs: { type: 'search', placeholder: 'Buscar tela ou relatório…', 'aria-label': 'Buscar tela ou relatório', autocomplete: 'off' } });
  const resumo = criar('p', { classe: 'bloco-apoio', attrs: { 'aria-live': 'polite' } });
  const resultado = criar('div');

  const desenhar = () => {
    const termo = semAcento(busca.value.trim());
    resultado.replaceChildren();
    let totalMostrado = 0;

    const sistemas = estado.dados.sistemas
      .filter((s) => s.telas_total > 0)
      .map((s) => ({ s, liberado: s.codigo == null || u.sistemas.includes(s.sigla) }))
      .sort((a, b) => Number(b.liberado) - Number(a.liberado) || comparar(a.s.nome, b.s.nome));

    for (const { s, liberado } of sistemas) {
      const doSistema = todas.filter((t) => t.sistema === s.sigla);
      const telas = doSistema
        .filter((t) => !termo || semAcento(`${t.nome} ${t.codigo}`).includes(termo))
        .sort((a, b) => comparar(a.nome, b.nome));
      if (termo && !telas.length) continue;
      totalMostrado += telas.length;

      const titulo = `${s.nome}`;
      const detalhe = secao(titulo, {
        aberto: Boolean(termo),
        corpo: () => (liberado
          ? (telas.length ? listaTelas(telas) : vazio('Nenhuma tela liberada neste sistema.'))
          : vazio('O usuário não possui este sistema no cadastro, então nenhuma tela dele fica liberada.')),
      });
      const resumoSecao = detalhe.querySelector('summary');
      resumoSecao.append(
        selo(liberado ? 'Sistema liberado' : 'Sem acesso', liberado ? 'selo-ok' : 'selo-erro'),
        selo(`${fmtNumero(doSistema.length)} de ${fmtNumero(s.telas_total)} telas`, 'selo-info'),
      );
      resultado.append(detalhe);
    }
    resumo.textContent = termo ? `${fmtNumero(totalMostrado)} telas encontradas.` : `${fmtNumero(todas.length)} telas e relatórios liberados em ${fmtNumero(u.sistemas.length)} sistemas.`;
    if (termo && !totalMostrado) resultado.append(vazio('Nenhuma tela liberada encontrada com esta busca.'));
  };

  busca.addEventListener('input', atrasar(desenhar));
  desenhar();
  return criar('div', {},
    criar('div', { classe: 'barra-filtros' }, busca),
    resumo,
    resultado,
    criar('p', { classe: 'nota', texto: 'Uma tela aparece como liberada quando o usuário tem o sistema dela no cadastro e nenhum grupo a deixa invisível ou desabilitada (ajustes individuais prevalecem). Itens de menu que só agrupam telas não são contados.' }),
  );
};

function listaTelas(telas) {
  const ul = criar('ul', { classe: 'lista-simples' });
  const raiz = criar('div', {}, ul);
  let mostradas = 0;
  const maisUm = () => {
    for (const t of telas.slice(mostradas, mostradas + CONFIG.TAMANHO_LOTE)) {
      ul.append(criar('li', {},
        criar('span', { classe: 'item-texto', texto: t.nome }),
        criar('span', { classe: 'item-codigo', texto: t.codigo.replace(/^mi_/i, '') }),
      ));
    }
    mostradas = Math.min(telas.length, mostradas + CONFIG.TAMANHO_LOTE);
    botao.hidden = mostradas >= telas.length;
    botao.textContent = `Mostrar mais (${fmtNumero(telas.length - mostradas)} restantes)`;
  };
  const botao = criar('button', { classe: 'botao botao-secundario mais', attrs: { type: 'button' }, eventos: { click: maisUm } });
  raiz.append(botao);
  maisUm();
  return raiz;
}


/* ============================================================================
 * 9. FLUXO PRINCIPAL: carregar -> senha -> decifrar -> painel
 * ========================================================================== */

async function prepararEnvelope() {
  mostrarTela('carregando', 'Carregando dados…');
  try {
    estado.envelope = await carregarEnvelope();
    mostrarTela('senha');
  } catch (erro) {
    mostrarErro(erro, prepararEnvelope);
  }
}

async function aoEnviarSenha(evento) {
  evento.preventDefault();
  const campo = $('campo-senha');
  const senha = campo.value;
  if (!senha) {
    mostrarErroSenha('Digite a senha para continuar.');
    campo.focus();
    return;
  }
  mostrarErroSenha('');
  campo.value = ''; // a senha não fica no campo enquanto decifra
  mostrarTela('carregando', 'Decifrando dados…');

  try {
    estado.dados = await decifrar(estado.envelope, senha);
  } catch (erro) {
    if (erro instanceof ErroPainel && erro.tipo === 'senha') {
      mostrarErroSenha(erro.message);
      mostrarTela('senha');
    } else {
      mostrarErro(erro, () => { mostrarErroSenha(''); mostrarTela('senha'); });
    }
    return;
  }
  abrirPainel();
}

function abrirPainel() {
  estado.indices = montarIndices(estado.dados);
  estado.usuario = null;
  $('info-atualizacao').textContent = `Dados de ${fmtDataHora(estado.dados.gerado_em)}`;
  $('busca').value = '';
  $('detalhe-conteudo').hidden = true;
  $('detalhe-vazio').hidden = false;
  desenharLista();
  mostrarTela('painel');
  vigiarInatividade();
  // Só no computador: no celular o teclado abriria por cima da lista.
  if (!LAYOUT_CELULAR.matches) $('busca').focus({ preventScroll: true });
}

function alternarVisibilidadeSenha() {
  const campo = $('campo-senha');
  const mostrar = campo.type === 'password';
  campo.type = mostrar ? 'text' : 'password';
  $('btn-mostrar-senha').textContent = mostrar ? 'Ocultar' : 'Mostrar';
  $('btn-mostrar-senha').setAttribute('aria-pressed', String(mostrar));
}

function ligarEventos() {
  const registrarAtividade = () => { estado.ultimaAtividade = Date.now(); };
  for (const evento of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(evento, registrarAtividade, { passive: true });

  $('form-senha').addEventListener('submit', aoEnviarSenha);
  $('btn-mostrar-senha').addEventListener('click', alternarVisibilidadeSenha);
  $('btn-bloquear').addEventListener('click', () => bloquear());
  $('btn-voltar').addEventListener('click', voltarParaLista);
  $('busca').addEventListener('input', atrasar(() => estado.dados && desenharLista()));
  // Tecla "buscar/ir" do teclado do celular: fecha o teclado para mostrar o resultado.
  $('busca').addEventListener('keydown', (evento) => evento.key === 'Enter' && evento.target.blur());
  for (const aba of ABAS) {
    $(`aba-${aba}`).addEventListener('click', () => {
      if (!estado.usuario) return;
      ativarAba(aba);
      irParaInicioDasAbas();
    });
    $(`aba-${aba}`).addEventListener('keydown', aoTeclarNasAbas);
  }
  window.addEventListener('popstate', aoMudarHistorico);
}

// Um recarregamento pode manter o estado de "detalhe" no histórico, mas a página volta bloqueada.
if (history.state?.detalhe) history.replaceState(null, '');
history.scrollRestoration = 'manual'; // quem restaura a posição da lista é o próprio painel

ligarEventos();
prepararEnvelope();
