import os from 'os';

export function getSystemMetrics() {
  const memUsage = process.memoryUsage();
  const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);
  const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
  const totalSystemMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const freeSystemMemMB = (os.freemem() / 1024 / 1024).toFixed(0);

  const uptimeSec = process.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  const uptimeStr = `${days}d ${hours}h ${minutes}m`;

  return {
    rssMB,
    heapUsedMB,
    totalSystemMemGB,
    freeSystemMemMB,
    uptimeStr,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuCount: os.cpus().length,
  };
}
