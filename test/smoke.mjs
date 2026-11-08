// 실제 PC에서 한 번 돌려 보는 점검(자동 시험과 별도). CI의 Windows 서버에서 실행해 진짜 PowerShell 값으로 확인합니다.
//   node test/smoke.mjs
// 프로그램 이름은 출력하지 않고 개수와 상태만 보여 줍니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createDashboard } from '../student/server.mjs';
import { runPowerShell } from '../student/collect.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-smoke-'));
const app = createDashboard({ dataDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const post = (p) => fetch(base + p, { method: 'POST' }).then((r) => r.json());

try {
  const first = await post('/api/check');
  const second = await post('/api/check');
  const item = (e) => e.items.find((i) => i.id === 'baseline');
  for (const i of second.entry.items) console.log(`- [${i.status}] ${i.label}: ${i.text}`);
  console.log(`기준선: ${first.baseline.exists ? '저장됨' : '없음'} · 기억한 포트 ${first.baseline.ports ? first.baseline.ports.length : '-'}개 · 시작프로그램 ${first.baseline.startupCount ?? '-'}개`);
  console.log(`두 번째 조회의 달라진 것: ${second.baseline.changes.length}건 (${second.baseline.changes.map((c) => c.kind).join(', ') || '없음'}) · 비교 못 한 항목: ${second.baseline.skipped.join(', ') || '없음'}`);

  assert.equal(second.entry.items.length, 11);
  if (process.platform === 'win32') {
    // 한글 프로그램 이름·오류 문구가 깨지지 않고 돌아오는지
    const ko = (await runPowerShell("Write-Output '한글 확인 · 메신저'")).trim();
    console.log(`PowerShell 한글 왕복: ${ko}`);
    assert.equal(ko, '한글 확인 · 메신저');
    assert.equal(first.baseline.exists, true, 'Windows에서는 기준선이 만들어져야 해요');
    assert.match(item(first.entry).text, /기준선으로 저장/);
    assert.notEqual(item(second.entry).status, 'unknown');
    assert.ok(Array.isArray(first.baseline.ports), '포트 목록을 읽어야 해요');
    assert.ok(Number.isInteger(first.baseline.startupCount), '시작프로그램 목록을 읽어야 해요');
    const saved = fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8');
    assert.match(saved, /"startup":\[("[0-9a-f]{16}",?)*\]/, '시작프로그램은 지문만 저장');
  } else {
    assert.equal(item(second.entry).status, 'unknown');
  }
  console.log('SMOKE OK');
} finally {
  await new Promise((r) => app.server.close(r));
}
