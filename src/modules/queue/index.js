'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { UniqueNumberUtil } = require('../helpers/unique-number.util');

const PRIORITY = Object.freeze({ HIGH: 1, NORMAL: 2, LOW: 3 });
const STATUS = Object.freeze({ WAITING: 'waiting', ACTIVE: 'active', COMPLETED: 'completed', FAILED: 'failed', DEAD: 'dead' });

class Job {
  constructor(data, options = {}) {
    this.id = options.id ?? UniqueNumberUtil.ulid();
    this.data = data;
    this.priority = PRIORITY[String(options.priority ?? 'NORMAL').toUpperCase()] ?? PRIORITY.NORMAL;
    this.delay = options.delay ?? 0;
    this.attempts = options.attempts ?? 0;
    this.maxRetries = options.maxRetries ?? null;
    this.status = options.status ?? STATUS.WAITING;
    this.error = options.error ?? null;
    this.createdAt = options.createdAt ?? Date.now();
    this.processedAt = options.processedAt ?? null;
    this.completedAt = options.completedAt ?? null;
    this.scheduledFor = options.scheduledFor ?? (this.delay > 0 ? Date.now() + this.delay : 0);
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
  #maxRetries;
  #retryDelayMs;
  #backoffMultiplier;
  #jobTimeoutMs;
  #paused = false;
  #processing = false;
  #delayTimer = null;
  #persistenceFile = null;
  #stats = { completed: 0, failed: 0 };

  constructor(name, options = {}) {
    super();
    this.#name = name;
    this.#concurrency = options.concurrency ?? 1;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#backoffMultiplier = options.backoffMultiplier ?? 2;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 30000;

    if (options.persistenceDir) {
      this.#persistenceFile = path.resolve(options.persistenceDir, `${name}.queue.json`);
      this.#restoreState();
    }
  }

  get name() { return this.#name; }

  process(fn) {
    if (typeof fn !== 'function') throw new Error('Queue.process: handler must be a function');
    this.#processor = fn;
    this.#tick();
  }

  add(data, options = {}) {
    const job = new Job(data, { ...options, maxRetries: options.maxRetries ?? this.#maxRetries });
    this.#enqueue(job);
    this.#persistState();
    this.#tick();
    return job;
  }

  addBulk(items) {
    const jobs = items.map((item) => {
      const job = new Job(item.data, { ...item.options, maxRetries: (item.options?.maxRetries ?? this.#maxRetries) });
      this.#enqueue(job);
      return job;
    });
    this.#persistState();
    this.#tick();
    return jobs;
  }

  pause() { this.#paused = true; }

  resume() {
    this.#paused = false;
    this.#tick();
  }

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

  destroy() {
    this.#paused = true;
    this.#waiting = [];
    this.#active.clear();
    this.#deadLetter = [];
    if (this.#delayTimer) clearTimeout(this.#delayTimer);
    this.removeAllListeners();
  }

  #enqueue(job) {
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
      this.#execute(job);
    }

    this.#scheduleDelayed();
    this.#processing = false;
  }

  #pickNextReady() {
    for (let i = 0; i < this.#waiting.length; i++) {
      if (this.#waiting[i].isReady()) {
        return this.#waiting.splice(i, 1)[0];
      }
    }
    return null;
  }

  #scheduleDelayed() {
    if (this.#delayTimer) clearTimeout(this.#delayTimer);
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
    this.#persistState();

    try {
      if (this.#jobTimeoutMs > 0) {
        await this.#withTimeout(this.#processor(job), this.#jobTimeoutMs);
      } else {
        await this.#processor(job);
      }
      job.status = STATUS.COMPLETED;
      job.completedAt = Date.now();
      this.#stats.completed++;
      this.emit('completed', job);
    } catch (err) {
      job.error = err.message;
      const maxRetries = job.maxRetries ?? this.#maxRetries;
      if (job.attempts < maxRetries) {
        const delay = this.#retryDelayMs * Math.pow(this.#backoffMultiplier, job.attempts - 1);
        job.status = STATUS.WAITING;
        job.scheduledFor = Date.now() + delay;
        this.#enqueue(job);
        this.emit('retrying', job, err, job.attempts);
      } else {
        job.status = STATUS.DEAD;
        this.#deadLetter.push(job);
        this.#stats.failed++;
        this.emit('failed', job, err);
      }
    } finally {
      this.#active.delete(job);
      this.#persistState();
      this.#tick();
    }
  }

  #withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Job timeout after ${ms}ms`)), ms);
      promise.then((val) => { clearTimeout(timer); resolve(val); }).catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  #persistState() {
    if (!this.#persistenceFile) return;
    try {
      fs.mkdirSync(path.dirname(this.#persistenceFile), { recursive: true });
      const state = {
        waiting: this.#waiting,
        deadLetter: this.#deadLetter,
      };
      fs.writeFileSync(this.#persistenceFile, JSON.stringify(state), 'utf8');
    } catch { /* Silent persist fallback */ }
  }

  #restoreState() {
    if (!this.#persistenceFile || !fs.existsSync(this.#persistenceFile)) return;
    try {
      const raw = fs.readFileSync(this.#persistenceFile, 'utf8');
      const state = JSON.parse(raw);
      if (Array.isArray(state.waiting)) {
        this.#waiting = state.waiting.map((j) => new Job(j.data, j));
      }
      if (Array.isArray(state.deadLetter)) {
        this.#deadLetter = state.deadLetter.map((j) => new Job(j.data, j));
      }
    } catch { /* Ignore corrupted state */ }
  }
}

const createQueue = (name, options = {}) => new Queue(name, options);

module.exports = { Queue, createQueue, PRIORITY, STATUS };