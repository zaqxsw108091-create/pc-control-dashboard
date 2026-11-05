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
import { judgeAll } from './judge.mjs';
import { execFile } from 'node:child_process';
import { openStore, toEntry } from './store.mjs';
import { computeAlerts } from './alerts.mjs';
import { demoReadings } from './demo.mjs';
import { FIELDS, sanitizeThresholds, createSettingsStore } from './settings.mjs';
import { THRESHOLDS } from './judge.mjs';

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
  let demoStep = store.count();
  let busy = null;

  // 예제 모드에서 그래프가 비어 보이지 않도록, 처음 한 번만 지난 기록 12개를 예제 값으로 채웁니다.
  if (demo && store.count() === 0) {
    const now = Date.now();
    for (let k = 0; k < 12; k++) {
      store.append(toEntry(judgeAll(demoReadings(k)), mode, new Date(now - (12 - k) * 60000)));
    }
    demoStep = 12;
  }

  async function check() {
    const readings = demo ? demoReadings(demoStep++) : await collect();
    const result = judgeAll(readings, settings.get());
    const entry = toEntry(result, mode);
    store.append(entry);
    return entry;
  }

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
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: VERSION, mode });
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
        return send(res, 200, { mode, entry: await busy });
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      return send(res, 500, { error: 'SERVER_ERROR', message: String(e && e.message ? e.message : e).slice(0, 120) });
    }
  };

  return { server: http.createServer(handler), store, meta };
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
