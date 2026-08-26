'use strict';

const { scrypt, randomBytes, timingSafeEqual, createHash } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const COST = 16384;

/**
 * Hashea un password con scrypt (nativo Node.js).
 * @param {string} plain — Password en texto plano
 * @returns {Promise<string>} — Formato "salt:hash" en hex
 */
const hashPassword = async (plain) => {
  const salt = randomBytes(32);
  const derived = await scryptAsync(plain, salt, KEY_LENGTH, { N: COST, r: 8, p: 1 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
};

/**
 * Compara un password contra un hash almacenado.
 * @param {string} plain — Password ingresado
 * @param {string} hash — Hash almacenado ("salt:derivedKey")
 * @returns {Promise<boolean>}
 */
const comparePassword = async (plain, hash) => {
  const [saltHex, keyHex] = hash.split(':');
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const storedKey = Buffer.from(keyHex, 'hex');
  const derived = await scryptAsync(plain, salt, KEY_LENGTH, { N: COST, r: 8, p: 1 });

  if (derived.length !== storedKey.length) return false;
  return timingSafeEqual(derived, storedKey);
};

/**
 * Genera un token random hexadecimal criptográficamente seguro.
 * Útil para: reset password, verificación email, API keys, CSRF tokens.
 * @param {number} [bytes=32] — Cantidad de bytes (output = bytes * 2 chars hex)
 * @returns {string}
 */
const randomToken = (bytes = 32) => {
  return randomBytes(bytes).toString('hex');
};

/**
 * Genera un hash SHA-256 de un string.
 * Útil para: checksums, cache keys, token hashing, ETags, webhook signatures.
 * @param {string} input
 * @returns {string} — Hash hex (64 chars)
 */
const sha256 = (input) => {
  return createHash('sha256').update(input).digest('hex');
};

module.exports = { hashPassword, comparePassword, randomToken, sha256 };
