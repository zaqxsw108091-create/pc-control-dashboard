// 기준선 비교: 처음(또는 내가 "괜찮다"고 저장한) 상태와 지금 상태를 비교해 "달라진 것"을 찾습니다.
// 침해(공격)를 판정하지 않습니다. 새로 생긴 것을 알려 주고, 판단은 사람이 합니다.
//
// 개인정보 원칙
// - 파일에는 포트 번호, 방화벽 켜짐/꺼짐, Windows 보안 켜짐/꺼짐만 그대로 저장합니다.
// - 시작프로그램 "이름"은 파일에 저장하지 않고, 이 PC에서만 만든 무작위 값(salt)을 섞은 지문(해시)만 저장합니다.
// - 프로그램 이름은 지금 조회한 값에서만 화면에 보여 주고, 기록·CSV·기준선 파일에는 남기지 않습니다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { STATUS } from './judge.mjs';

export const BASELINE_KEYS = ['ports', 'startup', 'firewall', 'defender'];
const KEY_LABEL = { ports: '열린 포트', startup: '시작프로그램', firewall: '방화벽', defender: 'Windows 보안 실시간 보호' };
const FW_LABEL = { Domain: '도메인', Private: '개인', Public: '공용' };

export const newSalt = () => crypto.randomBytes(16).toString('hex');

export function fingerprint(salt, name) {
  return crypto.createHash('sha256').update(`${salt}\0${String(name).trim().toLowerCase()}`).digest('hex').slice(0, 16);
}

const okObj = (r) => r && typeof r === 'object' && r.error === undefined;

// 지금 읽은 값에서 비교에 쓸 모양만 뽑습니다. 읽지 못한 항목은 null.
export function snapshot(readings = {}, salt) {
  const p = readings.ports;
  const s = readings.startup;
  const f = readings.firewall;
  const d = readings.defender;
  return {
    ports: okObj(p) && Array.isArray(p.ports) ? [...new Set(p.ports.map((x) => x.port).filter(Number.isInteger))].sort((a, b) => a - b) : null,
    startup: okObj(s) && Array.isArray(s.names) ? [...new Set(s.names.map((n) => fingerprint(salt, n)))].sort() : null,
    firewall:
      okObj(f) && Array.isArray(f.profiles) && f.profiles.length
        ? Object.fromEntries(f.profiles.filter((x) => typeof x.name === 'string' && typeof x.enabled === 'boolean').map((x) => [x.name, x.enabled]))
        : null,
    defender: okObj(d) && typeof d.realtime === 'boolean' ? d.realtime : null,
  };
}

export const hasAny = (snap) => BASELINE_KEYS.some((k) => snap[k] !== null && snap[k] !== undefined);

export function createBaseline(readings, { salt = newSalt(), at = new Date() } = {}) {
  return { version: 1, createdAt: at.toISOString(), salt, ...snapshot(readings, salt) };
}

// 기준선과 지금을 비교합니다.
//   changes: [{ kind, severity: 'warn'|'info', text, detail }]  (detail은 화면 표시용 이름, 저장하지 않음)
//   skipped: 읽지 못해서 비교하지 않은 항목 이름
//   filled:  기준선을 만들 때 읽지 못했다가 이번에 처음 읽혀서 기준선에 채운 항목
//   next:    채운 항목을 반영한 기준선 (filled가 비어 있으면 그대로)
export function compareBaseline(base, readings = {}) {
  const now = snapshot(readings, base.salt);
  const changes = [];
  const skipped = [];
  const filled = [];
  const next = { ...base };

  for (const k of BASELINE_KEYS) {
    if (now[k] === null) {
      skipped.push(KEY_LABEL[k]);
      continue;
    }
    if (base[k] === null || base[k] === undefined) {
      next[k] = now[k];
      filled.push(KEY_LABEL[k]);
    }
  }

  if (now.ports && base.ports) {
    const before = new Set(base.ports);
    const nowSet = new Set(now.ports);
    const procOf = new Map((readings.ports.ports || []).map((x) => [x.port, x.proc]));
    for (const port of now.ports) {
      if (!before.has(port)) {
        changes.push({ kind: 'port-new', severity: 'warn', text: `새로 열린 포트 ${port}`, detail: procOf.get(port) ? `연 프로그램: ${procOf.get(port)}` : '' });
      }
    }
    const gone = base.ports.filter((x) => !nowSet.has(x));
    if (gone.length) changes.push({ kind: 'port-gone', severity: 'info', text: `닫힌 포트 ${gone.join(', ')}`, detail: '' });
  }

  if (now.startup && base.startup) {
    const before = new Set(base.startup);
    const nowSet = new Set(now.startup);
    for (const name of [...new Set(readings.startup.names)]) {
      if (!before.has(fingerprint(base.salt, name))) changes.push({ kind: 'startup-new', severity: 'warn', text: '새 시작프로그램', detail: name });
    }
    const gone = base.startup.filter((x) => !nowSet.has(x)).length;
    if (gone) changes.push({ kind: 'startup-gone', severity: 'info', text: `없어진 시작프로그램 ${gone}개`, detail: '' });
  }

  if (now.firewall && base.firewall) {
    for (const [name, on] of Object.entries(now.firewall)) {
      const was = base.firewall[name];
      if (typeof was !== 'boolean' || was === on) continue;
      const label = `방화벽 ${FW_LABEL[name] || name} 프로필`;
      changes.push(on ? { kind: 'firewall-on', severity: 'info', text: `${label} 켜짐`, detail: '' } : { kind: 'firewall-off', severity: 'warn', text: `${label} 꺼짐`, detail: '' });
    }
  }

  if (now.defender !== null && typeof base.defender === 'boolean' && base.defender !== now.defender) {
    changes.push(
      now.defender
        ? { kind: 'defender-on', severity: 'info', text: 'Windows 보안 실시간 보호 켜짐', detail: '' }
        : { kind: 'defender-off', severity: 'warn', text: 'Windows 보안 실시간 보호 꺼짐', detail: '' },
    );
  }

  return { changes, skipped, filled, next };
}

