// v0.3.0: 기준선 비교(달라진 것 감지), 포트·시작프로그램 목록 읽기, 바로가기 설치, 이미 켜져 있는지 찾기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parsePorts, parseStartup, collectAll, PS } from '../student/collect.mjs';
import { snapshot, fingerprint, compareBaseline, createBaseline, acceptBaseline, judgeBaseline, createBaselineStore, hasAny } from '../student/baseline.mjs';
import { demoReadings } from '../student/demo.mjs';
import { createDashboard, findRunning } from '../student/server.mjs';
import { runInstall, PS_INSTALL, shortcutEnv, SHORTCUT_NAME } from '../student/install.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
const JSON_H = { 'Content-Type': 'application/json' };

function call(server, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out, json: () => JSON.parse(out) }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
async function withApp(opts, fn) {
  const app = createDashboard(opts);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await fn(app);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
}

// Windows처럼 보이는 읽은 값
const reading = ({ ports = [135, 445], procs = {}, startup = ['A동기화', 'B메신저'], fw = [true, true, true], defender = true } = {}) => ({
  ...demoReadings(0),
  ports: { count: ports.length, ports: ports.map((port) => ({ port, proc: procs[port] || '' })) },
  startup: { count: startup.length, names: startup },
  firewall: { profiles: ['Domain', 'Private', 'Public'].map((name, i) => ({ name, enabled: fw[i] })) },
  defender: { realtime: defender },
});

test('수집 해석: 포트 목록(새 모양·옛 숫자·한 개·중복·이상한 값)', () => {
  assert.deepEqual(parsePorts('17'), { count: 17 });
  const r = parsePorts('{"Count":5,"Ports":[{"Port":445,"Proc":"System"},{"Port":135,"Proc":"svchost"},{"Port":445,"Proc":"x"},{"Port":0},{"Port":"80"}]}');
  assert.equal(r.count, 5);
  assert.deepEqual(r.ports, [{ port: 135, proc: 'svchost' }, { port: 445, proc: 'System' }]);
  assert.deepEqual(parsePorts('{"Count":1,"Ports":{"Port":80,"Proc":null}}').ports, [{ port: 80, proc: '' }]);
  assert.deepEqual(parsePorts('{"Count":0,"Ports":[]}'), { count: 0, ports: [] });
  for (const bad of ['', 'abc', '{"Count":-1}', '{"Ports":[]}', 'null']) assert.throws(() => parsePorts(bad), bad);
});

test('수집 해석: 시작프로그램 목록(새 모양·옛 숫자·한 개·빈 이름·중복)', () => {
  assert.deepEqual(parseStartup('9'), { count: 9 });
  assert.deepEqual(parseStartup('{"Count":3,"Names":["A"," A ","",null,"B"]}'), { count: 3, names: ['A', 'B'] });
  assert.deepEqual(parseStartup('{"Count":1,"Names":"OneOnly"}').names, ['OneOnly']);
  for (const bad of ['', 'x', '{"Count":"3"}']) assert.throws(() => parseStartup(bad), bad);
});

test('수집: 새 포트·시작프로그램 명령도 읽기만 하고, 결과를 목록으로 넘긴다', async () => {
  for (const s of [PS.ports, PS.startup]) assert.doesNotMatch(s, /\b(Set|New|Remove|Enable|Disable|Add|Start|Stop|Restart|Invoke|Update)-[A-Za-z]+/);
  const run = async (script) => {
    if (script === PS.ports) return '{"Count":3,"Ports":[{"Port":445,"Proc":"System"}]}';
    if (script === PS.startup) return '{"Count":2,"Names":["A","B"]}';
    throw new Error('막힘');
  };
  const r = await collectAll({ platform: 'win32', run });
  assert.deepEqual(r.ports, { count: 3, ports: [{ port: 445, proc: 'System' }] });
  assert.deepEqual(r.startup, { count: 2, names: ['A', 'B'] });
});

test('기준선: 시작프로그램 이름은 저장하지 않고 PC마다 다른 지문만 남긴다', () => {
  const b = createBaseline(reading({ startup: ['비밀프로그램'] }));
  const text = JSON.stringify(b);
  assert.doesNotMatch(text, /비밀프로그램/);
  assert.equal(b.startup.length, 1);
  assert.match(b.startup[0], /^[0-9a-f]{16}$/);
  assert.equal(fingerprint('s1', 'App'), fingerprint('s1', ' app '), '대소문자·앞뒤 공백은 같은 것으로');
  assert.notEqual(fingerprint('s1', 'App'), fingerprint('s2', 'App'), 'salt가 다르면 지문도 다르다');
  assert.deepEqual(b.ports, [135, 445]);
  assert.deepEqual(b.firewall, { Domain: true, Private: true, Public: true });
  assert.equal(b.defender, true);
});

