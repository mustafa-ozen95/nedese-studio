/**
 * Islemci ve RAM ayrintisi (Sistem durumu penceresi): anlik islemci saati, onbellekler, surec
 * sayisi, RAM modulleri (tur/hiz), sanal bellek (taahhut). Windows'ta tek PowerShell/CIM cagrisi
 * (~1-2 sn) -> 3 sn onbellek (pencere aciksa istenir); cagri arka planda yenilenir, istek beklemez (ilk cagri haric).
 */
import { execFile } from 'node:child_process';

const COMMAND = `
$ErrorActionPreference='SilentlyContinue'
$p=Get-CimInstance Win32_Processor | Select -First 1
$f=Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
$m=@(Get-CimInstance Win32_PhysicalMemory)
$b=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$o=Get-CimInstance Win32_OperatingSystem
$t=@(Get-CimInstance Win32_PageFileUsage)
$d=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
[pscustomobject]@{
 swapMb=($t | Measure-Object CurrentUsage -Sum).Sum; swapSizeMb=($t | Measure-Object AllocatedBaseSize -Sum).Sum
 reading=[double]$d.DiskReadBytesPersec; writing=[double]$d.DiskWriteBytesPersec; idle=$d.PercentIdleTime
 maxMhz=$p.MaxClockSpeed; core=$p.NumberOfCores; logical=$p.NumberOfLogicalProcessors; l2Kb=$p.L2CacheSize; l3Kb=$p.L3CacheSize
 frequency=$f.ProcessorFrequency; performance=$f.PercentProcessorPerformance; proc=$o.NumberOfProcesses
 modules=@($m | % { [pscustomobject]@{ byte=[double]$_.Capacity; mts=$_.ConfiguredClockSpeed; type=$_.SMBIOSMemoryType } })
 commit=[double]$b.CommittedBytes; commitLimit=[double]$b.CommitLimit
} | ConvertTo-Json -Compress -Depth 3`;

const RAM_TYPE = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5', 35: 'LPDDR5' };

let last = null;
let lastTime = 0;
let pending = null;

function query() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((ok) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', COMMAND], { windowsHide: true, timeout: 15000 }, (error, output) => {
      if (error) return ok(null);
      try {
        const j = JSON.parse(String(output).trim());
        const modules = (j.modules ?? []).filter((m) => m.byte > 0);
        ok({
          cpu: {
            // Anlik saat = taban frekans x "islemci performansi" yuzdesi (turbo'da %100'u asar).
            instantMhz: j.frequency && j.performance ? Math.round((j.frequency * j.performance) / 100) : null,
            baseMhz: j.maxMhz ?? null,
            core: j.core ?? null,
            logical: j.logical ?? null,
            l2Mb: j.l2Kb ? j.l2Kb / 1024 : null,
            l3Mb: j.l3Kb ? j.l3Kb / 1024 : null,
            proc: j.proc ?? null,
          },
          ram: {
            modules: modules.length,
            moduleByte: modules[0]?.byte ?? null,
            mts: modules[0]?.mts || null,
            type: RAM_TYPE[modules[0]?.type] ?? null,
            commitByte: j.commit || null,
            commitLimitByte: j.commitLimit || null,
            // Takas (sayfa dosyasi): kullanilan / ayrilan, MB.
            swapMb: j.swapMb ?? null,
            swapSizeMb: j.swapSizeMb ?? null,
          },
          disk: {
            readingBps: j.reading ?? null,
            writingBps: j.writing ?? null,
            // Etkinlik = 100 - bosta gecen sure (birden cok diskte toplam 100'u asabilir).
            activityPercent: j.idle != null ? Math.max(0, Math.min(100, 100 - j.idle)) : null,
          },
        });
      } catch {
        ok(null);
      }
    });
  });
}

function refresh() {
  pending ??= query().then((s) => {
    if (s) last = s;
    lastTime = Date.now();
    pending = null;
    return last;
  });
  return pending;
}

export async function systemDetail() {
  if (!last) return refresh();
  if (Date.now() - lastTime > 3000) refresh();
  return last;
}
