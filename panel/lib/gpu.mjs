/**
 * Ekran karti ve bellek durumu (ust cubuk). nvidia-smi her cagrida ~100 ms surer:
 * sonuc 2 sn onbellekte tutulur, ayni anda gelen istekler tek cagriyi paylasir.
 */
import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem, uptime } from 'node:os';

let last = null;
let lastTime = 0;
let pending = null;

function query() {
  return new Promise((ok) => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr,clocks.max.gr,utilization.memory,pstate,driver_version',
        '--format=csv,noheader,nounits',
      ],
      { windowsHide: true, timeout: 5000 },
      (error, output) => {
        if (error) {
          ok(null);
          return;
        }
        const line = String(output).trim().split(/\r?\n/)[0];
        const p = line.split(',').map((s) => s.trim());
        // [N/A] (kartin desteklemedigi alan) -> null
        const count = (s) => (s === undefined || /N\/A|Not Supported/i.test(s) ? null : Number(s));
        ok({
          name: p[0],
          memoryUsedMb: count(p[1]),
          memoryTotalMb: count(p[2]),
          usagePercent: count(p[3]),
          temperature: count(p[4]),
          strengthW: count(p[5]),
          strengthLimitW: count(p[6]),
          fanPercent: count(p[7]),
          hourMhz: count(p[8]),
          hourMaxMhz: count(p[9]),
          memoryUsagePercent: count(p[10]),
          performanceStatus: p[11] ?? null,
          driver: p[12] ?? null,
        });
      },
    );
  });
}

export async function gpuStatus() {
  if (Date.now() - lastTime < 2000) return last;
  if (!pending) {
    pending = query().then((s) => {
      last = s;
      lastTime = Date.now();
      pending = null;
      return s;
    });
  }
  return pending;
}

/** Onbellegi atlayarak olcer (seslendirme oncesi VRAM bosaldi mi). */
export async function measureGpu() {
  lastTime = 0;
  return gpuStatus();
}

// Islemci yuku: iki cagri arasindaki cekirdek zamanlarinin farkindan (Windows'ta loadavg yok).
// Cekirdek basina yuk de ayni farktan (Sistem penceresindeki cekirdek cubuklari).
let previousCpu = null;
let lastCores = null;
function cpuPercent() {
  const t = cpus().map((c) => ({ free: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  const previous = previousCpu;
  previousCpu = t;
  if (!previous || previous.length !== t.length) return null;
  const percent = (free, total) => (total > 0 ? Math.round((1 - free / total) * 1000) / 10 : 0);
  lastCores = t.map((c, i) => percent(c.free - previous[i].free, c.total - previous[i].total));
  const free = t.reduce((a, c, i) => a + c.free - previous[i].free, 0);
  const total = t.reduce((a, c, i) => a + c.total - previous[i].total, 0);
  if (total <= 0) return null;
  return percent(free, total);
}

export function ramStatus() {
  const c = cpus();
  const cpuLoad = cpuPercent();
  return {
    freeMb: Math.round(freemem() / 2 ** 20),
    totalMb: Math.round(totalmem() / 2 ** 20),
    cpuPercent: cpuLoad,
    corePercent: lastCores,
    cpuName: c[0]?.model?.trim() ?? null,
    cpuCore: c.length,
    openStayingSec: Math.round(uptime()),
  };
}
