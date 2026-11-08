// 내 PC 관제 대시보드 서버. 내 PC 안(127.0.0.1)에서만 열리고, 외부 서버에는 연결하지 않습니다.
//   실행:  node student/server.mjs            (실제 PC 상태)
//          node student/server.mjs --demo     (예제 값, 화면에 "예제" 표시)
//          node student/server.mjs --port=4200   (번호를 정하지 않으면 4173부터 빈 번호를 찾아요)
//          node student/server.mjs --no-save     (기록을 파일에 남기지 않음, 공용 PC용)
//          node student/server.mjs --open        (브라우저 자동 열기)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from './collect.mjs';
import { judgeAll, summarize } from './judge.mjs';
import { execFile } from 'node:child_process';
import { openStore, toEntry } from './store.mjs';
import { computeAlerts } from './alerts.mjs';
import { demoReadings } from './demo.mjs';
import { FIELDS, sanitizeThresholds, createSettingsStore } from './settings.mjs';
import { THRESHOLDS } from './judge.mjs';
import { createBaseline, compareBaseline, acceptBaseline, judgeBaseline, createBaselineStore, hasAny } from './baseline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
const MAX_BODY = 4096;

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createDashboard({ demo = false, save = true, dataDir = path.join(HERE, 'data'), collect = collectAll } = {}) {
  const mode = demo ? 'demo' : 'real';
  const { store, where: storage } = openStore(dataDir, demo ? 'history.demo.jsonl' : 'history.jsonl', { save });
  // 설정은 기록과 같은 폴더에 저장해요. 예제 모드·저장 안 함·메모리 저장일 때는 파일을 만들지 않아요.
  const settings = createSettingsStore(!demo && store.file ? path.join(path.dirname(store.file), 'settings.json') : null);
  // 기준선(처음 상태)도 같은 폴더에 저장해요. 예제 모드·저장 안 함일 때는 메모리에만 둬요.
  const baselines = createBaselineStore(!demo && store.file ? path.join(path.dirname(store.file), 'baseline.json') : null);
  // 마지막으로 읽은 값과 비교 결과. 프로그램 이름이 들어 있어서 메모리에만 두고 파일에 쓰지 않아요.
  let live = null;
  let demoStep = store.count();
  let busy = null;

  // 읽은 값 → 판정 10개 + 기준선 비교 1개 → 기록 한 줄
  function evaluate(readings, at = new Date()) {
    const result = judgeAll(readings, settings.get());
    let base = baselines.get();
    let created = false;
    if (!base) {
      const fresh = createBaseline(readings, { at });
      if (hasAny(fresh)) {
        baselines.set(fresh);
        base = fresh;
        created = true;
      }
    }
    let cmp = null;
    if (base) {
      cmp = compareBaseline(base, readings);
      if (cmp.filled.length) baselines.set(cmp.next);
    }
    result.items.push(judgeBaseline(cmp, { created }));
    result.summary = summarize(result.items);
    live = { at: at.toISOString(), cmp, readings };
    return toEntry(result, mode, at);
  }

  // 예제 모드에서 그래프가 비어 보이지 않도록, 처음 한 번만 지난 기록 12개를 예제 값으로 채웁니다.
  // 기준선은 "깨끗한" 예제 상태로 먼저 저장하고, 마지막 기록에 달라진 것이 보이게 순서를 맞춰요.
  if (demo && store.count() === 0) {
    const now = Date.now();
    baselines.set(createBaseline(demoReadings(0), { at: new Date(now - 13 * 60000) }));
    for (let k = 0; k < 12; k++) {
      store.append(evaluate(demoReadings(k + 4), new Date(now - (12 - k) * 60000)));
    }
    demoStep = 16;
  }

  async function check() {
    const readings = demo ? demoReadings(demoStep++) : await collect();
    const entry = evaluate(readings);
    store.append(entry);
    return entry;
  }

  const baselineView = () => {
    const b = baselines.get();
    return {
      mode,
      exists: Boolean(b),
      createdAt: b ? b.createdAt : null,
      persisted: Boolean(baselines.file),
      checkedAt: live ? live.at : null,
      ports: b && Array.isArray(b.ports) ? b.ports : null,
      startupCount: b && Array.isArray(b.startup) ? b.startup.length : null,
      changes: live && live.cmp ? live.cmp.changes : [],
      skipped: live && live.cmp ? live.cmp.skipped : [],
    };
  };

  const meta = () => ({
    mode,
    demo,
    version: VERSION,
    connection: '서버 연결 안 함',
    platform: process.platform,
    readOnly: true,
    sdp: { state: 'SDP 미연결', note: '서버 연결 안 함 (설정하지 않은 기본 상태)' },
    storage, // folder: 프로젝트 폴더, temp: 임시 폴더, memory: 창을 닫으면 사라짐
  });

  // 읽기 전용이 아닌 요청(기록 지우기·조회·설정 저장)은 POST만, 같은 출처에서만 받아요.
  function guardPost(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }), false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' }), false;
    return true;
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return reject(Object.assign(new Error('BAD_CONTENT_TYPE'), { code: 415 }));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(Object.assign(new Error('TOO_LARGE'), { code: 413 }));
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          reject(Object.assign(new Error('BAD_JSON'), { code: 400 }));
        }
      });
      req.on('error', reject);
    });
  }
  const settingsView = () => ({ mode, thresholds: settings.get(), defaults: { ...THRESHOLDS }, fields: FIELDS, persisted: Boolean(settings.file) });

  const handler = async (req, res) => {
    try {
      const port = req.socket.localPort;
      const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || '').toLowerCase());
      if (!hostOk) return send(res, 403, { error: 'HOST_NOT_ALLOWED' });
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(HERE, 'public', 'index.html')), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') return send(res, 200, meta());
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, app: 'pc-control-dashboard', version: VERSION, mode, saving: storage !== 'memory' });
      if (url.pathname === '/api/baseline') {
        if (req.method === 'GET') return send(res, 200, baselineView());
        if (!guardPost(req, res)) return;
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, e.code || 400, { error: e.message });
        }
        const action = body && body.action;
        if (action === 'accept') {
          if (!live) return send(res, 409, { error: 'NO_READING', message: '먼저 "다시 조회"를 눌러 지금 상태를 읽어 주세요' });
          const next = acceptBaseline(baselines.get(), live.readings);
          if (!hasAny(next)) return send(res, 409, { error: 'NOTHING_TO_SAVE', message: '비교할 항목을 읽지 못해 기준선을 저장할 수 없어요' });
          baselines.set(next);
          live = { ...live, cmp: compareBaseline(next, live.readings) };
          return send(res, 200, baselineView());
        }
        if (action === 'reset') {
          baselines.clear();
          live = null;
          return send(res, 200, baselineView());
        }
        return send(res, 422, { error: 'INVALID_ACTION', message: 'action은 accept 또는 reset이어야 해요' });
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return send(res, 200, settingsView());
        if (!guardPost(req, res)) return;
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, e.code || 400, { error: e.message });
        }
        if (body && body.reset === true) settings.reset();
        else {
          const r = sanitizeThresholds(body, settings.get());
          if (!r.ok) return send(res, 422, { error: 'INVALID_SETTINGS', message: r.error, field: r.field || null });
          settings.set(r.value);
        }
        return send(res, 200, settingsView());
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        return send(res, 200, { mode, entries: store.read(url.searchParams.get('limit') || 100) });
      }
      if (req.method === 'GET' && url.pathname === '/api/alerts') {
        return send(res, 200, { mode, ...computeAlerts(store.read(500)) });
      }
      if (url.pathname === '/api/clear') {
        if (!guardPost(req, res)) return;
        store.clear();
        return send(res, 200, { mode, cleared: true });
      }
      if (url.pathname === '/api/check') {
        if (!guardPost(req, res)) return;
        busy ||= check().finally(() => {
          busy = null;
        });
        const entry = await busy;
        return send(res, 200, { mode, entry, baseline: baselineView() });
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      return send(res, 500, { error: 'SERVER_ERROR', message: String(e && e.message ? e.message : e).slice(0, 120) });
    }
  };

  return { server: http.createServer(handler), store, meta, baselines };
}

