'use strict';

const os = require('os');
const fs = require('fs');
const { toMb } = require('./container-memory');

function getDiskMetrics(diskPath) {
  const targetPath = diskPath || process.cwd();
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      path: targetPath,
      totalMb: toMb(totalBytes),
      freeMb: toMb(freeBytes),
      usedMb: toMb(usedBytes),
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return null;
  }
}

function getHostMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus() || [];

  return {
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
  };
}

module.exports = {
  getDiskMetrics,
  getHostMetrics,
};
