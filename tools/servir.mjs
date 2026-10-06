#!/usr/bin/env node
// Servidor estático local para testar o painel antes de publicar (sem dependências).
//
//   node tools/servir.mjs [porta] [pasta]
//
// Abre só em 127.0.0.1. Necessário porque o navegador não deixa uma página aberta como
// arquivo (file://) baixar o data/usuarios.enc.json.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const raizPadrao = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const porta = Number(process.argv[2] || 8080);
const raiz = resolve(process.argv[3] || raizPadrao);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (requisicao, resposta) => {
  try {
    const caminhoUrl = decodeURIComponent(new URL(requisicao.url, 'http://localhost').pathname);
    const relativo = normalize(caminhoUrl === '/' ? '/index.html' : caminhoUrl);
    const arquivo = join(raiz, relativo);
    // Barra qualquer tentativa de sair da pasta (../).
    if (arquivo !== raiz && !arquivo.startsWith(raiz + sep)) throw Object.assign(new Error('fora da raiz'), { code: 'ENOENT' });
    const conteudo = await readFile(arquivo);
    resposta.writeHead(200, { 'Content-Type': TIPOS[extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    resposta.end(conteudo);
  } catch (erro) {
    resposta.writeHead(erro.code === 'ENOENT' || erro.code === 'EISDIR' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    resposta.end(erro.code === 'ENOENT' || erro.code === 'EISDIR' ? 'Não encontrado' : 'Erro interno');
  }
}).listen(porta, '127.0.0.1', () => {
  console.log(`Painel em http://127.0.0.1:${porta}/  (pasta: ${raiz})  — Ctrl+C para parar`);
});
