'use strict';

const { EventEmitter } = require('events');
const { UniqueNumberUtil } = require('../helpers/unique-number.util');

/**
 * @module queue
 *
 * Cola de tareas en memoria de alto rendimiento.
 *
 * Features:
 * - Named queues (múltiples colas independientes)
 * - Concurrency configurable
 * - Retry con backoff exponencial
 * - Dead Letter Queue (DLQ)
 * - Priority (high, normal, low)
 * - Delay (jobs diferidos)
 * - Job timeout
 * - Events: completed, failed, retrying, dead, drained
 * - Pause/Resume
 * - Graceful shutdown (drain)
 * - Stats en tiempo real
 */

const PRIORITY = Object.freeze({ HIGH: 1, NORMAL: 2, LOW: 3 });
const STATUS = Object.freeze({ WAITING: 'waiting', ACTIVE: 'active', COMPLETED: 'completed', FAILED: 'failed', DEAD: 'dead' });

class Job {
  constructor(data, options = {}) {
    this.id = UniqueNumberUtil.ulid();
    this.data = data;
    this.priority = PRIORITY[String(options.priority ?? 'NORMAL').toUpperCase()] ?? PRIORITY.NORMAL;
    this.delay = options.delay ?? 0;
    this.attempts = 0;
    this.maxRetries = options.maxRetries ?? null; // null = usa default de la queue
    this.status = STATUS.WAITING;
    this.error = null;
    this.createdAt = Date.now();
    this.processedAt = null;
    this.completedAt = null;
    this.scheduledFor = this.delay > 0 ? Date.now() + this.delay : 0;
  }

  isReady() {
    if (this.scheduledFor === 0) return true;
    return Date.now() >= this.scheduledFor;
  }
}

class Queue extends EventEmitter {
  #name;
  #processor = null;
  #waiting = [];
  #active = new Set();
  #deadLetter = [];
  #concurrency;
  #concurrencyPerPriority;
  #maxRetries;
  #retryDelayMs;
  #backoffMultiplier;
  #jobTimeoutMs;
  #paused = false;
  #processing = false;
  #delayTimer = null;
  #stats = { completed: 0, failed: 0 };

  /**
   * @param {string} name — Nombre de la cola
   * @param {Object} [options]
   * @param {number} [options.concurrency=1] — Workers simultáneos
   * @param {number} [options.maxRetries=3] — Reintentos por job
   * @param {number} [options.retryDelayMs=1000] — Delay base entre reintentos
   * @param {number} [options.backoffMultiplier=2] — Multiplicador de backoff
   * @param {number} [options.jobTimeoutMs=30000] — Timeout por job (0 = sin límite)
   * @param {Object} [options.concurrencyPerPriority] — Límite por prioridad. Ej: { HIGH: 2, NORMAL: 3, LOW: 1 }
   */
  constructor(name, options = {}) {
    super();
    this.#name = name;
    this.#concurrency = options.concurrency ?? 1;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#backoffMultiplier = options.backoffMultiplier ?? 2;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 30000;
    this.#concurrencyPerPriority = options.concurrencyPerPriority ?? null;
  }

