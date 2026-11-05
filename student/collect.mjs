// 수집: PC 상태를 "읽기만" 합니다. 설정을 바꾸는 명령은 하나도 없습니다.
// Windows 전용 항목(방화벽·Windows 보안·업데이트·포트·시작프로그램)은 PowerShell 조회 명령(Get-*)만 씁니다.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';

const WIN_ONLY = 'Windows에서만 읽을 수 있어요';

export const PS = {
  firewall:
    "Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ Name=[string]$_.Name; Enabled=([string]$_.Enabled -eq 'True') } } | ConvertTo-Json -Compress",
  // 위 조회가 막힌 PC를 위한 대체 방법: 방화벽 설정값을 레지스트리에서 "읽기만" 합니다 (일반 권한으로 읽힘).
  firewallReg:
    "'Domain','Standard','Public' | ForEach-Object { $n = $_; $v = (Get-ItemProperty -Path ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\' + $n + 'Profile') -Name EnableFirewall -ErrorAction Stop).EnableFirewall; [pscustomobject]@{ Name=$(if ($n -eq 'Standard') { 'Private' } else { $n }); Enabled=([int]$v -eq 1) } } | ConvertTo-Json -Compress",
  defender: '$s = Get-MpComputerStatus -ErrorAction Stop; [pscustomobject]@{ RealTime=[bool]$s.RealTimeProtectionEnabled } | ConvertTo-Json -Compress',
  update:
    "$h = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1; if ($h) { $h.InstalledOn.ToString('yyyy-MM-dd') } else { 'none' }",
  ports:
    "(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -notin '127.0.0.1','::1' } | Measure-Object).Count",
  startup: '(Get-CimInstance Win32_StartupCommand -ErrorAction Stop | Measure-Object).Count',
  // 연결된(Up) 실제 어댑터의 종류만 읽습니다. 주소(IP)·MAC·이름은 읽지 않아요.
  network:
    "Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and -not $_.Virtual } | ForEach-Object { [pscustomobject]@{ Media=[string]$_.MediaType } } | ConvertTo-Json -Compress",
  // System·Application 기록에서 최근 24시간 경고(3)·오류(2)의 건수만 셉니다. 내용은 읽지 않아요.
  events:
    "$since = (Get-Date).AddHours(-24); $out = @{}; foreach ($n in 'System','Application') { try { $out[$n] = @(Get-WinEvent -FilterHashtable @{ LogName = $n; Level = 2,3; StartTime = $since } -MaxEvents 500 -ErrorAction Stop).Count } catch { if ($_.FullyQualifiedErrorId -like '*NoMatchingEventsFound*') { $out[$n] = 0 } else { throw } } }; [pscustomobject]@{ System = $out['System']; Application = $out['Application'] } | ConvertTo-Json -Compress",
};
export const EVENTS_CAP = 500;

export function powerShellPath(platform = process.platform) {
  if (platform !== 'win32') return 'powershell.exe';
  const full = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

export function runPowerShell(script) {
  // 따옴표 문제를 피하려고 명령을 인코딩해서 넘깁니다(실행 정책 설정은 바꾸지 않아요).
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      powerShellPath(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').trim().split('\n')[0].slice(0, 120);
          reject(new Error(err.killed ? '시간이 너무 오래 걸렸어요' : msg || 'PowerShell을 실행하지 못했어요'));
        } else resolve(String(stdout));
      },
    );
  });
}

const fail = (e) => ({ error: e instanceof Error && e.message ? e.message : '값을 읽지 못했어요' });

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

export async function readCpu({ wait = 500 } = {}) {
  try {
    const a = cpuSnapshot();
    await new Promise((r) => setTimeout(r, wait));
    const b = cpuSnapshot();
    const total = b.total - a.total;
    if (!(total > 0)) return { error: 'CPU 사용 시간을 비교하지 못했어요' };
    return { pct: Math.min(100, Math.max(0, (1 - (b.idle - a.idle) / total) * 100)) };
  } catch (e) {
    return fail(e);
  }
}

export function readMemory() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (!(total > 0)) return { error: '메모리 크기를 읽지 못했어요' };
    return { pct: ((total - free) / total) * 100, totalGB: total / 2 ** 30 };
  } catch (e) {
    return fail(e);
  }
}

export async function readDisk(platform = process.platform) {
  try {
    const root = platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/';
    const s = await statfs(root);
    const total = s.blocks * s.bsize;
    if (!(total > 0)) return { error: '디스크 크기를 읽지 못했어요' };
    const free = s.bavail * s.bsize;
    return { freePct: (free / total) * 100, freeGB: free / 2 ** 30, totalGB: total / 2 ** 30, drive: root };
  } catch (e) {
    return fail(e);
  }
}

