// Criptografia do arquivo de dados do painel.
//
// Formato (o mesmo que o script.js decifra no navegador):
//   JSON -> gzip -> AES-256-GCM, com a chave derivada da senha por PBKDF2-SHA256.
//   Os parâmetros do cabeçalho entram como "dados adicionais autenticados" (AAD): se
//   alguém alterar formato ou iterações, a decifragem falha.
//
// Usa o WebCrypto do Node (webcrypto.subtle), a mesma API do navegador, para garantir
// que o arquivo gerado aqui é decifrável lá.

import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, webcrypto } from 'node:crypto';

export const FORMATO = 'painel-permissoes/1';
export const ITERACOES_PADRAO = 600000; // recomendação atual da OWASP para PBKDF2-SHA256
export const TAMANHO_MINIMO_SENHA = 14;
export const TAMANHO_MINIMO_SENHA_FILIAL = 6; // painéis por filial: mínimo reduzido, escolha consciente do responsável

const { subtle } = webcrypto;
const codificador = new TextEncoder();

const paraBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const deBase64 = (texto) => new Uint8Array(Buffer.from(texto, 'base64'));
const aad = (iteracoes) => codificador.encode(`${FORMATO}|${iteracoes}`);

async function derivarChave(senha, salt, iteracoes, usos) {
  // NFKC: a mesma normalização do navegador, para acentos/teclados diferentes darem a mesma chave.
  const material = await subtle.importKey('raw', codificador.encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteracoes },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usos,
  );
}

/** Devolve o problema da senha (texto) ou null se ela for aceitável. */
export function problemaNaSenha(senha, minimo = TAMANHO_MINIMO_SENHA) {
  if (senha.length < minimo) {
    return `A senha precisa ter pelo menos ${minimo} caracteres. Dica: use uma frase com 4 ou mais palavras.`;
  }
  if (new Set(senha).size < 6) return 'A senha tem caracteres repetidos demais.';
  if (/^\d+$/.test(senha)) return 'A senha não pode ser só números.';
  return null;
}

/** Cifra um texto JSON e devolve o envelope (objeto) que vai para data/usuarios.enc.json. */
export async function cifrar(textoJson, senha, { iteracoes = ITERACOES_PADRAO, geradoEm = null } = {}) {
  const salt = randomBytes(16);
  const iv = randomBytes(12); // GCM: um IV novo e aleatório a cada cifragem
  const chave = await derivarChave(senha, salt, iteracoes, ['encrypt']);
  const comprimido = gzipSync(Buffer.from(textoJson, 'utf8'), { level: 9 });
  const cifrado = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(iteracoes) }, chave, comprimido));

  return {
    formato: FORMATO,
    gerado_em: geradoEm,
    kdf: { nome: 'PBKDF2-SHA256', iteracoes, salt: paraBase64(salt) },
    cifra: { nome: 'AES-256-GCM', iv: paraBase64(iv) },
    compressao: 'gzip',
    dados: paraBase64(cifrado),
  };
}

/** Decifra um envelope e devolve o texto JSON. Lança erro se a senha estiver errada ou o arquivo adulterado. */
export async function decifrar(envelope, senha) {
  if (envelope?.formato !== FORMATO) throw new Error('Formato de envelope desconhecido.');
  const { iteracoes, salt } = envelope.kdf;
  const chave = await derivarChave(senha, deBase64(salt), iteracoes, ['decrypt']);
  const comprimido = await subtle.decrypt(
    { name: 'AES-GCM', iv: deBase64(envelope.cifra.iv), additionalData: aad(iteracoes) },
    chave,
    deBase64(envelope.dados),
  );
  return gunzipSync(Buffer.from(comprimido)).toString('utf8');
}
