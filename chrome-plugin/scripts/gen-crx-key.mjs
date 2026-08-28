// 生成 Chrome 扩展打包用的 RSA 2048 密钥对（无需 openssl）
// 产物：translator-key.pem（私钥，PKCS#8 PEM，Chrome --pack-extension-key 要求的格式）
//       translator-public.der（公钥，SPKI DER 格式）
import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const keyPath = join(root, 'translator-key.pem');
const pubPath = join(root, 'translator-public.der');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001,
});

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pubB64 = pubDer.toString('base64');

// 扩展 ID = SHA-256(公钥 DER) 前 16 字节，每 4 bit 映射到 a-p，共 32 位
const hash = createHash('sha256').update(pubDer).digest();
const id = [...hash.subarray(0, 16)]
  .flatMap((b) => [(b >> 4) & 0x0f, b & 0x0f])
  .map((nibble) => 'abcdefghijklmnop'[nibble])
  .join('');
const crxIdHex = hash.subarray(0, 16).toString('hex');

writeFileSync(keyPath, privPem, { flag: 'wx' }); // 已存在则报错，防止覆盖
writeFileSync(pubPath, pubDer);

console.log(`私钥已生成: ${keyPath}`);
console.log(`公钥已生成: ${pubPath}`);
console.log(`预测扩展 ID: ${id}`);
console.log(`公钥 Base64（如需在 manifest 固定 ID 时使用）:`);
console.log(pubB64);