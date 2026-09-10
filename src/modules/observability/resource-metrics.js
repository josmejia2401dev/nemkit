'use strict';

const os = require('os');
const fs = require('fs');

const BYTES_PER_MB = 1024 * 1024;
const toMb = (bytes) => Math.round((bytes / BYTES_PER_MB) * 100) / 100;

function getDiskMetrics(diskPath) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(diskPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      path: diskPath,
      totalMb: toMb(totalBytes),
      freeMb: toMb(freeBytes),
      usedMb: toMb(usedBytes),
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return null;
  }
}

function getSystemMetrics(options = {}) {
  const diskPath = options.diskPath || process.cwd();
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus() || [];

  const metrics = {
    timestamp: new Date().toISOString(),
    process: {
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalMb: toMb(mem.heapTotal),
      externalMb: toMb(mem.external),
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      nodeVersion: process.version,
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      totalMemMb: toMb(totalMem),
      freeMemMb: toMb(freeMem),
      usedMemMb: toMb(totalMem - freeMem),
      usedMemPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0,
      cpuCores: cpus.length,
      cpuModel: cpus[0]?.model?.trim() ?? null,
      loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
      uptimeSeconds: Math.round(os.uptime()),
    },
    disk: getDiskMetrics(diskPath),
  };

  return metrics;
}

function startRequestSample() {
  return {
    hrtime: process.hrtime.bigint(),
    cpu: process.cpuUsage(),
    heapUsed: process.memoryUsage().heapUsed,
  };
}

function endRequestSample(sample) {
  const cpu = process.cpuUsage(sample.cpu);
  const mem = process.memoryUsage();
  return {
    responseTimeMs: Math.round(Number(process.hrtime.bigint() - sample.hrtime) / 1e6),
    cpuTimeMs: Math.round((cpu.user + cpu.system) / 1000),
    memoryConsumedMb: toMb(mem.heapUsed - sample.heapUsed),
    totalMemoryConsumedMb: toMb(mem.rss),
  };
}

module.exports = { getSystemMetrics, startRequestSample, endRequestSample };
