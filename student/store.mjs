// 기록: 조회할 때마다 시각과 결과를 한 줄씩 파일에 남깁니다. 숫자·상태·시각만 저장합니다.
// (PC 이름, 사용자 이름, 프로그램 이름, 파일 이름은 저장하지 않습니다.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 500;

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const readAll = () => {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 깨진 줄은 건너뜁니다.
      }
    }
    return out;
  };
  // 줄 수를 기억해 두었다가, 한도를 넘을 때만 파일을 다시 읽어 줄입니다. (조회할 때마다 전체를 읽지 않아요)
  let n = null;
  return {
    file,
    append(entry) {
      if (n === null) n = readAll().length;
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      n += 1;
      if (n > KEEP + 100) {
        const kept = readAll().slice(-KEEP);
        fs.writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''));
        n = kept.length;
      }
    },
    read(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), KEEP);
      return readAll().slice(-n);
    },
    count: () => readAll().length,
    clear() {
      fs.writeFileSync(file, '');
      n = 0;
    },
  };
}

// 화면에 저장하는 모양만 남기고 나머지는 버립니다.
export function toEntry({ items, summary }, mode, at = new Date()) {
  return {
    at: at.toISOString(),
    mode,
    summary: summary.text,
    items: items.map((i) => ({ id: i.id, label: i.label, status: i.status, text: i.text, value: i.value, hint: i.hint, reason: i.reason || '', source: i.source || '' })),
  };
}

// 파일을 쓸 수 없는 PC(쓰기 금지 폴더 등)나 기록을 남기기 싫을 때: 창을 닫으면 사라지는 메모리 저장소
export function createMemoryStore() {
  let rows = [];
  return {
    file: null,
    append(entry) {
      rows.push(entry);
      if (rows.length > KEEP) rows = rows.slice(-KEEP);
    },
    read(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), KEEP);
      return rows.slice(-n);
    },
    count: () => rows.length,
    clear() {
      rows = [];
    },
  };
}

// 기록 저장 위치를 고릅니다: 프로젝트 폴더 → 임시 폴더 → 메모리 순으로 쓸 수 있는 곳을 씁니다.
export function openStore(dir, name, { save = true } = {}) {
  if (!save) return { store: createMemoryStore(), where: 'memory' };
  const tries = [
    [dir, 'folder'],
    [path.join(os.tmpdir(), 'pc-dashboard-data'), 'temp'],
  ];
  for (const [d, where] of tries) {
    try {
      const file = path.join(d, name);
      const store = createStore(file);
      fs.accessSync(d, fs.constants.W_OK);
      fs.appendFileSync(file, ''); // 실제로 쓸 수 있는지 확인
      return { store, where };
    } catch {
      // 다음 위치를 시도합니다.
    }
  }
  return { store: createMemoryStore(), where: 'memory' };
}
