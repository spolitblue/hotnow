/* ============================================================================
 * HotNow · 全网热榜 — 本地服务（零依赖）
 * ----------------------------------------------------------------------------
 *   node server.mjs            # 默认 http://127.0.0.1:8788
 *   PORT=9000 node server.mjs
 *
 * 作用：
 *   1. 静态托管 index.html / styles.css / app.js / sources.js
 *   2. /v2/*   反向代理到 60s API，并做服务端缓存（默认 5 分钟）
 *              → 首次加载后其它设备/标签页几乎不再打上游，规避限流
 *              → 上游挂了还能吐旧数据（stale-while-error）
 *   3. /api/health  前端据此判断是否走本地代理
 *      /api/status  缓存与统计
 *
 * 只是可选的加速层：直接双击 index.html 也能用（上游允许跨域）。
 * ==========================================================================*/

import http from 'node:http';
import vm from 'node:vm';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const UPSTREAM = process.env.UPSTREAM || 'https://60s-api.viki.moe';
const TTL = Number(process.env.CACHE_TTL || 600) * 1000;
/* 不同榜单更新频率差别很大：按路径分级缓存，能显著降低对上游的请求量 */
const TTL_TIERS = [
  { re: /douban|maoyan\/all|epic/i, ms: 6 * 3600 * 1000 },   // 周更榜 / 总榜：6 小时
  { re: /\/60s|\/moyu|ai-news/i, ms: 1800 * 1000 },          // 日更内容：30 分钟
];
const ttlFor = (p) => (TTL_TIERS.find((t) => t.re.test(p)) || { ms: TTL }).ms;
const UPSTREAM_CONCURRENCY = Number(process.env.UPSTREAM_CONCURRENCY || 1);
const MIN_GAP = Number(process.env.MIN_GAP_MS || 1500);  // 两次上游请求之间的最小间隔（实测 1.5s 可全量成功）
const REQUEST_TIMEOUT = 20000;
const WARM = process.env.WARM !== '0';
const CACHE_FILE = join(ROOT, '.cache', 'hotnow-cache.json');

/* ---------- 静态资源 MIME ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* ---------- 缓存 ---------- */
const cache = new Map();     // path -> { body, at, hits }
const inflight = new Map();  // path -> Promise
let queueActive = 0;
const waiters = [];

/* 落盘缓存：重启服务后依然秒开，且上游全挂时仍能出数据 */
let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      const dump = { savedAt: Date.now(), entries: [...cache.entries()] };
      await writeFile(CACHE_FILE, JSON.stringify(dump), 'utf8');
    } catch { /* 落盘失败不影响服务 */ }
  }, 1500);
}

async function restore() {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const dump = JSON.parse(raw);
    for (const [path, v] of dump.entries || []) {
      if (v && typeof v.body === 'string') cache.set(path, { body: v.body, at: v.at || 0, hits: 0 });
    }
    return `已从磁盘恢复 ${cache.size} 个接口的缓存`;
  } catch {
    return '磁盘缓存为空（首次运行）';
  }
}