test('기준선 비교: 새 포트·새 시작프로그램·방화벽/보안 꺼짐은 주의, 닫힘·켜짐은 정보', () => {
  const base = createBaseline(reading());
  const same = compareBaseline(base, reading());
  assert.deepEqual(same.changes, []);
  assert.equal(judgeBaseline(same).status, 'ok');
  assert.equal(judgeBaseline(same).text, '기준선과 같음');

  const now = reading({ ports: [135, 4444], procs: { 4444: 'nc' }, startup: ['A동기화', 'B메신저', '수상한도우미'], fw: [true, false, true], defender: false });
  const cmp = compareBaseline(base, now);
  const kinds = cmp.changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['defender-off', 'firewall-off', 'port-gone', 'port-new', 'startup-new']);
  assert.equal(cmp.changes.find((c) => c.kind === 'port-new').detail, '연 프로그램: nc');
  assert.equal(cmp.changes.find((c) => c.kind === 'startup-new').detail, '수상한도우미');
  assert.equal(cmp.changes.find((c) => c.kind === 'port-gone').severity, 'info');
  const item = judgeBaseline(cmp);
  assert.equal(item.status, 'warn');
  assert.equal(item.value, 4);
  assert.match(item.text, /새 포트 1개 · 새 시작프로그램 1개 · 방화벽 꺼짐 1개 · Windows 보안 꺼짐/);
  assert.doesNotMatch(JSON.stringify(item), /수상한도우미|nc/, '기록에 남는 판정 글자에는 이름을 넣지 않는다');

  const back = compareBaseline({ ...base, defender: false, firewall: { Domain: true, Private: false, Public: true } }, reading({ startup: ['A동기화'] }));
  assert.deepEqual(back.changes.map((c) => c.kind).sort(), ['defender-on', 'firewall-on', 'startup-gone']);
  assert.ok(back.changes.every((c) => c.severity === 'info'));
  assert.equal(judgeBaseline(back).status, 'ok');
  assert.match(judgeBaseline(back).text, /거의 같음/);
});

test('기준선 비교: 읽지 못한 항목은 건너뛰고, 기준선에 없던 항목은 처음 읽힐 때 채운다', () => {
  const base = createBaseline({ ...reading(), ports: { error: '권한 없음' } });
  assert.equal(base.ports, null);
  const cmp = compareBaseline(base, { ...reading({ ports: [80] }), startup: { error: '막힘' } });
  assert.deepEqual(cmp.skipped, ['시작프로그램']);
  assert.deepEqual(cmp.filled, ['열린 포트']);
  assert.deepEqual(cmp.next.ports, [80]);
  assert.equal(cmp.changes.filter((c) => c.kind === 'port-new').length, 0, '처음 채울 때는 알리지 않는다');
  assert.match(judgeBaseline(cmp).hint, /시작프로그램은 읽지 못해/);

  assert.equal(hasAny(createBaseline({})), false);
  const none = judgeBaseline(null);
  assert.equal(none.status, 'unknown');
  assert.match(none.text, /^확인 불가/);
  assert.equal(judgeBaseline(cmp, { created: true }).status, 'ok');
});

test('기준선 받아들이기: 지금 값으로 바꾸되 읽지 못한 항목은 예전 값을 지키고 salt는 유지한다', () => {
  const base = createBaseline(reading());
  const next = acceptBaseline(base, { ...reading({ ports: [135, 445, 3389] }), startup: { error: '막힘' } });
  assert.equal(next.salt, base.salt);
  assert.deepEqual(next.ports, [135, 445, 3389]);
  assert.deepEqual(next.startup, base.startup);
  assert.deepEqual(compareBaseline(next, reading({ ports: [135, 445, 3389] })).changes, []);
});

