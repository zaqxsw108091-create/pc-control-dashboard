// 예제 값: 실제 PC가 아니라 정해 둔 가짜 값입니다. 화면에는 "예제"라고 표시됩니다.
const CPU = [32, 45, 58, 74, 41, 29];
const MEM = [58, 61, 66, 83, 70, 60];
const DISK = [9, 21, 22, 9, 18, 19];
const FW = ['on', 'unknown', 'on', 'partial', 'on', 'off'];

// 기준선 비교를 보여 주기 위한 예제 목록. 2번째에 새 시작프로그램, 3번째에 새 포트가 생겨요.
const BASE_PORTS = [
  { port: 135, proc: '예제-서비스A' },
  { port: 445, proc: '예제-시스템' },
  { port: 5040, proc: '예제-서비스B' },
];
const BASE_STARTUP = ['예제-클라우드 동기화', '예제-보안 알림 아이콘', '예제-메신저'];
function demoPorts(i) {
  return i === 3 || i === 4 ? [...BASE_PORTS, { port: 4444, proc: '예제-알 수 없는 프로그램' }] : BASE_PORTS;
}
function demoStartup(i) {
  return i >= 2 && i <= 4 ? [...BASE_STARTUP, '예제-업데이트 도우미'] : BASE_STARTUP;
}

export function demoReadings(n = 0) {
  const i = ((n % 6) + 6) % 6;
  const fw = FW[i];
  return {
    cpu: { pct: CPU[i] },
    memory: { pct: MEM[i] },
    disk: { freePct: DISK[i], freeGB: (DISK[i] / 100) * 512, totalGB: 512, drive: '예제' },
    firewall:
      fw === 'unknown'
        ? { error: '예제: 방화벽 상태를 읽지 못한 경우' }
        : { profiles: [{ name: 'Domain', enabled: fw === 'on' }, { name: 'Private', enabled: fw === 'on' || fw === 'partial' }, { name: 'Public', enabled: fw !== 'off' && fw !== 'partial' }] },
    defender: { realtime: i !== 5 },
    update: { days: [3, 12, 70, 5, 8, 20][i] },
    ports: { count: [18, 21, 24, 45, 19, 22][i], ports: demoPorts(i) },
    startup: { count: [9, 10, 18, 11, 9, 12][i], names: demoStartup(i) },
    network: i === 3 ? { connected: false, kinds: [] } : { connected: true, kinds: [['유선'], ['유선'], ['무선'], [], ['유선'], ['유선', '무선']][i] },
    eventlog: { system: [1, 4, 22, 90, 3, 20][i], application: [2, 8, 18, 40, 5, 35][i], total: [3, 12, 40, 130, 8, 55][i], capped: false },
  };
}
