/**
 * OWNER: Kiro. Read-only PC status (ported from E.D.I.T.H. system_status,
 * plus battery and disk): CPU, memory, uptime, battery, free disk space.
 */
import { statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, totalmem, uptime } from 'node:os'
import { runPowerShell } from './ps'

const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10

function cpuSnapshot() {
  return cpus().reduce(
    (acc, c) => {
      const t = c.times
      acc.idle += t.idle
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq
      return acc
    },
    { idle: 0, total: 0 }
  )
}

async function cpuPercent(sampleMs = 400) {
  const a = cpuSnapshot()
  await new Promise((r) => setTimeout(r, sampleMs))
  const b = cpuSnapshot()
  const total = b.total - a.total
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 100) : 0
}

async function battery(): Promise<{ percent: number; charging: boolean } | null> {
  if (process.platform !== 'win32') return null
  try {
    const out = await runPowerShell('Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress', 10_000)
    if (!out) return null
    const b = JSON.parse(out) as { EstimatedChargeRemaining?: number; BatteryStatus?: number }
    if (typeof b.EstimatedChargeRemaining !== 'number') return null
    // BatteryStatus 1 = discharging; 2 = on AC; 6–9 = charging variants.
    return { percent: b.EstimatedChargeRemaining, charging: b.BatteryStatus !== 1 }
  } catch {
    return null
  }
}

export async function systemStatus() {
  const [cpu, bat, disk] = await Promise.all([cpuPercent(), battery(), statfs(homedir()).catch(() => null)])
  const total = totalmem()
  const free = freemem()
  const up = uptime()
  return {
    cpuPercent: cpu,
    cpuModel: cpus()[0]?.model?.trim(),
    cores: cpus().length,
    ramUsedGb: gb(total - free),
    ramTotalGb: gb(total),
    ramPercent: Math.round(((total - free) / total) * 100),
    uptime: `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`,
    battery: bat ? `${bat.percent}%${bat.charging ? ' (plugged in)' : ' (on battery)'}` : 'no battery (desktop PC)',
    diskFreeGb: disk ? gb(disk.bavail * disk.bsize) : undefined,
    diskTotalGb: disk ? gb(disk.blocks * disk.bsize) : undefined
  }
}
