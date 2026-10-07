#!/usr/bin/env node
// Atualiza o arquivo de dados do painel: lê os usuários ativos do ERP pela API
// (scripts/exportar_usuarios_erp.py, somente leitura), criptografa e grava
// data/usuarios.enc.json.
//
// Uso:
//   node tools/atualizar-dados.mjs [--api-dir <pasta da API>] [--python <python.exe>] [--saida <arquivo>]
//
// A senha é pedida no terminal (sem eco). Para automação, pode vir da variável de
// ambiente PAINEL_SENHA (menos seguro: fica visível para outros processos da máquina).
//
// O JSON em claro (nomes e permissões de funcionários) passa só pela memória deste
// processo: nunca é gravado em disco nem impresso.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cifrar, decifrar, problemaNaSenha, ITERACOES_PADRAO, TAMANHO_MINIMO_SENHA_FILIAL } from './cripto.mjs';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Por padrão, a API é a pasta "api-tecinco-bi-evoluido" ao lado deste projeto (mesma pasta pai).
const API_PADRAO = resolve(RAIZ, '..', 'api-tecinco-bi-evoluido');

function lerArgumentos(argv) {
  const opcoes = { apiDir: process.env.API_DIR || API_PADRAO, python: null, saida: join(RAIZ, 'data', 'usuarios.enc.json'), filiais: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, valor] = [argv[i], argv[i + 1]];
    if (chave === '--api-dir') { opcoes.apiDir = resolve(valor); i += 1; }
    else if (chave === '--python') { opcoes.python = resolve(valor); i += 1; }
    else if (chave === '--saida') { opcoes.saida = resolve(valor); i += 1; }
    else if (chave === '--filiais') opcoes.filiais = true;
    else if (chave === '--ajuda' || chave === '-h') {
      console.log('Uso: node tools/atualizar-dados.mjs [--api-dir <pasta>] [--python <python.exe>] [--saida <arquivo>] [--filiais]');
      process.exit(0);
    } else throw new Error(`Argumento desconhecido: ${chave}`);
  }
  opcoes.python ??= join(opcoes.apiDir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return opcoes;
}

/** Roda o exportador da API e devolve o JSON (texto) lido do stdout. Erros e resumo vão para o terminal. */
function exportarDaApi({ apiDir, python }) {
  return new Promise((resolver, rejeitar) => {
    const script = join(apiDir, 'scripts', 'exportar_usuarios_erp.py');
    if (!existsSync(python)) return rejeitar(new Error(`Python da API não encontrado: ${python}\nUse --api-dir ou --python.`));
    if (!existsSync(script)) return rejeitar(new Error(`Exportador não encontrado: ${script}`));

    const filho = spawn(python, [script], { cwd: apiDir, stdio: ['ignore', 'pipe', 'inherit'] });
    const pedacos = [];
    filho.stdout.on('data', (p) => pedacos.push(p));
    filho.on('error', rejeitar);
    filho.on('close', (codigo) => {
      if (codigo !== 0) return rejeitar(new Error(`O exportador terminou com erro (código ${codigo}).`));
      resolver(Buffer.concat(pedacos).toString('utf8'));
    });
  });
}

/** Lê uma linha do terminal sem mostrar o que é digitado (aceita colar). */
function perguntarSenha(pergunta) {
  return new Promise((resolver, rejeitar) => {
    if (!process.stdin.isTTY) return rejeitar(new Error('Sem terminal interativo. Defina a variável PAINEL_SENHA ou rode em um terminal.'));
    process.stdout.write(pergunta);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let senha = '';
    const terminar = (resultado, erro) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', aoReceber);
      process.stdout.write('\n');
      if (erro) rejeitar(erro); else resolver(resultado);
    };
    const aoReceber = (texto) => {
      for (const caractere of texto) {
        if (caractere === '\r' || caractere === '\n') return terminar(senha);
        if (caractere === '\u0003') return terminar(null, new Error('Cancelado.'));
        if (caractere === '\u007f' || caractere === '\b') senha = senha.slice(0, -1);
        else senha += caractere;
      }
    };
    stdin.on('data', aoReceber);
  });
}