test('기준선 저장소: 파일 저장·다시 읽기·깨진 파일·지우기·메모리', () => {
  const file = path.join(tmp(), 'baseline.json');
  const st = createBaselineStore(file);
  assert.equal(st.get(), null);
  const b = createBaseline(reading());
  assert.equal(st.set(b), true);
  assert.deepEqual(createBaselineStore(file).get(), b);
  fs.writeFileSync(file, '{깨짐');
  assert.equal(createBaselineStore(file).get(), null);
  st.clear();
  assert.equal(fs.existsSync(file), false);
  const mem = createBaselineStore(null);
  assert.equal(mem.set(b), false);
  assert.deepEqual(mem.get(), b);
});

test('서버: 첫 조회에 기준선 저장 → 새 포트·시작프로그램을 주의로 알림 → 받아들이면 정상, 이름은 파일에 안 남음', async () => {
  const dir = tmp();
  let now = reading();
  await withApp({ demo: false, dataDir: dir, collect: async () => now }, async ({ server }) => {
    assert.equal((await call(server, 'GET', '/api/baseline')).json().exists, false);
    assert.equal((await call(server, 'POST', '/api/baseline', { headers: JSON_H, body: { action: 'accept' } })).status, 409, '조회 전에는 받아들일 값이 없다');

    const first = (await call(server, 'POST', '/api/check')).json();
    const item = (e) => e.items.find((i) => i.id === 'baseline');
    assert.equal(first.entry.items.length, 11);
    assert.equal(item(first.entry).status, 'ok');
    assert.match(item(first.entry).text, /기준선으로 저장/);
    assert.equal(first.baseline.exists, true);
    assert.ok(fs.existsSync(path.join(dir, 'baseline.json')));

    now = reading({ ports: [135, 445, 4444], procs: { 4444: '비밀포트프로그램' }, startup: ['A동기화', 'B메신저', '비밀시작프로그램'] });
    const second = (await call(server, 'POST', '/api/check')).json();
    assert.equal(item(second.entry).status, 'warn');
    assert.deepEqual(second.baseline.changes.map((c) => c.kind).sort(), ['port-new', 'startup-new']);
    assert.ok(second.baseline.changes.some((c) => c.detail === '비밀시작프로그램'), '화면에는 이름을 보여 준다');

    const alerts = (await call(server, 'GET', '/api/alerts')).json();
    assert.ok(alerts.current.some((a) => a.id === 'baseline'), '위험 알림에도 나온다');

    for (const f of fs.readdirSync(dir)) {
      assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /비밀시작프로그램|비밀포트프로그램|A동기화/, `${f}에 이름이 남으면 안 된다`);
    }

    const acc = await call(server, 'POST', '/api/baseline', { headers: JSON_H, body: { action: 'accept' } });
    assert.equal(acc.status, 200);
    assert.deepEqual(acc.json().changes, []);
    assert.deepEqual(acc.json().ports, [135, 445, 4444]);
    assert.equal(item((await call(server, 'POST', '/api/check')).json().entry).status, 'ok');

    assert.equal((await call(server, 'POST', '/api/baseline', { headers: JSON_H, body: { action: 'nope' } })).status, 422);
    assert.equal((await call(server, 'POST', '/api/baseline', { headers: { ...JSON_H, Origin: 'http://evil.example' }, body: { action: 'reset' } })).status, 403);
    assert.equal((await call(server, 'POST', '/api/baseline', { headers: { 'Content-Type': 'text/plain' }, body: '{"action":"reset"}' })).status, 415);
    assert.equal((await call(server, 'PUT', '/api/baseline')).status, 405);
    assert.equal((await call(server, 'GET', '/api/baseline')).json().exists, true, '거절된 요청은 아무것도 바꾸지 않음');

    const reset = await call(server, 'POST', '/api/baseline', { headers: JSON_H, body: { action: 'reset' } });
    assert.equal(reset.json().exists, false);
    assert.equal(fs.existsSync(path.join(dir, 'baseline.json')), false);
  });
  // 다시 켜도 기준선이 이어진다
  now = reading();
  await withApp({ demo: false, dataDir: dir, collect: async () => now }, async ({ server }) => {
    (await call(server, 'POST', '/api/check')).json();
  });
  await withApp({ demo: false, dataDir: dir, collect: async () => reading({ ports: [135, 445, 8080] }) }, async ({ server }) => {
    const b = (await call(server, 'GET', '/api/baseline')).json();
    assert.equal(b.exists, true);
    assert.equal(b.checkedAt, null, '다시 켠 직후에는 비교 결과(이름)를 들고 있지 않다');
    const e = (await call(server, 'POST', '/api/check')).json();
    assert.ok(e.baseline.changes.some((c) => c.text === '새로 열린 포트 8080'));
  });
});