export function parseFirewall(out) {
  const data = JSON.parse(out);
  const arr = Array.isArray(data) ? data : [data];
  const profiles = arr
    .filter((p) => p && typeof p.Name === 'string' && typeof p.Enabled === 'boolean')
    .map((p) => ({ name: p.Name, enabled: p.Enabled }));
  if (profiles.length === 0) throw new Error('방화벽 상태를 해석하지 못했어요');
  return { profiles };
}

export function parseDefender(out) {
  const d = JSON.parse(out);
  if (!d || typeof d.RealTime !== 'boolean') throw new Error('Windows 보안 상태를 해석하지 못했어요');
  return { realtime: d.RealTime };
}

export function parseUpdate(out, now = new Date()) {
  const s = String(out).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('업데이트 설치 기록을 찾지 못했어요');
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return { days: Math.max(0, Math.round((today - then) / 86400000)), date: s };
}

export function parseCount(out, what) {
  const s = String(out).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${what} 개수를 해석하지 못했어요`);
  return { count: Number(s) };
}

export function parseNetwork(out) {
  const text = String(out).trim();
  if (text === '') return { connected: false, kinds: [] };
  const data = JSON.parse(text);
  const arr = (Array.isArray(data) ? data : [data]).filter((a) => a && typeof a.Media === 'string');
  const kinds = [];
  for (const a of arr) {
    const k = /802\.3/.test(a.Media) ? '유선' : /802\.11/.test(a.Media) ? '무선' : '기타';
    if (!kinds.includes(k)) kinds.push(k);
  }
  return { connected: arr.length > 0, kinds };
}

export function parseEvents(out) {
  const d = JSON.parse(String(out).trim());
  if (!d || !Number.isInteger(d.System) || !Number.isInteger(d.Application) || d.System < 0 || d.Application < 0) {
    throw new Error('Windows 경고·오류 건수를 해석하지 못했어요');
  }
  return { system: d.System, application: d.Application, total: d.System + d.Application, capped: d.System >= EVENTS_CAP || d.Application >= EVENTS_CAP };
}

// PowerShell 없이도 되는 대체 방법: 바깥으로 연결된 인터페이스가 있는지만 봅니다(주소는 저장하지 않아요).
export function readNetworkBasic() {
  try {
    const all = Object.values(os.networkInterfaces()).flat().filter(Boolean);
    const up = all.some((a) => !a.internal && (a.family === 'IPv4' || a.family === 4) && !String(a.address).startsWith('169.254.'));
    return { connected: up, kinds: [] };
  } catch (e) {
    return fail(e);
  }
}

async function viaPowerShell(run, script, parse) {
  try {
    return parse(await run(script));
  } catch (e) {
    return fail(e);
  }
}

// 전부 읽기만 하는 조회. run·platform을 바꿔 끼울 수 있게 해서 Windows가 아닌 곳에서도 시험할 수 있습니다.
export async function collectAll({ platform = process.platform, run = runPowerShell, now = new Date() } = {}) {
  const win = platform === 'win32';
  const onlyWin = (script, parse) => (win ? viaPowerShell(run, script, parse) : Promise.resolve({ error: WIN_ONLY }));
  const firewallRead = async () => {
    if (!win) return { error: WIN_ONLY };
    const first = await viaPowerShell(run, PS.firewall, parseFirewall);
    if (!first.error) return first;
    const second = await viaPowerShell(run, PS.firewallReg, parseFirewall);
    return second.error ? first : second; // 둘 다 안 되면 첫 번째 이유를 보여 줍니다.
  };
  const networkRead = async () => {
    if (!win) return readNetworkBasic();
    const first = await viaPowerShell(run, PS.network, parseNetwork);
    return first.error ? readNetworkBasic() : first;
  };
  const [cpu, disk, firewall, defender, update, ports, startup, network, eventlog] = await Promise.all([
    readCpu(),
    readDisk(platform),
    firewallRead(),
    onlyWin(PS.defender, parseDefender),
    onlyWin(PS.update, (o) => parseUpdate(o, now)),
    onlyWin(PS.ports, (o) => parseCount(o, '포트')),
    onlyWin(PS.startup, (o) => parseCount(o, '시작프로그램')),
    networkRead(),
    onlyWin(PS.events, parseEvents),
  ]);
  return { cpu, memory: readMemory(), disk, firewall, defender, update, ports, startup, network, eventlog };
}
