import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { judgeAll, judgeCpu, judgeMemory, judgeDisk, judgeFirewall, judgeDefender, judgeUpdate, judgePorts, judgeStartup, THRESHOLDS } from '../student/judge.mjs';
import { collectAll, parseFirewall, parseDefender, parseUpdate, parseCount, powerShellPath, PS } from '../student/collect.mjs';
import { createStore, createMemoryStore, openStore, toEntry } from '../student/store.mjs';
import { demoReadings } from '../student/demo.mjs';
import { createDashboard } from '../student/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'student-test-'));

test('판정: 경계값에서 정상/주의가 갈린다', () => {
  assert.equal(judgeCpu({ pct: 69.9 }).status, 'ok');
  assert.equal(judgeCpu({ pct: THRESHOLDS.cpuWarn }).status, 'warn');
  assert.equal(judgeMemory({ pct: 79 }).status, 'ok');
  assert.equal(judgeMemory({ pct: 80 }).status, 'warn');
  assert.equal(judgeDisk({ freePct: 16 }).status, 'ok');
  assert.equal(judgeDisk({ freePct: 15 }).status, 'warn');
  assert.equal(judgeUpdate({ days: 60 }).status, 'ok');
  assert.equal(judgeUpdate({ days: 61 }).status, 'warn');
  assert.equal(judgePorts({ count: 40 }).status, 'ok');
  assert.equal(judgePorts({ count: 41 }).status, 'warn');
  assert.equal(judgeStartup({ count: 15 }).status, 'ok');
  assert.equal(judgeStartup({ count: 16 }).status, 'warn');
});

test('판정: 읽지 못하면 정상이 아니라 확인 불가', () => {
  for (const f of [judgeCpu, judgeMemory, judgeDisk, judgeFirewall, judgeDefender, judgeUpdate, judgePorts, judgeStartup]) {
    for (const bad of [undefined, null, {}, { error: '권한이 없어요' }, { pct: NaN, freePct: NaN, days: NaN, count: NaN }]) {
      const r = f(bad);
      assert.equal(r.status, 'unknown', `${f.name}(${JSON.stringify(bad)})`);
      assert.equal(r.text, '확인 불가');
    }
  }
  assert.match(judgeCpu({ error: '권한이 없어요' }).hint, /권한이 없어요/);
});

test('판정: 방화벽은 모두 켜짐/일부 꺼짐/모두 꺼짐을 구분한다', () => {
  const p = (a, b, c) => ({ profiles: [{ name: 'Domain', enabled: a }, { name: 'Private', enabled: b }, { name: 'Public', enabled: c }] });
  assert.equal(judgeFirewall(p(true, true, true)).status, 'ok');
  const some = judgeFirewall(p(true, true, false));
  assert.equal(some.status, 'warn');
  assert.match(some.text, /Public/);
  assert.equal(judgeFirewall(p(false, false, false)).text, '꺼짐');
  assert.equal(judgeFirewall({ profiles: [] }).status, 'unknown');
});

test('판정: 요약은 항목 8개 기준 "점검 N개 중 M개 정상"', () => {
  const { items, summary } = judgeAll(demoReadings(0));
  assert.equal(items.length, 8);
  assert.equal(summary.total, 8);
  assert.equal(summary.ok + summary.warn + summary.unknown, 8);
  assert.match(summary.text, /^점검 8개 중 \d개 정상$/);
});

test('예제 값: 6번 안에 정상·주의·확인 불가가 모두 나온다', () => {
  const seen = new Set();
  for (let n = 0; n < 6; n++) for (const i of judgeAll(demoReadings(n)).items) seen.add(i.status);
  assert.deepEqual([...seen].sort(), ['ok', 'unknown', 'warn']);
});

test('수집 해석: PowerShell 출력(배열/한 개/이상한 값)', () => {
  assert.deepEqual(parseFirewall('[{"Name":"Domain","Enabled":true},{"Name":"Public","Enabled":false}]').profiles.map((x) => x.enabled), [true, false]);
  assert.equal(parseFirewall('{"Name":"Domain","Enabled":true}').profiles.length, 1);
  assert.throws(() => parseFirewall('not json'));
  assert.throws(() => parseFirewall('[]'));
  assert.equal(parseDefender('{"RealTime":true}').realtime, true);
  assert.throws(() => parseDefender('{"RealTime":"yes"}'));
  assert.equal(parseUpdate('2026-11-01\r\n', new Date(2026, 10, 5)).days, 4);
  assert.equal(parseUpdate('2026-11-05', new Date(2026, 10, 5)).days, 0);
  assert.throws(() => parseUpdate('none'));
  assert.equal(parseCount('17\r\n', '포트').count, 17);
  assert.throws(() => parseCount('abc', '포트'));
});

