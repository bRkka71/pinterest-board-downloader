'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const c = require('../pinterest-board-downloader.user.js');
const image = (id = 'aa', ext = 'jpg') => ({ url: `https://i.pinimg.com/originals/aa/bb/cc/${id}.${ext}`, width: 1080, height: 1440 });
const small = id => ({ ...image(id), url: image(id).url.replace('/originals/', '/736x/'), width: 736, height: 981 });
const pin = (id = '1001', extra = {}) => ({ type: 'pin', id, title: '参考图', images: { orig: image(), '736x': small('aa'), '236x': small('aa') }, ...extra });
const mp4 = { V_720P: { url: 'https://v1.pinimg.com/videos/aa.mp4', width: 720, height: 1280 }, V_HLSV4: { url: 'https://v1.pinimg.com/videos/aa.m3u8' } };
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
const response = (data, bookmarks = ['-end-'], status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => ({ resource_response: { data }, resource: { options: { bookmarks } } }) });
const requestWith = replies => {
  let count = 0;
  const request = options => { const r = replies[Math.min(count++, replies.length - 1)]; queueMicrotask(() => r.event ? options[r.event]() : options.onload({ status: 200, response: png.buffer, ...r })); return { abort() {} }; };
  request.count = () => count; return request;
};

test('accepts only credential-free HTTPS Pinterest CDN URLs', () => {
  assert.equal(c.allowedMediaUrl(image().url + '?x=1#frag'), image().url + '?x=1');
  for (const url of ['http://i.pinimg.com/a.jpg', 'https://i.pinimg.com.evil.test/a.jpg', 'https://user:password@i.pinimg.com/a.jpg', 'https://i.pinimg.com:444/a.jpg', 'data:image/png,hello', 'javascript:alert(1)']) assert.equal(c.allowedMediaUrl(url), null, url);
});
test('keeps the actual original extension and URL, including HEIC and signed URLs', () => {
  for (const ext of ['png', 'webp', 'heic', 'gif']) {
    const orig = image('ff', ext); orig.url += '?signature=keep';
    const out = c.extractMedia(pin('1', { images: { orig } }));
    assert.equal(out.media[0].candidates[0].url, orig.url); assert.equal(out.media[0].width, 1080);
  }
});
test('MP4 selection ignores is_video false and prefers largest available direct file', () => {
  const r = c.extractMedia(pin('1', { is_video: false, videos: { video_list: mp4 } }));
  assert.equal(r.media.length, 1); assert.equal(r.media[0].kind, 'video'); assert.ok(r.media[0].candidates[0].url.endsWith('.mp4'));
});
test('disabled or HLS-only videos are skipped, not disguised as cover images', () => {
  const v = pin('1', { videos: { video_list: mp4 } });
  assert.equal(c.extractMedia(v, { videos: false }).media.length, 0);
  const h = c.extractMedia(pin('1', { videos: { video_list: { hls: mp4.V_HLSV4 } } }));
  assert.equal(h.media.length, 0); assert.match(h.skipped[0].reason, /流媒体/);
});
test('carousel cover matching uses image identity rather than assuming first slot', () => {
  const p = pin('1', { images: { orig: image('bb', 'png') }, carousel_data: { carousel_slots: [
    { id: 'a', images: { '736x': small('aa') } }, { id: 'b', images: { '736x': small('bb') } }
  ] } });
  const r = c.extractMedia(p).media;
  assert.equal(r.length, 2); assert.equal(r[0].candidates[0].url, image('aa').url); assert.equal(r[1].candidates[0].url, image('bb', 'png').url);
});
test('carousel media identifiers do not change when video is disabled', () => {
  const p = pin('1', { carousel_data: { carousel_slots: [{ id: 'v', videos: { video_list: mp4 } }, { id: 'photo', images: { orig: image() } }] } });
  const build = videos => c.buildItems([{ key: 'main', title: '未分区', pins: [p] }], { board: { name: '测试' }, videos }).items;
  assert.equal(build(true)[1].key, build(false)[0].key); assert.equal(build(false)[0].page, 2); assert.equal(build(false)[0].pages, 2);
});
test('story pages use their own originals and retain HEIC metadata', () => {
  const p = pin('1', { story_pin_data: { page_count: 2, pages: [{ blocks: [{ image: { images: { originals: image('aa') } } }] }, { blocks: [{ image: { images: { originals: image('ff', 'heic') } } }] }] } });
  const r = c.extractMedia(p).media; assert.equal(r.length, 2); assert.equal(r[1].candidates[0].url, image('ff', 'heic').url);
});
test('deduplicates Pin IDs and excludes non-pin feed entries', () => {
  const p = pin(); const r = c.buildItems([{ key: 'main', title: '未分区', pins: [p, { type: 'story', id: 'footer' }] }, { key: 's:1', title: '分区', pins: [p, pin('1002')] }], { board: { name: '测试' } });
  assert.equal(r.pinCount, 2); assert.equal(r.items.length, 2); assert.equal(r.items[1].section, '分区');
});
test('handles board, section, Chinese and pin routes without matching settings', () => {
  assert.deepEqual(c.parseRoute('/demo/%E9%A3%8E%E8%A1%A3/'), { type: 'board', username: 'demo', slug: '风衣', sectionSlug: null });
  assert.equal(c.parseRoute('/demo/a/b/').type, 'section'); assert.equal(c.parseRoute('/pin/123/').pinId, '123');
  for (const path of ['/', '/demo/', '/settings/security/', '/demo/_saved/', '/search/pins/']) assert.equal(c.parseRoute(path), null);
});
test('board API uses decoded slug in data and ASCII source-url headers', async () => {
  let called;
  const api = c.makeApi(async (url, options) => { called = { url, options }; return response({ id: '1' }); }, { csrf: 'test-only', appVersion: 'test' });
  await api.board('demo', '风衣');
  const u = new URL(called.url, 'https://www.pinterest.com');
  assert.equal(JSON.parse(u.searchParams.get('data')).options.slug, '风衣');
  assert.equal(called.options.headers['X-Pinterest-Source-Url'], '/demo/%E9%A3%8E%E8%A1%A3/');
  assert.equal(called.options.headers['X-Pinterest-PWS-Handler'], 'www/[username]/[slug].js');
  assert.equal(called.options.credentials, 'include'); assert.ok(!called.options.body);
});
test('pagination follows bookmarks and accepts array or results wrapper', async () => {
  const calls = [];
  const api = c.makeApi(async url => { const data = JSON.parse(new URL(url, 'https://www.pinterest.com').searchParams.get('data')); calls.push(data.options); return calls.length === 1 ? response([pin()], ['cursor1']) : response({ results: [pin('1002')] }); }, { wait: async () => {} });
  const list = await api.boardPins({ id: '8', url: '/demo/a/' }, {});
  assert.equal(list.length, 2); assert.deepEqual(calls[1].bookmarks, ['cursor1']); assert.equal(calls[0].page_size, 100); assert.equal(calls[0].filter_section_pins, true);
});
test('section feed uses its verified page size and correct handler', async () => {
  let called;
  const api = c.makeApi(async (url, options) => { called = { url, options }; return response([]); });
  await api.sectionPins({ url: '/demo/a/' }, { id: '10', slug: 'details' }, {});
  assert.equal(JSON.parse(new URL(called.url, 'https://www.pinterest.com').searchParams.get('data')).options.page_size, 25);
  assert.equal(called.options.headers['X-Pinterest-PWS-Handler'], 'www/[username]/[slug]/[section_slug].js');
});
test('missing or repeated bookmarks fail instead of claiming completeness', async () => {
  let count = 0;
  const repeat = c.makeApi(async () => { count++; return response([pin()], ['same']); }, { wait: async () => {} });
  await assert.rejects(repeat.boardPins({ id: '1', url: '/demo/a/' }, {}), /重复/); assert.equal(count, 2);
  const missing = c.makeApi(async () => ({ ok: true, status: 200, json: async () => ({ resource_response: { data: [pin()] } }) }));
  await assert.rejects(missing.boardPins({ id: '1', url: '/demo/a/' }, {}), /缺少分页/);
});
test('API rate limits honor Retry-After and stop on authentication errors', async () => {
  let count = 0; const waits = [];
  const api = c.makeApi(async () => ++count === 1 ? response(null, [], 429, { 'Retry-After': '45' }) : response({ id: '1' }), { wait: async n => waits.push(n) });
  await api.board('demo', 'a'); assert.deepEqual(waits, [45000]);
  count = 0; const denied = c.makeApi(async () => { count++; return response(null, [], 403); });
  await assert.rejects(denied.board('demo', 'a'), /403/); assert.equal(count, 1);
});
test('safe names and templates prevent traversal and duplicate paths', () => {
  assert.equal(c.safeName('CON'), '_CON'); assert.ok(!c.safeName('../../x').includes('/'));
  const n = c.makeNamer('{分区}', '{标题}'); const it = { section: 'A', title: '同名', pinId: '1' };
  assert.equal(n(it, 'jpg'), 'A/同名.jpg'); assert.equal(n(it, 'jpg'), 'A/同名_2.jpg');
  assert.equal(c.renderTemplate('{序号}_{标题}_{页码}', { seq: 1, title: '', page: 1, pages: 1 }), '0001');
});
test('CSV quotes all fields, starts with BOM, and neutralizes formulas including spaces', () => {
  for (const s of ['=cmd()', ' +SUM(1)', '\tbad', '\rline', '@ref', '-1']) assert.ok(c.csvCell(s).startsWith('"\''), s);
  assert.equal(c.csvCell('a"b,c'), '"a""b,c"'); assert.ok(c.toCsv([]).startsWith('\ufeff'));
});
test('format detection covers binary image types, HEIC, and MP4; rejects HTML', () => {
  assert.equal(c.detectType(png), 'png'); assert.equal(c.detectType(Buffer.from('0000ftypheic000000')), 'heic');
  assert.equal(c.detectType(Buffer.from('0000ftypisom000000')), 'mp4'); assert.equal(c.detectType(Buffer.from('RIFF0000WEBP0000')), 'webp');
  assert.throws(() => c.detectType(Buffer.from('<html>login</html>')), /不是/);
});
test('ZIP CRC, Unicode paths and payload independently verified by Python', async () => {
  assert.equal(c.crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = c.makeZip([{ name: '分区/原图.png', data: png }, { name: '清单.csv', data: c.toCsv([]) }]);
  const r = spawnSync('python3', ['-c', 'import io,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nassert z.namelist()==["分区/原图.png","清单.csv"]\nassert z.read("分区/原图.png").startswith(bytes([137,80,78,71]))\nassert z.read("清单.csv").startswith(bytes([239,187,191]))'], { input: Buffer.from(await zip.arrayBuffer()), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
test('CDN requests are anonymous GET and report actual binary format', async () => {
  let options;
  const r = await c.requestOnce(image().url, null, opts => { options = opts; queueMicrotask(() => opts.onload({ status: 200, response: png.buffer })); return { abort() {} }; });
  assert.equal(options.method, 'GET'); assert.equal(options.anonymous, true); assert.equal(r.ext, 'png');
});
test('thumbnail fallback requires opt-in, with an explicit result note', async () => {
  const it = { kind: 'image', candidates: [{ url: image().url }, { url: small('aa').url, fallback: true, note: '降级' }] };
  const off = requestWith([{ status: 404 }]); await assert.rejects(c.downloadMedia(it, { request: off }), /原图/); assert.equal(off.count(), 1);
  const on = requestWith([{ status: 404 }, {}]); const r = await c.downloadMedia(it, { request: on, allowFallback: true }); assert.equal(r.note, '降级');
});
test('cancellation aborts in-flight network request', async () => {
  const controller = new AbortController(); let cancelled = false;
  const task = c.requestOnce(image().url, controller.signal, () => ({ abort() { cancelled = true; } }));
  controller.abort(); await assert.rejects(task, { name: 'AbortError' }); assert.equal(cancelled, true);
});
test('oversized payload and untrusted redirect are rejected', async () => {
  await assert.rejects(c.requestOnce(image().url, null, requestWith([{ response: { byteLength: 129 * 1024 * 1024 } }])), /128/);
  await assert.rejects(c.requestOnce(image().url, null, requestWith([{ finalUrl: 'https://evil.test/image.png' }])), /重定向/);
});
test('preview HTML escapes titles and source links without injecting scripts', () => {
  const html = c.previewHtml('<img onerror=1>', [{ pinId: '1', page: 1, section: '<script>x</script>', title: '<svg onload=1>', description: '', link: 'javascript:alert(1)', pinUrl: 'https://www.pinterest.com/pin/1/', thumb: small('aa').url }]);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:')); assert.ok(html.includes('&lt;svg'));
});