// "내가 한 일이라 괜찮다"고 받아들일 때: 지금 읽은 값으로 기준선을 바꾸되, 이번에 읽지 못한 항목은 예전 값을 지킵니다.
export function acceptBaseline(base, readings, at = new Date()) {
  const salt = base && base.salt ? base.salt : newSalt();
  const snap = snapshot(readings, salt);
  const out = { version: 1, createdAt: at.toISOString(), salt };
  for (const k of BASELINE_KEYS) out[k] = snap[k] !== null ? snap[k] : base ? base[k] ?? null : null;
  return out;
}

// 화면·기록에 남는 판정 항목. 글자에는 개수만 넣고 프로그램 이름은 넣지 않습니다(기록 파일에 남지 않게).
export function judgeBaseline(cmp, { created = false } = {}) {
  const base = { id: 'baseline', label: '기준선 비교', value: null, reason: '', source: '처음 저장한 상태와 비교 (포트·시작프로그램·방화벽·Windows 보안)' };
  if (!cmp) {
    return { ...base, status: STATUS.UNKNOWN, text: '확인 불가 · 비교할 값이 없어요', reason: '비교할 항목을 하나도 읽지 못했어요', hint: '포트·시작프로그램·방화벽·Windows 보안을 읽지 못해 기준선을 만들 수 없어요. Windows에서 실행하면 비교할 수 있어요.' };
  }
  const warn = cmp.changes.filter((c) => c.severity === 'warn');
  const info = cmp.changes.filter((c) => c.severity === 'info');
  const note = cmp.skipped.length ? ` (${cmp.skipped.join('·')}은 읽지 못해 비교하지 않음)` : '';
  if (created) return { ...base, status: STATUS.OK, text: '지금 상태를 기준선으로 저장했어요', hint: `다음 조회부터 이 상태와 비교해서 새로 생긴 것을 알려 줘요.${note}` };
  if (warn.length) {
    const counts = {};
    for (const c of warn) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const parts = [];
    if (counts['port-new']) parts.push(`새 포트 ${counts['port-new']}개`);
    if (counts['startup-new']) parts.push(`새 시작프로그램 ${counts['startup-new']}개`);
    if (counts['firewall-off']) parts.push(`방화벽 꺼짐 ${counts['firewall-off']}개`);
    if (counts['defender-off']) parts.push('Windows 보안 꺼짐');
    return {
      ...base,
      status: STATUS.WARN,
      text: `달라진 것: ${parts.join(' · ')}`,
      value: warn.length,
      hint: `"달라진 것" 상자에서 무엇이 바뀌었는지 확인하세요. 내가 설치·설정한 것이면 "지금 상태를 기준선으로"를 누르면 돼요. 침해 판정이 아니에요.${note}`,
    };
  }
  if (info.length) return { ...base, status: STATUS.OK, text: `기준선과 거의 같음 (닫히거나 켜진 것 ${info.length}건)`, value: 0, hint: `위험 쪽 변화는 없어요.${note}` };
  return { ...base, status: STATUS.OK, text: '기준선과 같음', value: 0, hint: note ? `달라진 것이 없어요.${note}` : '' };
}

// 기준선 파일 저장소. file이 없으면(예제 모드·저장 안 함) 메모리에만 둡니다.
export function createBaselineStore(file = null) {
  let current = null;
  if (file) {
    try {
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (b && b.version === 1 && typeof b.salt === 'string' && typeof b.createdAt === 'string') current = b;
    } catch {
      // 없거나 깨졌으면 다음 조회 때 새로 만들어요.
    }
  }
  return {
    file,
    get: () => (current ? { ...current } : null),
    set(b) {
      current = { ...b };
      if (!file) return false;
      try {
        fs.writeFileSync(file, `${JSON.stringify(current)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      current = null;
      if (file) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // 지우지 못해도 메모리에서는 지워져요.
        }
      }
    },
  };
}
