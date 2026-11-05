// 판정: 읽은 값을 "정상 / 주의 / 확인 불가" 세 가지로만 나눕니다. (값을 읽기만 하며 아무것도 바꾸지 않습니다.)
export const STATUS = { OK: 'ok', WARN: 'warn', UNKNOWN: 'unknown' };
export const STATUS_LABEL = { ok: '정상', warn: '주의', unknown: '확인 불가' };

// 처음 정한 기준값입니다. 학습용 기준이며 공식 보안 기준이 아닙니다.
export const THRESHOLDS = {
  cpuWarn: 70, // CPU 사용률이 이 값 이상이면 주의
  memWarn: 80, // 메모리 사용률이 이 값 이상이면 주의
  diskFreeWarn: 15, // 디스크 남은 공간(%)이 이 값 이하이면 주의
  updateDaysWarn: 60, // 마지막 Windows 업데이트 설치가 이 일수보다 오래되면 주의
  portsWarn: 40, // 바깥에서 접속을 기다리는 포트가 이 개수보다 많으면 주의
  startupWarn: 15, // 시작 때 자동 실행되는 프로그램이 이 개수보다 많으면 주의
  eventsWarn: 100, // 최근 24시간 Windows 경고·오류가 이 건수보다 많으면 주의 (침해 판정이 아님)
};

export const CORE_IDS = ['cpu', 'memory', 'disk', 'firewall'];
export const CHECK_IDS = ['defender', 'update', 'ports', 'startup'];
export const LINK_IDS = ['network', 'firewall', 'eventlog'];

// 값을 어디서 읽었는지 화면에 보여 주기 위한 출처 표시
export const SOURCES = {
  cpu: 'Node 기본 기능(os.cpus), 0.5초 간격 비교',
  memory: 'Node 기본 기능(os.totalmem·freemem), Linux는 /proc/meminfo',
  disk: 'Node 기본 기능(fs.statfs), 시스템 드라이브',
  firewall: 'PowerShell Get-NetFirewallProfile (막히면 레지스트리 읽기)',
  defender: 'PowerShell Get-MpComputerStatus',
  update: 'PowerShell Get-HotFix',
  ports: 'PowerShell Get-NetTCPConnection',
  startup: 'PowerShell Get-CimInstance Win32_StartupCommand',
  network: 'PowerShell Get-NetAdapter (막히면 Node os.networkInterfaces)',
  eventlog: 'PowerShell Get-WinEvent, System·Application 최근 24시간',
};

const pct = (n) => `${Math.round(n)}%`;
const bad = (r) => !r || typeof r !== 'object' || r.error !== undefined;
const PERMISSION = /denied|unauthori[sz]ed|permission|권한|거부|액세스/i;

function item(id, label, status, text, { value = null, hint = '', reason = '' } = {}) {
  return { id, label, status, text, value, hint, reason, source: SOURCES[id] || '' };
}
function unknown(id, label, r) {
  const why = r && typeof r.error === 'string' && r.error ? r.error : '값을 읽지 못했어요';
  const text = PERMISSION.test(why) ? '확인 불가 · 권한 없음' : '확인 불가';
  return item(id, label, STATUS.UNKNOWN, text, {
    reason: why,
    hint: `${why}. 읽지 못했으므로 정상이라고 말할 수 없어요.`,
  });
}

export function judgeCpu(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.pct)) return unknown('cpu', 'CPU', r);
  const warn = r.pct >= t.cpuWarn;
  return item('cpu', 'CPU', warn ? STATUS.WARN : STATUS.OK, `사용률 ${pct(r.pct)}`, {
    value: r.pct,
    hint: warn ? '두뇌가 많이 바빠요. 작업 관리자(Ctrl+Shift+Esc)에서 무엇이 쓰는지 볼 수 있어요.' : '',
  });
}

export function judgeMemory(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.pct)) return unknown('memory', '메모리', r);
  const warn = r.pct >= t.memWarn;
  return item('memory', '메모리', warn ? STATUS.WARN : STATUS.OK, `사용률 ${pct(r.pct)}`, {
    value: r.pct,
    hint: warn ? '작업 공간이 많이 찼어요. 안 쓰는 프로그램을 닫아 보세요.' : '',
  });
}

export function judgeDisk(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.freePct)) return unknown('disk', '디스크', r);
  const warn = r.freePct <= t.diskFreeWarn;
  const gb = Number.isFinite(r.freeGB) ? ` (${r.freeGB.toFixed(1)}GB)` : '';
  return item('disk', '디스크', warn ? STATUS.WARN : STATUS.OK, `남은 공간 ${pct(r.freePct)}${gb}`, {
    value: r.freePct,
    hint: warn ? '저장 공간이 부족해요. 설정 > 시스템 > 저장소에서 정리해 보세요.' : '',
  });
}