  get name() { return this.#name; }

  /**
   * Registra la función procesadora.
   * @param {Function} fn — async (job) => void
   */
  process(fn) {
    if (typeof fn !== 'function') throw new Error('Queue.process: handler must be a function');
    this.#processor = fn;
    this.#tick();
  }

  /**
   * Agrega un job a la cola.
   * @param {*} data — Datos del job
   * @param {Object} [options]
   * @param {string} [options.priority='normal'] — 'high' | 'normal' | 'low'
   * @param {number} [options.delay=0] — Delay en ms antes de procesar
   * @param {number} [options.maxRetries] — Override de reintentos para este job
   * @returns {Job}
   */
  add(data, options = {}) {
    const job = new Job(data, { ...options, maxRetries: options.maxRetries ?? this.#maxRetries });
    this.#enqueue(job);
    this.#tick();
    return job;
  }

  /**
   * Agrega múltiples jobs.
   * @param {Array<{ data: *, options?: Object }>} items
   * @returns {Job[]}
   */
  addBulk(items) {
    const jobs = items.map((item) => {
      const job = new Job(item.data, { ...item.options, maxRetries: (item.options?.maxRetries ?? this.#maxRetries) });
      this.#enqueue(job);
      return job;
    });
    this.#tick();
    return jobs;
  }

  /**
   * Pausa el procesamiento (no afecta jobs activos).
   */
  pause() {
    this.#paused = true;
  }

  /**
   * Reanuda el procesamiento.
   */
  resume() {
    this.#paused = false;
    this.#tick();
  }

  /**
   * Espera a que todos los jobs activos y en cola se procesen.
   * @returns {Promise<void>}
   */
  async drain() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.#waiting.length === 0 && this.#active.size === 0) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * Obtiene los jobs en Dead Letter Queue.
   * @returns {Job[]}
   */
  getDeadLetter() {
    return [...this.#deadLetter];
  }

  /**
   * Reintenta un job de la DLQ.
   * @param {string} jobId
   * @returns {boolean}
   */
  retryDead(jobId) {
    const index = this.#deadLetter.findIndex((j) => j.id === jobId);
    if (index === -1) return false;

    const job = this.#deadLetter.splice(index, 1)[0];
    job.attempts = 0;
    job.status = STATUS.WAITING;
    job.error = null;
    this.#enqueue(job);
    this.#tick();
    return true;
  }

  /**
   * Limpia la DLQ.
   */
  clearDeadLetter() {
    this.#deadLetter = [];
  }

  /**
   * Estadísticas en tiempo real.
   */
  getStats() {
    return {
      name: this.#name,
      waiting: this.#waiting.length,
      active: this.#active.size,
      completed: this.#stats.completed,
      failed: this.#stats.failed,
      dead: this.#deadLetter.length,
      paused: this.#paused,
    };
  }

  /**
   * Destruye la cola: limpia todo y remueve timers.
   */
  destroy() {
    this.#paused = true;
    this.#waiting = [];
    this.#active.clear();
    this.#deadLetter = [];
    if (this.#delayTimer) { clearTimeout(this.#delayTimer); this.#delayTimer = null; }
    this.removeAllListeners();
  }

  // ═══════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════

  #enqueue(job) {
    // Insertar por prioridad (menor número = mayor prioridad)
    let inserted = false;
    for (let i = 0; i < this.#waiting.length; i++) {
      if (job.priority < this.#waiting[i].priority) {
        this.#waiting.splice(i, 0, job);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.#waiting.push(job);
  }

  #tick() {
    if (this.#paused || !this.#processor || this.#processing) return;
    this.#processing = true;

    while (this.#active.size < this.#concurrency && this.#waiting.length > 0) {
      const job = this.#pickNextReady();
      if (!job) break;

      // Check per-priority concurrency limit
      if (this.#concurrencyPerPriority) {
        const priorityName = this.#getPriorityName(job.priority);
        const limit = this.#concurrencyPerPriority[priorityName];
        if (limit !== undefined) {
          const activeForPriority = [...this.#active].filter(j => j.priority === job.priority).length;
          if (activeForPriority >= limit) {
            // Re-insert at front for this priority and try next
            this.#waiting.unshift(job);
            break;
          }
        }
      }

      this.#execute(job);
    }

    this.#scheduleDelayed();
    this.#processing = false;

    if (this.#waiting.length === 0 && this.#active.size === 0) {
      this.emit('drained');
    }
  }

  #pickNextReady() {
    for (let i = 0; i < this.#waiting.length; i++) {
      if (this.#waiting[i].isReady()) {
        return this.#waiting.splice(i, 1)[0];
      }
    }
    return null;
  }

  #getPriorityName(priority) {
    switch (priority) {
      case PRIORITY.HIGH: return 'HIGH';
      case PRIORITY.NORMAL: return 'NORMAL';
      case PRIORITY.LOW: return 'LOW';
      default: return 'NORMAL';
    }
  }

  #scheduleDelayed() {
    if (this.#delayTimer) { clearTimeout(this.#delayTimer); this.#delayTimer = null; }

    let nearest = Infinity;
    for (const job of this.#waiting) {
      if (job.scheduledFor > 0 && job.scheduledFor < nearest) {
        nearest = job.scheduledFor;
      }
    }

    if (nearest < Infinity) {
      const wait = Math.max(0, nearest - Date.now());
      this.#delayTimer = setTimeout(() => this.#tick(), wait);
      if (this.#delayTimer.unref) this.#delayTimer.unref();
    }
  }

  async #execute(job) {
    job.status = STATUS.ACTIVE;
    job.attempts++;
    job.processedAt = Date.now();
    this.#active.add(job);

    try {
      if (this.#jobTimeoutMs > 0) {
        await this.#withTimeout(this.#processor(job), this.#jobTimeoutMs);
      } else {
        await this.#processor(job);
      }

      // Success
      job.status = STATUS.COMPLETED;
      job.completedAt = Date.now();
      this.#stats.completed++;
      this.emit('completed', job);

    } catch (err) {
      job.error = err.message;
      const maxRetries = job.maxRetries ?? this.#maxRetries;

      if (job.attempts < maxRetries) {
        // Retry con backoff
        const delay = this.#retryDelayMs * Math.pow(this.#backoffMultiplier, job.attempts - 1);
        job.status = STATUS.WAITING;
        job.scheduledFor = Date.now() + delay;
        this.#enqueue(job);
        this.emit('retrying', job, err, job.attempts);
      } else {
        // Dead Letter Queue
        job.status = STATUS.DEAD;
        this.#deadLetter.push(job);
        this.#stats.failed++;
        this.emit('failed', job, err);
        this.emit('dead', job);
      }
    } finally {
      this.#active.delete(job);
      this.#tick();
    }
  }

  #withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Job timeout after ${ms}ms`)), ms);
      promise
        .then((val) => { clearTimeout(timer); resolve(val); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }
}

/**
 * Factory.
 * @param {string} name
 * @param {Object} [options]
 * @returns {Queue}
 */
function createQueue(name, options = {}) {
  return new Queue(name, options);
}

module.exports = { Queue, createQueue, PRIORITY, STATUS };