function acquire() {
  if (queueActive < UPSTREAM_CONCURRENCY) { queueActive++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  queueActive--;
  const next = waiters.shift();
  if (next) { queueActive++; next(); }
}

/* 全局节流：上游对突发请求非常敏感（并发一高就 429），
   实测约 1 请求/秒 稳定，因此这里严格串行 + 最小间隔。 */
let paceChain = Promise.resolve();
let lastStart = 0;
let cooldownUntil = 0;
function pace() {
  paceChain = paceChain.then(async () => {
    let wait = lastStart + MIN_GAP - Date.now();
    if (cooldownUntil > Date.now()) wait = Math.max(wait, cooldownUntil - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  return paceChain;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(path) {
  await pace();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(UPSTREAM + path, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'HotNow/1.0 (+local proxy)' },
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* 被限流的路径先冷静一会儿，避免重试把限流放大 */
const quarantined = new Map();   // path -> until(ms)
const QUARANTINE = 90000;

async function fetchUpstream(path) {
  if (inflight.has(path)) return inflight.get(path);
  if ((quarantined.get(path) || 0) > Date.now()) {
    return { status: 429, body: '', quarantined: true };
  }
  const job = (async () => {
    await acquire();
    try {
      let out = { status: 0, body: '' };
      for (let attempt = 0; attempt < 3; attempt++) {
        out = await once(path);
        if (out.status === 200) { quarantined.delete(path); return out; }
        const retriable = out.status === 429 || out.status === 0 || out.status >= 500;
        if (!retriable) return out;
        if (out.status === 429) {
          // 被限流：整条通道冷却 + 该路径静默一段时间
          cooldownUntil = Date.now() + 4000;
          quarantined.set(path, Date.now() + QUARANTINE);
          return out;
        }
        // 5xx 多为上游自身故障（如 B 站 / 小红书），只再试一次
        if (attempt >= 1) return out;
        await sleep(1200);
      }
      return out;
    } finally {
      release();
      inflight.delete(path);
    }
  })();
  inflight.set(path, job);
  return job;
}

/* 启动后按注册表顺序后台预热：浏览器请求会与之合并，命中后即为缓存直出 */
async function warmAll(paths) {
  let ok = 0, fail = 0, skipped = 0;
  for (const p of paths) {
    const hit = cache.get(p);
    if (hit && Date.now() - hit.at < ttlFor(p)) { skipped++; continue; }
    if ((quarantined.get(p) || 0) > Date.now()) { skipped++; continue; }
    try {
      const out = await fetchUpstream(p);
      if (out.status === 200) ok++; else fail++;
    } catch { fail++; }
  }
  console.log(`  后台预热   完成：新增 ${ok} · 失败 ${fail} · 跳过 ${skipped}`);
  persistSoon();
}

/* 读取前端的数据源注册表（sources.js 是经典脚本，用 vm 跑一遍即可复用同一份定义，
   避免两处维护；同时天然跳过 optional 的源，不浪费上游配额） */
async function readSourcePaths() {
  try {
    const text = await readFile(join(ROOT, 'sources.js'), 'utf8');
    const sandbox = { window: {}, navigator: { onLine: true }, document: undefined };
    vm.runInNewContext(text, sandbox, { timeout: 3000 });
    return (sandbox.window.HOT_SOURCES || [])
      .filter((s) => s && s.path && !s.optional)
      .map((s) => s.path);
  } catch (err) {
    console.log('  ⚠️  解析 sources.js 失败，跳过预热：' + err.message);
    return [];
  }
}

async function handleApiV2(req, res, path) {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < ttlFor(path)) {
    hit.hits++;
    send(res, 200, hit.body, { 'x-hotnow-cache': 'HIT', 'x-hotnow-age': String(Math.round((now - hit.at) / 1000)) });
    return;
  }

  try {
    const out = await fetchUpstream(path);
    if (out.status === 200) {
      let ok = true;
      try { const j = JSON.parse(out.body); ok = !j.code || j.code === 200; } catch { ok = false; }
      if (ok) {
        cache.set(path, { body: out.body, at: Date.now(), hits: 0 });
        persistSoon();
        send(res, 200, out.body, { 'x-hotnow-cache': 'MISS' });
        return;
      }
    }
    // 上游报错：有旧数据就吐旧的
    if (hit) {
      send(res, 200, hit.body, { 'x-hotnow-cache': 'STALE', 'x-hotnow-upstream': String(out.status) });
      return;
    }
    send(res, out.status >= 400 ? out.status : 502, JSON.stringify({
      code: out.status, message: '上游返回异常', data: [],
    }), { 'content-type': MIME['.json'], 'x-hotnow-cache': 'ERROR' });
  } catch (err) {
    if (hit) {
      send(res, 200, hit.body, { 'x-hotnow-cache': 'STALE', 'x-hotnow-error': String(err.message).slice(0, 60) });
      return;
    }
    send(res, 504, JSON.stringify({ code: 504, message: '上游请求失败：' + err.message, data: [] }), {
      'content-type': MIME['.json'],
    });
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(body);
}

/* ---------- 静态文件 ---------- */
async function handleStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 不允许访问隐藏文件（如 .cache 落盘缓存）
  if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) {
    res.writeHead(404, { 'content-type': MIME['.html'] }).end('<h1>404</h1>');
    return;
  }

  const full = join(ROOT, normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  try {
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(404).end('Not found'); return; }
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      // 前端三件套不缓存，方便改完刷新即生效
      'cache-control': /\.(js|css|html)$/i.test(full) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] })
      .end('<h1>404</h1><p>页面不存在。</p><p><a href="/">回到 HotNow</a></p>');
  }
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/api/health' || url.startsWith('/api/health?')) {
    send(res, 200, JSON.stringify({
      ok: true, service: 'hotnow', version: 1, upstream: UPSTREAM, cached: cache.size, ttl: TTL / 1000,
    }));
    return;
  }

  if (url === '/api/status' || url.startsWith('/api/status?')) {
    const entries = [...cache.entries()].map(([p, v]) => ({
      path: p,
      age: Math.round((Date.now() - v.at) / 1000),
      bytes: v.body.length,
      hits: v.hits,
      ttl: ttlFor(p) / 1000,
      fresh: Date.now() - v.at < ttlFor(p),
    })).sort((a, b) => a.path.localeCompare(b.path));
    send(res, 200, JSON.stringify({
      ok: true,
      upstream: UPSTREAM,
      ttl: TTL / 1000,
      inflight: inflight.size,
      concurrency: UPSTREAM_CONCURRENCY,
      minGapMs: MIN_GAP,
      cached: entries.length,
      entries,
    }, null, 2));
    return;
  }

  if (url.startsWith('/v2/')) { await handleApiV2(req, res, url.split('?')[0]); return; }

  await handleStatic(req, res, url);
});