test('수집: Windows 흉내 (가짜 PowerShell 결과)', async () => {
  const seen = [];
  const run = async (script) => {
    seen.push(script);
    if (script === PS.firewall) return '[{"Name":"Domain","Enabled":true},{"Name":"Private","Enabled":true},{"Name":"Public","Enabled":true}]';
    if (script === PS.defender) return '{"RealTime":true}';
    if (script === PS.update) return '2026-10-20';
    if (script === PS.ports) return '22';
    if (script === PS.startup) throw new Error('접근이 거부되었어요');
    throw new Error('모르는 명령');
  };
  const r = await collectAll({ platform: 'win32', run, now: new Date(2026, 10, 5) });
  const j = judgeAll(r);
  const by = Object.fromEntries(j.items.map((i) => [i.id, i]));
  assert.equal(by.firewall.status, 'ok');
  assert.equal(by.defender.status, 'ok');
  assert.equal(by.update.text, '마지막 설치 16일 전');
  assert.equal(by.ports.status, 'ok');
  assert.equal(by.startup.status, 'unknown');
  assert.match(by.startup.hint, /접근이 거부/);
  assert.equal(seen.length, 5);
});

test('수집: 읽기 명령만 쓴다 (설정을 바꾸는 동사 없음)', () => {
  for (const script of Object.values(PS)) {
    assert.doesNotMatch(script, /\b(Set|New|Remove|Enable|Disable|Add|Start|Stop|Restart|Invoke|Update)-[A-Za-z]+/);
  }
});

test('수집: Windows가 아니면 Windows 전용 항목은 확인 불가 (명령을 실행하지 않음)', async () => {
  let called = 0;
  const r = await collectAll({ platform: 'linux', run: async () => { called++; return ''; } });
  assert.equal(called, 0);
  const j = judgeAll(r);
  for (const id of ['firewall', 'defender', 'update', 'ports', 'startup']) assert.equal(j.items.find((i) => i.id === id).status, 'unknown');
  assert.ok(['ok', 'warn'].includes(j.items.find((i) => i.id === 'cpu').status));
  assert.ok(['ok', 'warn'].includes(j.items.find((i) => i.id === 'disk').status));
});

test('기록: 저장·읽기·깨진 줄 건너뛰기·개수 제한', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'h.jsonl');
  const s = createStore(file);
  for (let k = 0; k < 3; k++) s.append(toEntry(judgeAll(demoReadings(k)), 'demo', new Date(2026, 10, 5, 12, k)));
  fs.appendFileSync(file, '깨진 줄\n');
  assert.equal(s.read(10).length, 3);
  assert.equal(s.read(2).length, 2);
  for (let k = 0; k < 700; k++) s.append(toEntry(judgeAll(demoReadings(k)), 'demo'));
  assert.ok(s.count() <= 600);
  const e = s.read(1)[0];
  assert.deepEqual(Object.keys(e).sort(), ['at', 'items', 'mode', 'summary']);
  assert.deepEqual(Object.keys(e.items[0]).sort(), ['hint', 'id', 'label', 'status', 'text', 'value']);
});