test('서버: Windows가 아니면(비교할 값이 없으면) 기준선을 만들지 않고 확인 불가', async () => {
  const dir = tmp();
  await withApp({ demo: false, dataDir: dir, collect: () => collectAll({ platform: 'linux' }) }, async ({ server }) => {
    const e = (await call(server, 'POST', '/api/check')).json();
    assert.equal(e.entry.items.find((i) => i.id === 'baseline').status, 'unknown');
    assert.equal(e.baseline.exists, false);
    assert.equal(fs.existsSync(path.join(dir, 'baseline.json')), false);
    assert.equal((await call(server, 'POST', '/api/baseline', { headers: JSON_H, body: { action: 'accept' } })).status, 409);
  });
});

test('서버(예제 모드): 처음부터 "달라진 것"이 보이고, 기준선 파일은 만들지 않는다', async () => {
  const dir = tmp();
  await withApp({ demo: true, dataDir: dir }, async ({ server }) => {
    const hist = (await call(server, 'GET', '/api/history')).json().entries;
    assert.equal(hist.length, 12);
    assert.equal(hist.at(-1).items.find((i) => i.id === 'baseline').status, 'warn');
    const b = (await call(server, 'GET', '/api/baseline')).json();
    assert.equal(b.exists, true);
    assert.equal(b.persisted, false);
    assert.ok(b.changes.some((c) => c.kind === 'port-new' && c.text === '새로 열린 포트 4444'));
    const a = (await call(server, 'GET', '/api/alerts')).json();
    assert.ok(a.current.some((x) => x.id === 'baseline'));
  });
  assert.equal(fs.existsSync(path.join(dir, 'baseline.json')), false);
});

test('바로가기 설치: Windows에서만, 경로는 환경 변수로 넘기고, 실행 정책·레지스트리는 건드리지 않는다', async () => {
  await assert.rejects(() => runInstall('create', { platform: 'linux', run: async () => '' }), /Windows에서만/);
  for (const s of Object.values(PS_INSTALL)) {
    assert.doesNotMatch(s, /ExecutionPolicy|HKLM|HKCU|Registry|Set-ItemProperty|New-ItemProperty|Start-Process|Invoke-/i);
    assert.match(s, /\$env:PCD_NAME/);
    assert.match(s, /GetFolderPath\('Desktop'\)/);
  }
  assert.match(PS_INSTALL.create, /\$env:PCD_TARGET/);
  assert.match(PS_INSTALL.remove, /Remove-Item -LiteralPath \$lnk/);

  const env = shortcutEnv();
  assert.equal(env.PCD_NAME, SHORTCUT_NAME);
  assert.ok(fs.existsSync(env.PCD_TARGET), 'start.bat을 가리킨다');
  assert.match(env.PCD_TARGET, /student[\\/]start\.bat$/);

  const calls = [];
  const run = async (script, opts) => {
    calls.push({ script, opts });
    return 'C:\\Users\\me\\Desktop\\a.lnk\r\nC:\\Users\\me\\Start Menu\\a.lnk\r\n';
  };
  const made = await runInstall('create', { platform: 'win32', run });
  assert.equal(made.length, 2);
  assert.equal(calls[0].script, PS_INSTALL.create);
  assert.deepEqual(calls[0].opts.env, env);
  await assert.rejects(() => runInstall('create', { platform: 'win32', run, env: { ...env, PCD_TARGET: path.join(tmp(), 'none.bat') } }), /start\.bat 을 찾지 못했어요/);
  assert.deepEqual(await runInstall('status', { platform: 'win32', run: async () => '' }), []);
});

test('이미 켜져 있는 대시보드 찾기: 같은 모드·저장 방식일 때만 찾는다', async () => {
  await withApp({ demo: true, dataDir: tmp() }, async ({ server }) => {
    const { port } = server.address();
    assert.equal(await findRunning({ from: port, count: 1, mode: 'demo', saving: true }), `http://127.0.0.1:${port}`);
    assert.equal(await findRunning({ from: port, count: 1, mode: 'real', saving: true }), null, '모드가 다르면 새로 켠다');
    assert.equal(await findRunning({ from: port, count: 1, mode: 'demo', saving: false }), null, '저장 방식이 다르면 새로 켠다');
  });
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const { port } = closed.address();
  await new Promise((r) => closed.close(r));
  assert.equal(await findRunning({ from: port, count: 1, timeout: 300 }), null);
});
