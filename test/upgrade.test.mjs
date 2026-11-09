// v0.2.0 에서 추가한 기능 시험: 기준 설정, 메모리 읽기, 기록 저장 성능, 알림 지속 시간, 보안 헤더
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { judgeAll, judgeCpu, judgeMemory, THRESHOLDS } from '../student/judge.mjs';
import { FIELDS, sanitizeThresholds, createSettingsStore } from '../student/settings.mjs';
import { parseMeminfo, readMemory } from '../student/collect.mjs';
import { createStore } from '../student/store.mjs';
import { computeAlerts } from '../student/alerts.mjs';
import { demoReadings } from '../student/demo.mjs';
import { createDashboard, VERSION } from '../student/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-test-'));

function call(server, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const JSON_H = { 'Content-Type': 'application/json' };
async function withApp(opts, fn) {
  const app = createDashboard(opts);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await fn(app);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
}

test('기준 검사: 범위·정수·빠진 값 채우기·알 수 없는 값 무시', () => {
  assert.equal(FIELDS.length, Object.keys(THRESHOLDS).length, '화면 입력칸이 기준값을 빠짐없이 덮는다');
  for (const f of FIELDS) assert.ok(f.key in THRESHOLDS, f.key);

  const r = sanitizeThresholds({ cpuWarn: 90 });
  assert.equal(r.ok, true);
  assert.equal(r.value.cpuWarn, 90);
  assert.equal(r.value.memWarn, THRESHOLDS.memWarn, '빠진 값은 처음 값');
  assert.equal(sanitizeThresholds({ hack: 1 }).ok, true);
  assert.equal('hack' in sanitizeThresholds({ hack: 1 }).value, false);

  for (const bad of [{ cpuWarn: 0 }, { cpuWarn: 101 }, { cpuWarn: 70.5 }, { cpuWarn: '70' }, { cpuWarn: null }, { cpuWarn: NaN }, { diskFreeWarn: 100 }, { eventsWarn: -1 }]) {
    const x = sanitizeThresholds(bad);
    assert.equal(x.ok, false, JSON.stringify(bad));
    assert.ok(x.error && x.field);
  }
  for (const bad of [null, undefined, 5, 'x', []]) assert.equal(sanitizeThresholds(bad).ok, false);
});

test('기준 적용: 판정이 바꾼 기준을 따른다 (judgeAll 두 번째 인자)', () => {
  assert.equal(judgeCpu({ pct: 50 }).status, 'ok');
  assert.equal(judgeCpu({ pct: 50 }, { ...THRESHOLDS, cpuWarn: 40 }).status, 'warn');
  const strict = { ...THRESHOLDS, cpuWarn: 1, memWarn: 1, diskFreeWarn: 99, updateDaysWarn: 1, portsWarn: 1, startupWarn: 1, eventsWarn: 1 };
  const loose = { ...THRESHOLDS, cpuWarn: 100, memWarn: 100, diskFreeWarn: 1, updateDaysWarn: 3650, portsWarn: 10000, startupWarn: 1000, eventsWarn: 100000 };
  const readings = demoReadings(0);
  const w = (t) => judgeAll(readings, t).summary.warn;
  assert.ok(w(strict) > w(THRESHOLDS), '엄격하면 주의가 늘어난다');
  assert.ok(w(loose) <= w(THRESHOLDS), '느슨하면 주의가 줄어든다');
  assert.equal(judgeAll(readings).summary.warn, judgeAll(readings, THRESHOLDS).summary.warn, '인자를 안 주면 처음 값');
});

test('설정 저장소: 저장·다시 읽기·되돌리기·깨진 파일·메모리 모드', () => {
  const file = path.join(tmp(), 'settings.json');
  const a = createSettingsStore(file);
  assert.deepEqual(a.get(), THRESHOLDS);
  assert.equal(a.set({ ...THRESHOLDS, cpuWarn: 55 }), true);
  assert.equal(createSettingsStore(file).get().cpuWarn, 55, '다시 켜도 남아 있다');
  a.reset();
  assert.equal(fs.existsSync(file), false);
  assert.equal(a.get().cpuWarn, THRESHOLDS.cpuWarn);

  fs.writeFileSync(file, '{깨진 파일');
  assert.deepEqual(createSettingsStore(file).get(), THRESHOLDS);
  fs.writeFileSync(file, JSON.stringify({ cpuWarn: 9999 }));
  assert.deepEqual(createSettingsStore(file).get(), THRESHOLDS, '범위를 벗어난 저장값은 버린다');

  const mem = createSettingsStore(null);
  assert.equal(mem.set({ ...THRESHOLDS, cpuWarn: 33 }), false);
  assert.equal(mem.get().cpuWarn, 33);
  const bad = createSettingsStore(path.join(tmp(), 'no', 'such', 'dir', 's.json'));
  assert.equal(bad.set({ ...THRESHOLDS }), false, '쓸 수 없으면 false, 죽지 않는다');
});

test('서버: /api/settings 읽기·저장·검증·되돌리기와 조회에 즉시 반영', async () => {
  const dir = tmp();
  let reading = { cpu: { pct: 50 } };
  const collect = async () => ({ ...demoReadings(0), ...reading });
  await withApp({ demo: false, dataDir: dir, collect }, async ({ server }) => {
    const get = JSON.parse((await call(server, 'GET', '/api/settings')).body);
    assert.deepEqual(get.thresholds, THRESHOLDS);
    assert.deepEqual(get.defaults, THRESHOLDS);
    assert.equal(get.fields.length, FIELDS.length);
    assert.equal(get.persisted, true);

    const cpuStatus = async () => JSON.parse((await call(server, 'POST', '/api/check')).body).entry.items.find((i) => i.id === 'cpu').status;
    assert.equal(await cpuStatus(), 'ok');
    const put = await call(server, 'POST', '/api/settings', { headers: JSON_H, body: { cpuWarn: 40 } });
    assert.equal(put.status, 200);
    assert.equal(JSON.parse(put.body).thresholds.cpuWarn, 40);
    assert.equal(await cpuStatus(), 'warn', '바꾼 기준이 다음 조회부터 적용');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).cpuWarn, 40);

    // 잘못된 값은 422이고 저장된 값은 그대로
    const bad = await call(server, 'POST', '/api/settings', { headers: JSON_H, body: { cpuWarn: 500 } });
    assert.equal(bad.status, 422);
    assert.equal(JSON.parse(bad.body).field, 'cpuWarn');
    assert.equal(JSON.parse((await call(server, 'GET', '/api/settings')).body).thresholds.cpuWarn, 40);

    const reset = await call(server, 'POST', '/api/settings', { headers: JSON_H, body: { reset: true } });
    assert.equal(JSON.parse(reset.body).thresholds.cpuWarn, THRESHOLDS.cpuWarn);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  });
});