/* ---------- 端口选择 ---------- */
const PREFERRED = Number(process.env.PORT || 8788);
const CANDIDATES = [PREFERRED, PREFERRED + 1, PREFERRED + 2, 9080, 8080];

function listen(port, index = 0) {
  return new Promise((res, rej) => {
    const onError = (err) => {
      server.removeListener('listening', onOk);
      if (err.code === 'EADDRINUSE' && index + 1 < CANDIDATES.length) {
        res(listen(CANDIDATES[index + 1], index + 1));
      } else rej(err);
    };
    const onOk = () => {
      server.removeListener('error', onError);
      res(port);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

const port = await listen(PREFERRED);
const url = `http://127.0.0.1:${port}/`;
const restored = await restore();
console.log('');
console.log('  🔥 HotNow · 全网热榜');
console.log('  ────────────────────────────────────────────');
console.log(`  本地地址   ${url}`);
console.log(`  上游数据   ${UPSTREAM}`);
console.log(`  缓存 TTL   ${TTL / 1000} 秒 · 上游并发 ${UPSTREAM_CONCURRENCY} · 最小间隔 ${MIN_GAP}ms`);
console.log(`  磁盘缓存   ${restored}`);
console.log('  停止服务   Ctrl + C');
console.log('');

if (process.env.NO_OPEN !== '1') {
  const { spawn } = await import('node:child_process');
  try {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打开失败无妨，手动访问即可 */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  已停止 HotNow 服务。');
    process.exit(0);
  });
}

/* 后台预热（不阻塞浏览器请求：同路径请求会与预热合并） */
if (WARM) {
  const paths = await readSourcePaths();
  if (paths.length) {
    console.log(`  后台预热   ${paths.length} 个接口排队中（预计 ${Math.ceil(paths.length * (MIN_GAP + 2000) / 1000)}s 内完成）…`);
    warmAll(paths).catch(() => {});
  }
}
