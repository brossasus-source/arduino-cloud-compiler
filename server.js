// Render: Arduino (AVR) derleme sunucusu. Bagimlilik yok, sadece Node + arduino-cli.
//   GET  /         -> "ok"  (sunucuyu uyandirmak / durum kontrolu)
//   POST /compile  -> { code, board }  =>  { hex }  |  { error, details }
// Ortam degiskeni (istege bagli): ALLOWED_ORIGIN = https://siteadresin.com

const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY = 300 * 1024;        // en fazla 300 KB kod
const COMPILE_TIMEOUT_MS = 150000;  // tek derleme icin en fazla 150 sn
const MAX_QUEUE = 4;                // sirada bekleyen en fazla is (ucretsiz plan 512 MB RAM)

const BOARD_RE = /^arduino:avr:(uno|nano|mega|leonardo|micro)(:[A-Za-z0-9_=,]+)?$/;

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors() });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// Isleri tek tek calistir (ayni anda iki derleme 512 MB RAM'i zorlayabilir)
let chain = Promise.resolve();
let waiting = 0;
function enqueue(fn) {
  waiting++;
  const run = chain.then(fn, fn);
  chain = run.catch(() => {}).finally(() => { waiting--; });
  return run;
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn('arduino-cli', args, { cwd });
    } catch (e) {
      return resolve({ code: -1, out: 'arduino-cli baslatilamadi: ' + e.message, timedOut: false, spawnError: true });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, COMPILE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: 'arduino-cli baslatilamadi: ' + e.message, timedOut: false, spawnError: true });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}

async function compile(code, board) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-'));
  try {
    await fs.mkdir(path.join(dir, 'sketch'));
    await fs.writeFile(path.join(dir, 'sketch', 'sketch.ino'), code, 'utf8');
    const r = await runCli(['compile', '--fqbn', board, '--output-dir', 'build', 'sketch'], dir);
    if (r.timedOut) return { status: 504, body: { error: 'Derleme zaman asimina ugradi' } };
    if (r.spawnError) return { status: 500, body: { error: 'Sunucu hatasi', details: r.out } };
    if (r.code !== 0) return { status: 400, body: { error: 'Derleme hatasi', details: r.out.slice(-1500) || 'Ayrinti yok' } };
    let hex;
    try { hex = await fs.readFile(path.join(dir, 'build', 'sketch.ino.hex'), 'utf8'); }
    catch { return { status: 500, body: { error: 'Hex dosyasi olusmadi', details: r.out.slice(-800) } }; }
    return { status: 200, body: { hex } };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...cors() });
      return res.end('ok');
    }

    if (req.method === 'POST' && url.pathname === '/compile') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return send(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'Kod cok uzun' : 'Gecersiz istek' }); }

      const code = String((body && body.code) || '');
      const board = String((body && body.board) || '');
      if (!code) return send(res, 400, { error: 'Kod bos' });
      if (!BOARD_RE.test(board)) return send(res, 400, { error: 'Desteklenmeyen kart: ' + board.slice(0, 60) });
      if (waiting >= MAX_QUEUE) return send(res, 429, { error: 'Sunucu mesgul, biraz sonra tekrar deneyin' });

      const result = await enqueue(() => compile(code, board));
      return send(res, result.status, result.body);
    }

    send(res, 404, { error: 'Bulunamadi' });
  } catch (e) {
    send(res, 500, { error: 'Sunucu hatasi: ' + e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('Derleme sunucusu hazir, port ' + PORT));
