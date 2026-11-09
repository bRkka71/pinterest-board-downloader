'use strict';
// Local-only browser regression fixture. No Pinterest account, cookies or files are used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = new Map([
  ['/userscript.js', path.join(root, 'pinterest-board-downloader.user.js')],
  ['/fixture.js', path.join(__dirname, 'fixture.js')],
  ['/browser-smoke.js', path.join(__dirname, 'browser-smoke.js')]
]);
const thumb = '<svg xmlns="http://www.w3.org/2000/svg" width="236" height="310"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#bbb0a2"/><stop offset="1" stop-color="#424f49"/></linearGradient></defs><rect width="236" height="310" fill="url(#g)"/><circle cx="170" cy="75" r="50" fill="#d7c5a4"/><path d="M0 310L85 100l150 210" fill="#eee5d3"/><text x="18" y="285" fill="#1e3029" font-family="sans-serif" font-size="18">TEST REFERENCE</text></svg>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__stop' && req.method === 'POST') { res.end('stopped'); server.close(); return; }
  if (assets.has(url.pathname)) { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(assets.get(url.pathname))); return; }
  if (url.pathname === '/thumb.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end(thumb); return; }
  if (!/^\/demo\/|^\/pin\/|^\/$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pinterest 用户脚本本地测试</title><style>body{font:16px system-ui;background:#f4f1ed;margin:35px}section{display:flex;gap:20px}.pin{width:190px;border-radius:12px;background:white;padding:10px}.pin img{width:170px;height:220px;object-fit:cover;border-radius:9px}p{color:#666}</style></head><body>
  <h1>Pinterest 画板下载 · 本地测试</h1><p>虚构画板 / 所有保存操作均截获，不写入下载目录。</p>
  <section><div class="pin" data-test-id="pin"><a href="/pin/1001/"><img src="/thumb.svg" alt="模拟 Pin"><p>悬停可测试单张下载</p></a></div></section>
  <script id="__PWS_DATA__" type="application/json">{"appVersion":"test-fixture","context":{"user":{"username":"demo"}}}</script>
  <script src="/fixture.js"></script><script src="/userscript.js"></script>
  ${url.searchParams.get('run') === '1' ? '<script src="/browser-smoke.js"></script><script>window.__result={state:"running"};runPinterestSmoke().then(x=>window.__result=x).catch(e=>window.__result={error:e.stack});</script>' : ''}
  </body></html>`);
});
server.listen(Number(process.env.PORT || 18762), '127.0.0.1', () => console.log(`Fixture: http://127.0.0.1:${server.address().port}/demo/board/?run=1`));