function call(server, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('서버(예제 모드): 화면·메타·조회·기록·거부', async () => {
  const app = createDashboard({ demo: true, dataDir: tmp() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const page = await call(app.server, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /내 PC 관제 대시보드/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);

    const meta = JSON.parse((await call(app.server, 'GET', '/api/meta')).body);
    assert.equal(meta.demo, true);
    assert.equal(meta.connection, '서버 연결 안 함');
    assert.equal(meta.readOnly, true);

    const before = JSON.parse((await call(app.server, 'GET', '/api/history?limit=100')).body).entries.length;
    assert.equal(before, 12);
    const chk = await call(app.server, 'POST', '/api/check');
    assert.equal(chk.status, 200);
    const entry = JSON.parse(chk.body).entry;
    assert.equal(entry.mode, 'demo');
    assert.equal(entry.items.length, 8);
    assert.equal(JSON.parse((await call(app.server, 'GET', '/api/history')).body).entries.length, before + 1);

    assert.equal((await call(app.server, 'GET', '/api/check')).status, 405);
    assert.equal((await call(app.server, 'POST', '/api/check', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await call(app.server, 'GET', '/api/meta', { Host: 'evil.example' })).status, 403);
    assert.equal((await call(app.server, 'GET', '/nope')).status, 404);
    assert.equal((await call(app.server, 'GET', '/../package.json')).status, 404);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('서버(실제 모드): 수집 함수를 바꿔 끼워도 기록이 남고, 예제와 기록 파일이 분리된다', async () => {
  const dir = tmp();
  const app = createDashboard({ demo: false, dataDir: dir, collect: async () => ({ cpu: { pct: 10 }, memory: { pct: 20 }, disk: { freePct: 50 } }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const r = JSON.parse((await call(app.server, 'POST', '/api/check')).body);
    assert.equal(r.mode, 'real');
    assert.equal(r.entry.items.find((i) => i.id === 'cpu').status, 'ok');
    assert.equal(r.entry.items.find((i) => i.id === 'firewall').status, 'unknown');
    assert.ok(fs.existsSync(path.join(dir, 'history.jsonl')));
    assert.ok(!fs.existsSync(path.join(dir, 'history.demo.jsonl')));
  } finally {
    await new Promise((r2) => app.server.close(r2));
  }
});

test('서버: 수집이 던져도 죽지 않고 500 안내를 돌려준다', async () => {
  const app = createDashboard({ demo: false, dataDir: tmp(), collect: async () => { throw new Error('boom'); } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const r = await call(app.server, 'POST', '/api/check');
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.body).error, 'SERVER_ERROR');
    assert.equal((await call(app.server, 'GET', '/api/meta')).status, 200);
  } finally {
    await new Promise((r2) => app.server.close(r2));
  }
});

test('수집: 방화벽 조회가 막히면 레지스트리 읽기로 한 번 더 시도한다', async () => {
  const tried = [];
  const run = async (script) => {
    tried.push(script);
    if (script === PS.firewall) throw new Error('이 명령은 허용되지 않아요');
    if (script === PS.firewallReg) return '[{"Name":"Domain","Enabled":true},{"Name":"Private","Enabled":true},{"Name":"Public","Enabled":false}]';
    return '5';
  };
  const r = await collectAll({ platform: 'win32', run, now: new Date(2026, 10, 5) });
  assert.deepEqual(tried.filter((t) => t === PS.firewall || t === PS.firewallReg), [PS.firewall, PS.firewallReg]);
  const fw = judgeAll(r).items.find((i) => i.id === 'firewall');
  assert.equal(fw.status, 'warn');
  assert.match(fw.text, /Public/);
});

test('수집: 방화벽 조회 두 가지가 모두 실패하면 첫 번째 이유와 함께 확인 불가', async () => {
  const run = async (script) => {
    if (script === PS.firewall) throw new Error('첫 번째 이유');
    if (script === PS.firewallReg) throw new Error('두 번째 이유');
    return '5';
  };
  const fw = judgeAll(await collectAll({ platform: 'win32', run })).items.find((i) => i.id === 'firewall');
  assert.equal(fw.status, 'unknown');
  assert.match(fw.hint, /첫 번째 이유/);
});

test('수집: 레지스트리 조회도 읽기만 하고, 홑따옴표만 쓴다', () => {
  assert.doesNotMatch(PS.firewallReg, /\b(Set|New|Remove|Enable|Disable|Add|Start|Stop|Restart|Invoke|Update)-[A-Za-z]+/);
  assert.match(PS.firewallReg, /Get-ItemProperty/);
  for (const script of Object.values(PS)) assert.ok(!script.includes('"'), '큰따옴표 없음');
  assert.equal(typeof powerShellPath('linux'), 'string');
});

test('기록 저장 위치: 저장 안 함/쓸 수 없는 폴더/정상', () => {
  const none = openStore(tmp(), 'h.jsonl', { save: false });
  assert.equal(none.where, 'memory');
  none.store.append({ at: 'x' });
  assert.equal(none.store.read(5).length, 1);

  const dir = tmp();
  const ok = openStore(dir, 'h.jsonl');
  assert.equal(ok.where, 'folder');
  assert.ok(fs.existsSync(path.join(dir, 'h.jsonl')));

  // 폴더 자리에 "파일"이 있어서 폴더를 만들 수 없는 경우 → 임시 폴더로 대신 저장
  const blocker = path.join(tmp(), 'blocker');
  fs.writeFileSync(blocker, 'x');
  const fb = openStore(path.join(blocker, 'data'), 'h.jsonl');
  assert.notEqual(fb.where, 'folder');
  fb.store.append({ at: 'y' });
  assert.equal(fb.store.read(5).length >= 1, true);

  const mem = createMemoryStore();
  for (let k = 0; k < 600; k++) mem.append({ k });
  assert.equal(mem.count(), 500);
});

test('서버: --no-save 모드는 파일을 만들지 않고 meta에 memory로 알린다', async () => {
  const dir = path.join(tmp(), 'data');
  const app = createDashboard({ demo: true, save: false, dataDir: dir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    assert.equal(JSON.parse((await call(app.server, 'GET', '/api/meta')).body).storage, 'memory');
    assert.equal((await call(app.server, 'POST', '/api/check')).status, 200);
    assert.ok(!fs.existsSync(dir));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('check-once: 한 번 조회해서 8개 항목을 글자로 보여 준다 (기록 파일을 만들지 않음)', async () => {
  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((resolve, reject) =>
    execFile(process.execPath, ['student/check-once.mjs', ...args], { timeout: 30000 }, (e, out) => (e ? reject(e) : resolve(out))));
  const text = await run([]);
  assert.match(text, /점검 8개 중 \d개 정상/);
  assert.equal((text.match(/^- \[/gm) || []).length, 8);
  const json = JSON.parse(await run(['--json']));
  assert.equal(json.items.length, 8);
});