test('서버: /api/settings 거절 (GET 외 메서드·다른 출처·다른 주소·형식·크기)', async () => {
  await withApp({ demo: false, dataDir: tmp(), collect: async () => demoReadings(0) }, async ({ server }) => {
    const ok = { headers: JSON_H, body: { cpuWarn: 60 } };
    assert.equal((await call(server, 'PUT', '/api/settings', ok)).status, 405);
    assert.equal((await call(server, 'POST', '/api/settings', { ...ok, headers: { ...JSON_H, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call(server, 'POST', '/api/settings', { ...ok, headers: { ...JSON_H, Host: 'evil.example' } })).status, 403);
    assert.equal((await call(server, 'POST', '/api/settings', { headers: { 'Content-Type': 'text/plain' }, body: '{"cpuWarn":60}' })).status, 415);
    assert.equal((await call(server, 'POST', '/api/settings', { headers: JSON_H, body: '{깨짐' })).status, 400);
    assert.equal((await call(server, 'POST', '/api/settings', { headers: JSON_H, body: JSON.stringify({ pad: 'x'.repeat(8000) }) }).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await call(server, 'POST', '/api/settings', { headers: JSON_H, body: '[1,2]' })).status, 422);
    assert.equal(JSON.parse((await call(server, 'GET', '/api/settings')).body).thresholds.cpuWarn, THRESHOLDS.cpuWarn, '거절된 요청은 아무것도 바꾸지 않음');
  });
});

test('서버: 예제 모드·저장 안 함은 설정 파일을 만들지 않고, 예제는 기준 변경이 메모리에만 남는다', async () => {
  for (const opts of [{ demo: true }, { demo: false, save: false }]) {
    const dir = tmp();
    await withApp({ ...opts, dataDir: dir, collect: async () => demoReadings(0) }, async ({ server }) => {
      assert.equal(JSON.parse((await call(server, 'GET', '/api/settings')).body).persisted, false);
      const r = await call(server, 'POST', '/api/settings', { headers: JSON_H, body: { memWarn: 50 } });
      assert.equal(JSON.parse(r.body).thresholds.memWarn, 50);
    });
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, JSON.stringify(opts));
  }
});

test('서버: /api/health, meta 버전, 보안 헤더', async () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(fs.readFileSync('package.json', 'utf8')).version, VERSION);
  await withApp({ demo: true, dataDir: tmp() }, async ({ server }) => {
    const h = await call(server, 'GET', '/api/health');
    assert.deepEqual(JSON.parse(h.body), { ok: true, app: 'pc-control-dashboard', version: VERSION, mode: 'demo', saving: true });
    assert.equal(JSON.parse((await call(server, 'GET', '/api/meta')).body).version, VERSION);
    const page = await call(server, 'GET', '/');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(page.headers['cache-control'], 'no-store');
  });
});