export function judgeFirewall(r) {
  if (bad(r) || !Array.isArray(r.profiles) || r.profiles.length === 0) return unknown('firewall', '방화벽', r);
  const off = r.profiles.filter((p) => !p.enabled).map((p) => p.name);
  if (off.length === 0) return item('firewall', '방화벽', STATUS.OK, '켜짐');
  const all = off.length === r.profiles.length;
  return item('firewall', '방화벽', STATUS.WARN, all ? '꺼짐' : `일부 꺼짐 (${off.join(', ')})`, {
    hint: 'Windows 보안 > 방화벽 및 네트워크 보호에서 상태를 확인해 보세요. 이 앱은 켜거나 끄지 않아요.',
  });
}

export function judgeDefender(r) {
  if (bad(r) || typeof r.realtime !== 'boolean') return unknown('defender', 'Windows 보안 실시간 보호', r);
  return r.realtime
    ? item('defender', 'Windows 보안 실시간 보호', STATUS.OK, '켜짐')
    : item('defender', 'Windows 보안 실시간 보호', STATUS.WARN, '꺼짐', {
        hint: '다른 백신을 쓰는 중이면 정상일 수 있어요. 아니라면 Windows 보안 > 바이러스 및 위협 방지에서 확인하세요.',
      });
}

export function judgeUpdate(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.days)) return unknown('update', 'Windows 업데이트', r);
  const warn = r.days > t.updateDaysWarn;
  const text = r.days <= 0 ? '오늘 설치' : `마지막 설치 ${r.days}일 전`;
  return item('update', 'Windows 업데이트', warn ? STATUS.WARN : STATUS.OK, text, {
    value: r.days,
    hint: warn ? '업데이트가 오래됐어요. 설정 > Windows 업데이트에서 확인해 보세요.' : '',
  });
}

export function judgePorts(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.count)) return unknown('ports', '열린 포트', r);
  const warn = r.count > t.portsWarn;
  return item('ports', '열린 포트', warn ? STATUS.WARN : STATUS.OK, `바깥 접속 대기 ${r.count}개`, {
    value: r.count,
    hint: warn ? '바깥에서 접속을 기다리는 문이 많아요. 개수만 센 것이며 위험하다는 뜻은 아니에요.' : '',
  });
}

export function judgeStartup(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.count)) return unknown('startup', '시작프로그램', r);
  const warn = r.count > t.startupWarn;
  return item('startup', '시작프로그램', warn ? STATUS.WARN : STATUS.OK, `자동 실행 ${r.count}개`, {
    value: r.count,
    hint: warn ? '켤 때 같이 켜지는 프로그램이 많아요. 작업 관리자 > 시작 앱에서 볼 수 있어요.' : '',
  });
}

export function judgeNetwork(r) {
  if (bad(r) || typeof r.connected !== 'boolean') return unknown('network', '네트워크 연결', r);
  if (!r.connected) {
    return item('network', '네트워크 연결', STATUS.WARN, '연결 안 됨', {
      hint: '네트워크 케이블이나 Wi-Fi 연결을 확인해 보세요. 연결 종류만 읽고 주소(IP)·이름은 저장하지 않아요.',
    });
  }
  const kinds = Array.isArray(r.kinds) && r.kinds.length ? r.kinds.join('·') : '종류 알 수 없음';
  return item('network', '네트워크 연결', STATUS.OK, kinds === '종류 알 수 없음' ? '연결됨 (종류 알 수 없음)' : `${kinds} 연결됨`);
}

export function judgeEventLog(r, t = THRESHOLDS) {
  if (bad(r) || !Number.isFinite(r.total)) return unknown('eventlog', 'Windows 경고·오류', r);
  const warn = r.total > t.eventsWarn;
  const n = r.capped ? `${r.total}건 이상` : `${r.total}건`;
  return item('eventlog', 'Windows 경고·오류', warn ? STATUS.WARN : STATUS.OK, `최근 24시간 ${n} · 침해 판정 아님`, {
    value: r.total,
    hint: warn
      ? '이벤트 뷰어 > Windows 로그 > System·Application에서 볼 수 있어요. 건수만 센 것이며 침해라는 뜻은 아니에요.'
      : '',
  });
}

export function judgeAll(readings = {}, t = THRESHOLDS) {
  const items = [
    judgeCpu(readings.cpu, t),
    judgeMemory(readings.memory, t),
    judgeDisk(readings.disk, t),
    judgeFirewall(readings.firewall),
    judgeDefender(readings.defender),
    judgeUpdate(readings.update, t),
    judgePorts(readings.ports, t),
    judgeStartup(readings.startup, t),
    judgeNetwork(readings.network),
    judgeEventLog(readings.eventlog, t),
  ];
  return { items, summary: summarize(items) };
}

export function summarize(items) {
  const total = items.length;
  const ok = items.filter((i) => i.status === STATUS.OK).length;
  const warn = items.filter((i) => i.status === STATUS.WARN).length;
  const unk = items.filter((i) => i.status === STATUS.UNKNOWN).length;
  return { total, ok, warn, unknown: unk, text: `점검 ${total}개 중 ${ok}개 정상` };
}