async function obterSenha(minimo) {
  if (process.env.PAINEL_SENHA) {
    const problema = problemaNaSenha(process.env.PAINEL_SENHA, minimo);
    if (problema) throw new Error(`PAINEL_SENHA inválida. ${problema}`);
    return process.env.PAINEL_SENHA;
  }
  console.log('\nEscolha a senha que será pedida para abrir o painel (guarde-a em local seguro).');
  const senha = await perguntarSenha('Senha: ');
  const problema = problemaNaSenha(senha, minimo);
  if (problema) throw new Error(problema);
  if (senha !== (await perguntarSenha('Repita a senha: '))) throw new Error('As senhas não conferem.');
  return senha;
}

/** Grava o envelope de forma atômica (nunca fica um arquivo pela metade). */
function gravar(arquivo, envelope) {
  mkdirSync(dirname(arquivo), { recursive: true });
  const temporario = `${arquivo}.tmp`;
  writeFileSync(temporario, JSON.stringify(envelope), 'utf8');
  renameSync(temporario, arquivo);
}

/** Um arquivo cifrado por filial, só com os usuários que têm acesso a ela (painel: ?filial=<código>). */
async function gerarPorFilial(dados, senha, pasta) {
  let total = 0;
  for (const filial of dados.filiais) {
    const usuarios = dados.usuarios.filter((u) => u.filiais.includes(filial.codigo));
    if (!usuarios.length) continue;
    const texto = JSON.stringify({ ...dados, usuarios, filial_painel: filial.codigo });
    const envelope = await cifrar(texto, senha, { iteracoes: ITERACOES_PADRAO, geradoEm: dados.gerado_em });
    const conferido = JSON.parse(await decifrar(envelope, senha));
    if (conferido.usuarios.length !== usuarios.length) throw new Error(`Falha na conferência da filial ${filial.codigo}; nada foi gravado.`);
    const arquivo = join(pasta, `filial-${filial.codigo}.enc.json`);
    gravar(arquivo, envelope);
    console.log(`  ${arquivo} · ${filial.nome} · ${usuarios.length} usuários · ${Math.round(statSync(arquivo).size / 1024)} KB`);
    total += 1;
  }
  return total;
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2));

  console.log('Lendo usuários ativos do ERP pela API (somente leitura)…');
  const textoJson = await exportarDaApi(opcoes);
  const dados = JSON.parse(textoJson);
  if (!Array.isArray(dados.usuarios) || dados.usuarios.length === 0) throw new Error('A API não devolveu nenhum usuário ativo; nada foi gravado.');

  if (opcoes.filiais) {
    const senha = await obterSenha(TAMANHO_MINIMO_SENHA_FILIAL);
    console.log('Criptografando um arquivo por filial…');
    const total = await gerarPorFilial(dados, senha, dirname(opcoes.saida));
    console.log(`
Pronto: ${total} painéis de filial. Acesso pela página com ?filial=<código>.`);
    console.log('Próximo passo: publicar a alteração (git add data && git commit && git push).');
    return;
  }

  const senha = await obterSenha();
  console.log('Criptografando…');
  const envelope = await cifrar(textoJson, senha, { iteracoes: ITERACOES_PADRAO, geradoEm: dados.gerado_em });

  // Confere se o arquivo abre de volta com a mesma senha antes de gravar.
  const conferido = JSON.parse(await decifrar(envelope, senha));
  if (conferido.usuarios.length !== dados.usuarios.length) throw new Error('Falha na conferência da criptografia; nada foi gravado.');

  gravar(opcoes.saida, envelope);

  const kb = Math.round(statSync(opcoes.saida).size / 1024);
  console.log(`\nPronto: ${opcoes.saida}`);
  console.log(`  ${dados.usuarios.length} usuários ativos · ${kb} KB · gerado em ${dados.gerado_em}`);
  console.log('Próximo passo: publicar a alteração (git add data && git commit && git push).');
}

principal().catch((erro) => {
  console.error(`\nERRO: ${erro.message}`);
  process.exit(1);
});