function parseArgs(argv) {
  const opts = { demo: false, save: true, open: false, port: Number(process.env.PORT) || DEFAULT_PORT, explicitPort: Boolean(process.env.PORT) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo' || a === '-Demo') opts.demo = true;
    else if (a === '--no-save') opts.save = false;
    else if (a === '--open') opts.open = true;
    else if (a.startsWith('--port=')) { opts.port = Number(a.slice(7)); opts.explicitPort = true; }
    else if (a === '--port') { opts.port = Number(argv[++i]); opts.explicitPort = true; }
  }
  return opts;
}

// 같은 모드로 이미 켜져 있는 대시보드를 찾습니다. (아이콘을 두 번 눌러도 두 개가 켜지지 않게)
export async function findRunning({ from = DEFAULT_PORT, count = 10, mode = 'real', saving = true, timeout = 700 } = {}) {
  for (let p = from; p < from + count && p <= 65535; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) continue;
      const h = await r.json();
      if (h && h.app === 'pc-control-dashboard' && h.mode === mode && h.saving === saving) return `http://127.0.0.1:${p}`;
    } catch {
      // 비어 있거나 다른 프로그램이 쓰는 번호예요.
    }
  }
  return null;
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  // 주소만 기본 브라우저로 엽니다.
  execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

