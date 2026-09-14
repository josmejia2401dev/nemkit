'use strict';

const { scrypt, randomBytes, timingSafeEqual, createHash } = require('crypto');
const { promisify } = require('util');

// Previene que libuv se quede sin threads durante picos de autenticación
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const COST = 16384;

/**
 * Hashea un password con scrypt no bloqueante.
 */
const hashPassword = async (plain) => {
  const salt = randomBytes(32);
  const derived = await scryptAsync(plain, salt, KEY_LENGTH, { N: COST, r: 8, p: 1 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
};

/**
 * Compara un password contra un hash con protección ante timing attacks.
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

const randomToken = (bytes = 32) => {
  return randomBytes(bytes).toString('hex');
};

const sha256 = (input) => {
  return createHash('sha256').update(input).digest('hex');
};

module.exports = { hashPassword, comparePassword, randomToken, sha256 };