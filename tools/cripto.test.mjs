// Testes da criptografia: node --test tools/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cifrar, decifrar, problemaNaSenha, FORMATO } from './cripto.mjs';

const SENHA = 'frase de teste com varias palavras';
const JSON_TEXTO = JSON.stringify({ versao: 1, usuarios: [{ codigo: 1, nome: 'Ana Álvares' }] });
// Iterações baixas só para os testes ficarem rápidos; o padrão real é 600.000.
const RAPIDO = { iteracoes: 1000 };

test('cifra e decifra de volta o mesmo texto (com acentos)', async () => {
  const envelope = await cifrar(JSON_TEXTO, SENHA, RAPIDO);
  assert.equal(await decifrar(envelope, SENHA), JSON_TEXTO);
});

test('o envelope não contém o texto original nem a senha', async () => {
  const bruto = JSON.stringify(await cifrar(JSON_TEXTO, SENHA, RAPIDO));
  assert.ok(!bruto.includes('Ana'));
  assert.ok(!bruto.includes(SENHA));
  assert.equal(JSON.parse(bruto).formato, FORMATO);
});

test('senha errada falha', async () => {
  const envelope = await cifrar(JSON_TEXTO, SENHA, RAPIDO);
  await assert.rejects(() => decifrar(envelope, `${SENHA}x`));
});

test('arquivo adulterado falha (GCM autentica)', async () => {
  const envelope = await cifrar(JSON_TEXTO, SENHA, RAPIDO);
  const bytes = Buffer.from(envelope.dados, 'base64');
  bytes[0] ^= 0xff;
  await assert.rejects(() => decifrar({ ...envelope, dados: bytes.toString('base64') }, SENHA));
});

test('alterar as iterações do cabeçalho invalida o arquivo (AAD)', async () => {
  const envelope = await cifrar(JSON_TEXTO, SENHA, RAPIDO);
  await assert.rejects(() => decifrar({ ...envelope, kdf: { ...envelope.kdf, iteracoes: 1001 } }, SENHA));
});

test('cada cifragem usa salt e IV novos', async () => {
  const [a, b] = await Promise.all([cifrar(JSON_TEXTO, SENHA, RAPIDO), cifrar(JSON_TEXTO, SENHA, RAPIDO)]);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cifra.iv, b.cifra.iv);
  assert.notEqual(a.dados, b.dados);
});

test('senhas equivalentes após normalização Unicode (NFKC) abrem o mesmo arquivo', async () => {
  const envelope = await cifrar(JSON_TEXTO, 'ação de teste com frase longa', RAPIDO);
  const decomposta = 'ação de teste com frase longa'.normalize('NFD');
  assert.equal(await decifrar(envelope, decomposta), JSON_TEXTO);
});

test('validação de senha', () => {
  assert.match(problemaNaSenha('curta'), /pelo menos/);
  assert.match(problemaNaSenha('aaaaaaaaaaaaaaaaaa'), /repetidos/);
  assert.match(problemaNaSenha('12345678901234567'), /só números|repetidos/);
  assert.equal(problemaNaSenha(SENHA), null);
});
