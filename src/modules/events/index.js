'use strict';

const { EventEmitter } = require('events');

/**
 * @module events
 *
 * EventBus singleton para comunicación desacoplada entre módulos.
 *
 * Permite que un módulo emita un evento sin importar quién lo escucha.
 * Evita imports cruzados y dependencias circulares.
 *
 * Ejemplo:
 *   // auth.service.js emite:
 *   eventBus.emit('user.login', { userId: 123, ip: '1.2.3.4' });
 *
 *   // audit.service.js escucha (sin importar auth):
 *   eventBus.on('user.login', (data) => auditLog(data));
 *
 * Convenciones de nombres:
 *   'entity.action' → 'user.login', 'user.logout', 'deploy.started', 'container.stopped'
 */

class EventBus extends EventEmitter {
  #history = [];
  #maxHistory;

  /**
   * @param {Object} [options]
   * @param {number} [options.maxHistory=100] — Últimos N eventos guardados (0 = deshabilitado)
   * @param {number} [options.maxListeners=50] — Máximo de listeners por evento
   */
  constructor(options = {}) {
    super();
    this.#maxHistory = options.maxHistory ?? 100;
    this.setMaxListeners(options.maxListeners ?? 50);
  }

  /**
   * Emite un evento y lo registra en historial.
   * @param {string} event — Nombre del evento ('entity.action')
   * @param {*} data — Payload del evento
   * @returns {boolean}
   */
  emit(event, data) {
    if (this.#maxHistory > 0) {
      this.#history.push({
        event,
        data,
        timestamp: new Date().toISOString(),
      });
      if (this.#history.length > this.#maxHistory) {
        this.#history.shift();
      }
    }
    return super.emit(event, data);
  }

  /**
   * Suscribe un listener que se ejecuta solo una vez.
   * Alias más legible de `once`.
   * @param {string} event
   * @param {Function} listener
   */
  subscribe(event, listener) {
    this.on(event, listener);
    return this;
  }

  /**
   * Desuscribe un listener.
   * @param {string} event
   * @param {Function} listener
   */
  unsubscribe(event, listener) {
    this.off(event, listener);
    return this;
  }

  /**
   * Retorna el historial de eventos emitidos.
   * @param {string} [event] — Filtrar por nombre de evento (opcional)
   * @returns {Array}
   */
  getHistory(event) {
    if (event) return this.#history.filter((e) => e.event === event);
    return [...this.#history];
  }

  /**
   * Limpia el historial.
   */
  clearHistory() {
    this.#history = [];
  }

  /**
   * Retorna eventos registrados (con listeners activos).
   * @returns {string[]}
   */
  getRegisteredEvents() {
    return this.eventNames();
  }

  /**
   * Retorna cantidad de listeners por evento.
   * @param {string} event
   * @returns {number}
   */
  getListenerCount(event) {
    return this.listenerCount(event);
  }

  /**
   * Elimina todos los listeners y limpia historial.
   */
  destroy() {
    this.removeAllListeners();
    this.#history = [];
  }
}

// Singleton — una sola instancia por proceso
const eventBus = new EventBus();

module.exports = { EventBus, eventBus };
