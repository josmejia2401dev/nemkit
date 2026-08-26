'use strict';

/**
 * @module helpers/unique-number.util
 *
 * Generador de IDs únicos con múltiples estrategias:
 * - Numérico con prefijo de entidad (identificación visual de la colección)
 * - Numérico crudo (sin prefijo)
 * - UUID v4
 * - ULID (lexicográficamente sortable)
 *
 * Uso como clase instanciable (con prefijos registrados) o como métodos estáticos.
 */

const { randomUUID } = require('crypto');

class UniqueNumberUtil {
  #prefixes;

  /**
   * @param {Object} [prefixes] — Mapeo entidad → prefijo numérico de 3 dígitos.
   * @example
   * const uid = new UniqueNumberUtil({
   *   users: 101,
   *   products: 102,
   *   orders: 103,
   * });
   */
  constructor(prefixes = {}) {
    this.#prefixes = { ...prefixes };
  }

  /**
   * Registra nuevos prefijos (merge con existentes).
   * @param {Object} newPrefixes
   * @returns {this}
   */
  register(newPrefixes) {
    Object.assign(this.#prefixes, newPrefixes);
    return this;
  }

  /**
   * Obtiene el prefijo registrado de una entidad.
   * @param {string} entity
   * @returns {number|undefined}
   */
  getPrefix(entity) {
    return this.#prefixes[entity];
  }

  /**
   * Lista todas las entidades registradas.
   * @returns {Object}
   */
  getPrefixes() {
    return { ...this.#prefixes };
  }

  /**
   * Genera un ID numérico con prefijo de entidad.
   * Estructura: [prefijo 3d][yyMMdd][timestamp+random]
   *
   * @param {string} entity — Nombre de la entidad/modelo
   * @param {number} [digits=12] — Total de dígitos del ID
   * @returns {number}
   *
   * @example
   * uid.generate('users');    // 101260819847291
   * uid.generate('orders');   // 103260819293847
   */
  generate(entity, digits = 12) {
    const prefix = this.#prefixes[entity];
    if (prefix === undefined) {
      throw new Error(`UniqueNumberUtil: unknown entity '${entity}'. Register it with .register({ ${entity}: <prefix> })`);
    }

    const prefixStr = String(prefix);
    const suffixLength = digits - prefixStr.length;

    if (suffixLength < 8) {
      throw new Error(`UniqueNumberUtil: digits=${digits} is too small for entity '${entity}' (needs at least ${prefixStr.length + 8})`);
    }

    const suffix = UniqueNumberUtil.generateRaw(suffixLength);
    return Number(prefixStr + String(suffix).padStart(suffixLength, '0'));
  }

  /**
   * Genera un número único sin prefijo de entidad.
   * Estructura: [yyMMdd 6d][timestamp tail + random]
   *
   * @param {number} [digits=12] — Total de dígitos
   * @returns {number}
   *
   * @example
   * UniqueNumberUtil.generateRaw(12); // 260819847291
   */
  static generateRaw(digits = 12) {
    if (digits < 8) throw new Error("UniqueNumberUtil: 'digits' must be >= 8");

    const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // yyMMdd
    const remaining = digits - 6;
    const timeComponent = String(Date.now()).slice(-remaining);
    const randomComponent = String(
      Math.floor(Math.random() * Math.pow(10, remaining))
    ).padStart(remaining, '0');

    let numeric = dateStr + timeComponent;
    if (numeric.length < digits) numeric += randomComponent.slice(0, digits - numeric.length);
    if (numeric.length > digits) numeric = numeric.slice(0, digits);

    // Asegurar que no comience con 0
    if (numeric.charAt(0) === '0') {
      numeric = String(Math.floor(Math.random() * 9) + 1) + numeric.slice(1);
    }

    return Number(numeric);
  }

  /**
   * Genera un UUID v4 (string, 36 chars).
   * @returns {string}
   *
   * @example
   * UniqueNumberUtil.uuid(); // 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
   */
  static uuid() {
    return randomUUID();
  }

  /**
   * Genera un ULID (string, 26 chars, lexicográficamente sortable).
   * Implementación propia sin dependencias — compatible con spec ULID.
   * @returns {string}
   *
   * @example
   * UniqueNumberUtil.ulid(); // '01ARZ3NDEKTSV4RRFFQ69G5FAV'
   */
  static ulid() {
    const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ENCODING_LEN = ENCODING.length; // 32
    const TIME_LEN = 10;
    const RANDOM_LEN = 16;

    let now = Date.now();
    let timeStr = '';
    for (let i = TIME_LEN; i > 0; i--) {
      timeStr = ENCODING[now % ENCODING_LEN] + timeStr;
      now = Math.floor(now / ENCODING_LEN);
    }

    let randomStr = '';
    for (let i = 0; i < RANDOM_LEN; i++) {
      randomStr += ENCODING[Math.floor(Math.random() * ENCODING_LEN)];
    }

    return timeStr + randomStr;
  }
}

/**
 * Factory: crea una instancia con prefijos pre-registrados.
 * @param {Object} [prefixes]
 * @returns {UniqueNumberUtil}
 *
 * @example
 * const uid = createUniqueNumber({ users: 101, orders: 102 });
 * uid.generate('users'); // 101260819...
 */
const createUniqueNumber = (prefixes = {}) => new UniqueNumberUtil(prefixes);

module.exports = { UniqueNumberUtil, createUniqueNumber };
