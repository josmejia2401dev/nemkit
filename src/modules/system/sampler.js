'use strict';

const { toMb } = require('./container-memory');

function startSample() {
  const mem = process.memoryUsage();
  return {
    hrtime: process.hrtime.bigint(),
    cpu: process.cpuUsage(),
    heapUsed: mem.heapUsed,
    initialRssMb: toMb(mem.rss),
  };
}

function endSample(sample) {
  if (!sample) {
    throw new Error('sampler: sample object is required for endSample');
  }

  const cpu = process.cpuUsage(sample.cpu);
  const mem = process.memoryUsage();
  const responseTimeMs = Math.round(Number(process.hrtime.bigint() - sample.hrtime) / 1e6);
  const totalMemoryConsumedMb = toMb(mem.rss);

  return {
    responseTimeMs,
    durationMs: responseTimeMs,
    cpuTimeMs: Math.round((cpu.user + cpu.system) / 1000),
    memoryConsumedMb: toMb(mem.heapUsed - sample.heapUsed),
    totalMemoryConsumedMb,
    maxMemoryMb: totalMemoryConsumedMb,
  };
}

module.exports = {
  startSample,
  endSample,
};