test('메모리: /proc/meminfo에서 쓸 수 있는 메모리(MemAvailable)로 사용률을 계산한다', () => {
  const sample = 'MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    8000000 kB\nBuffers: 1 kB\n';
  const m = parseMeminfo(sample);
  assert.equal(m.total, 16000000 * 1024);
  assert.equal(m.free, 8000000 * 1024);
  assert.equal(Math.round(readMemory({ platform: 'linux', meminfo: sample }).pct), 50);
  for (const bad of ['', 'MemTotal: 0 kB\nMemAvailable: 0 kB', 'MemTotal: 10 kB\nMemAvailable: 20 kB', 'garbage']) assert.equal(parseMeminfo(bad), null);
  const fallback = readMemory({ platform: 'linux', meminfo: 'garbage' });
  assert.ok(fallback.pct >= 0 && fallback.pct <= 100, 'meminfo가 이상하면 Node 기본값으로');
  const win = readMemory({ platform: 'win32' });
  assert.ok(win.pct >= 0 && win.pct <= 100 && win.totalGB > 0);
  assert.equal(win.via, 'os');
  assert.equal(readMemory({ platform: 'linux', meminfo: sample }).via, 'meminfo');
  // Windows 화면의 출처에는 Linux 문구가 나오지 않는다 (실제 Windows PC 화면에서 발견)
  assert.doesNotMatch(judgeMemory(win).source, /Linux|meminfo/);
  assert.match(judgeMemory({ pct: 50, via: 'meminfo' }).source, /\/proc\/meminfo/);
});

test('기록 저장소: 한도를 넘으면 최근 500건만 남기고, 줄 수를 기억해도 지운 뒤 다시 센다', () => {
  const file = path.join(tmp(), 'h.jsonl');
  const st = createStore(file);
  for (let k = 0; k < 650; k++) st.append({ k });
  assert.ok(st.count() <= 600, '600건을 넘으면 줄인다');
  assert.equal(st.read(500).at(-1).k, 649, '가장 최근 기록은 남는다');
  for (let k = 650; k < 720; k++) st.append({ k });
  assert.ok(st.count() <= 600);
  assert.equal(st.read(1)[0].k, 719);
  st.clear();
  st.append({ k: 'new' });
  assert.equal(st.count(), 1);
  // 다른 객체로 같은 파일을 열어도 이어서 쓴다
  const again = createStore(file);
  again.append({ k: 'two' });
  assert.equal(again.count(), 2);
});

test('위험 알림: 해소 기록에 주의가 이어진 시간이 들어간다', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const mk = (min, status) => ({ at: new Date(t0 + min * 60000).toISOString(), items: [{ id: 'cpu', label: 'CPU', status, text: status }] });
  const a = computeAlerts([mk(0, 'ok'), mk(1, 'warn'), mk(2, 'unknown'), mk(13, 'ok')]);
  const resolved = a.events.find((e) => e.kind === 'resolved');
  assert.equal(resolved.durationMs, 12 * 60000, '확인 불가 구간도 주의가 이어진 시간에 포함');
  assert.equal(a.events.find((e) => e.kind === 'start').durationMs, undefined);
});

test('화면: 설정·자동 조회 간격·그래프 통계·접근성 요소가 있다', () => {
  const html = fs.readFileSync(path.join('student', 'public', 'index.html'), 'utf8');
  for (const id of ['settingsForm', 'settingsGrid', 'settingsReset', 'autoSec', 'chartStats', 'versionNote']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<main class="wrap">/);
  assert.match(html, /<noscript>/);
  assert.match(html, /rel="icon"/);
  assert.match(html, /class="skip"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /prefers-color-scheme/);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, '외부 주소를 부르지 않는다');
});
