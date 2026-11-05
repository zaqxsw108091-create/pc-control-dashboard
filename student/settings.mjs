// 설정: 주의 기준값을 화면에서 바꿀 수 있게 검증하고 저장합니다. (값을 읽기만 하는 앱의 "기준"만 바뀌고, PC 설정은 바뀌지 않아요.)
import fs from 'node:fs';
import { THRESHOLDS } from './judge.mjs';

// 기준마다 이름·단위·허용 범위. 화면 입력칸도 이 표로 만듭니다.
export const FIELDS = [
  { key: 'cpuWarn', label: 'CPU 사용률', unit: '% 이상이면 주의', min: 1, max: 100 },
  { key: 'memWarn', label: '메모리 사용률', unit: '% 이상이면 주의', min: 1, max: 100 },
  { key: 'diskFreeWarn', label: '디스크 남은 공간', unit: '% 이하이면 주의', min: 1, max: 99 },
  { key: 'updateDaysWarn', label: 'Windows 업데이트', unit: '일보다 오래되면 주의', min: 1, max: 3650 },
  { key: 'portsWarn', label: '열린 포트', unit: '개보다 많으면 주의', min: 1, max: 10000 },
  { key: 'startupWarn', label: '시작프로그램', unit: '개보다 많으면 주의', min: 1, max: 1000 },
  { key: 'eventsWarn', label: 'Windows 경고·오류', unit: '건보다 많으면 주의', min: 1, max: 100000 },
];

// 입력을 검사해서 { ok: true, value } 또는 { ok: false, error } 로 돌려줍니다. 빠진 값은 처음 값으로 채워요.
export function sanitizeThresholds(input, base = THRESHOLDS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '기준값 모양이 올바르지 않아요' };
  const value = { ...base };
  for (const f of FIELDS) {
    if (input[f.key] === undefined) continue;
    const n = input[f.key];
    if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, error: `${f.label}은(는) 정수여야 해요`, field: f.key };
    if (n < f.min || n > f.max) return { ok: false, error: `${f.label}은(는) ${f.min}~${f.max} 사이여야 해요`, field: f.key };
    value[f.key] = n;
  }
  return { ok: true, value };
}

// 파일(JSON)에 저장하는 설정 저장소. file이 없거나 쓸 수 없으면 메모리에만 둡니다.
export function createSettingsStore(file = null) {
  let current = { ...THRESHOLDS };
  if (file) {
    try {
      const saved = sanitizeThresholds(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (saved.ok) current = saved.value;
    } catch {
      // 파일이 없거나 깨졌으면 처음 값으로 시작해요.
    }
  }
  const persist = () => {
    if (!file) return false;
    try {
      fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  return {
    file,
    get: () => ({ ...current }),
    set(next) {
      current = { ...next };
      return persist();
    },
    reset() {
      current = { ...THRESHOLDS };
      if (file) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // 지우지 못해도 메모리 값은 처음 값으로 돌아가요.
        }
      }
    },
  };
}