function listen(server, port, tries) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(server, port + 1, tries - 1));
      else reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 15)) {
    console.error(`Node.js가 너무 오래됐어요(지금 ${process.versions.node}). 22 이상을 권장해요. https://nodejs.org 에서 받을 수 있어요.`);
    process.exit(1);
  }
  const { demo, save, open, port, explicitPort } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('포트 번호는 1~65535 사이 숫자여야 해요. 예: --port=4200');
    process.exit(1);
  }
  if (!explicitPort) {
    const running = await findRunning({ from: port, mode: demo ? 'demo' : 'real', saving: save });
    if (running) {
      console.log(`이미 켜져 있어요: ${running}`);
      console.log('새로 켜지 않고 브라우저만 열었어요. 이 창은 닫아도 돼요.');
      if (open) openBrowser(running);
      process.exit(0);
    }
  }
  const { server, meta } = createDashboard({ demo, save });
  try {
    const real = await listen(server, port, explicitPort ? 0 : 9);
    const url = `http://127.0.0.1:${real}`;
    console.log(`내 PC 관제 대시보드 v${VERSION}${demo ? ' [예제 모드]' : ''}`);
    console.log(`브라우저에서 열기: ${url}`);
    const where = { folder: '이 프로젝트의 student/data 폴더에 기록해요', temp: '프로젝트 폴더에 쓸 수 없어 임시 폴더에 기록해요', memory: '기록을 파일에 남기지 않아요(창을 닫으면 사라져요)' }[meta().storage];
    console.log(where);
    console.log('끄려면 Ctrl+C. 이 앱은 읽기만 하고 PC 설정을 바꾸지 않으며, 외부 서버에 연결하지 않아요.');
    if (open) openBrowser(url);
    // Ctrl+C 나 창 닫기로 끌 때 연결을 정리하고 조용히 끝나요.
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        console.log('\n대시보드를 껐어요.');
        server.close(() => process.exit(0));
        server.closeAllConnections?.();
        setTimeout(() => process.exit(0), 1000).unref();
      });
    }
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `포트 ${port}번을 이미 쓰고 있어요. --port=4200처럼 다른 번호로 켜 보세요.` : `서버를 켜지 못했어요: ${e.message}`);
    process.exit(1);
  }
}
