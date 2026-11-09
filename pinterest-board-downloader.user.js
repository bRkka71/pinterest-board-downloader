// ==UserScript==
// @name         Pinterest 画板原图批量下载
// @namespace    local.pinterest.board-downloader
// @version      1.0.0
// @description  一键下载 Pinterest 画板或分区的原图和 mp4 视频，自定义命名，自动分包 ZIP，附 CSV 出处清单；支持只下新增、挑选单张、悬停下载单个 pin。
// @match        https://www.pinterest.com/*
// @match        https://pinterest.com/*
// @match        https://*.pinterest.com/*
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/bRkka71/pinterest-board-downloader/main/pinterest-board-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/bRkka71/pinterest-board-downloader/main/pinterest-board-downloader.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      i.pinimg.com
// @connect      v1.pinimg.com
// @connect      pinimg.com
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const MAX_FILE_BYTES = 128 * 1024 * 1024;
  const PART_BYTES = 64 * 1024 * 1024;
  const encoder = new TextEncoder();

  function safeName(value, length = 90) {
    let name = String(value ?? '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    name = Array.from(name).slice(0, length).join('').replace(/[. ]+$/g, '');
    if (!name || /^\.+$/.test(name)) name = '未命名';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }

  // 只允许 Pinterest 图片/视频服务器（*.pinimg.com）的 https 地址。
  function allowedMediaUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      if (url.hostname !== 'pinimg.com' && !url.hostname.endsWith('.pinimg.com')) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  // 按文件头判断真实格式，避免把错误页存成图片。
  function detectType(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'png';
    const head = String.fromCharCode(...bytes.subarray(0, 32));
    if (/^GIF8[79]a/.test(head)) return 'gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
    if (head.slice(4, 8) === 'ftyp') {
      const brand = head.slice(8, 12);
      if (/^(avif|avis)$/.test(brand)) return 'avif';
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
      if (brand === 'qt  ') return 'mov';
      return 'mp4';
    }
    if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tif';
    if (head.startsWith('BM')) return 'bmp';
    throw new Error('响应不是图片或视频文件（可能是错误页），未保存。');
  }

  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ZIP（STORE，不重新压缩）；文件名 UTF-8。
  function makeZip(files) {
    if (files.length > 65535) throw new Error('单包文件过多。');
    const local = [], central = [];
    let offset = 0, centralSize = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
      if (name.length > 65535 || offset + data.length + name.length + 30 > 0xffffffff) throw new Error('ZIP 超出大小限制。');
      const crc = crc32(data);
      const header = new Uint8Array(30), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      local.push(header, name, data);
      const record = new Uint8Array(46), c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(record, name);
      offset += header.length + name.length + data.length;
      centralSize += record.length + name.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  function aborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('任务已停止', 'AbortError');
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  function retryAfterMs(headers) {
    const v = /^retry-after:\s*(.+)$/im.exec(headers || '')?.[1]?.trim();
    if (!v) return 0;
    const s = /^\d+$/.test(v) ? Number(v) : (Date.parse(v) - Date.now()) / 1000;
    return Number.isFinite(s) ? Math.min(120000, Math.max(0, s * 1000)) : 0;
  }


  // ---- 媒体提取（基于 2026-11 实测的 Pinterest 网页接口数据） ----
  const pickVideo = list => {
    if (!list || typeof list !== 'object') return null;
    const entries = Object.entries(list).filter(([, v]) => v && typeof v.url === 'string');
    const mp4 = entries.filter(([, v]) => /\.mp4(?:[?#]|$)/i.test(v.url) && allowedMediaUrl(v.url))
      .sort((a, b) => (b[1].width || 0) - (a[1].width || 0));
    if (mp4.length) return { url: allowedMediaUrl(mp4[0][1].url), width: mp4[0][1].width, height: mp4[0][1].height, hlsOnly: false };
    return entries.length ? { hlsOnly: true } : null;
  };
  // 普通图优先使用接口给出的原图；只有缺少原图字段的轮播子图才尝试 CDN 原图候选。
  function derivedCandidates(url) {
    const safe = allowedMediaUrl(url);
    if (!safe) return [];
    const u = new URL(safe);
    const m = /^\/(originals|\d+x\d*)\/([a-f0-9/]+)\.(jpe?g|png|webp|gif|avif|heic)$/i.exec(u.pathname);
    if (u.hostname !== 'i.pinimg.com' || u.search || !m) return [{ url: safe, fallback: !u.pathname.startsWith('/originals/'), note: u.pathname.startsWith('/originals/') ? '' : '使用页面提供的较小版本' }];
    const candidates = m[1] === 'originals' ? [{ url: safe, note: '' }] : [];
    for (const ext of ['jpg', 'png', 'webp']) {
      const original = `https://i.pinimg.com/originals/${m[2]}.${ext}`;
      if (!candidates.some(c => c.url === original)) candidates.push({ url: original, note: '', derived: true });
    }
    if (m[1] !== 'originals') candidates.push({ url: safe, note: '原图不可用，使用页面提供的较小版本', fallback: true });
    return candidates;
  }
  function imageCandidates(images, cover) {
    const original = images?.orig || images?.originals;
    const thumb = images?.['1200x'] || images?.['736x'] || images?.['564x'] || images?.['474x'];
    const result = [];
    const asset = value => { const u = allowedMediaUrl(value); return u ? new URL(u).pathname.replace(/^\/[^/]+\//, '/').replace(/\.[^/.]+$/, '') : null; };
    const target = original?.url || thumb?.url;
    const add = (image, fallback = false) => {
      const url = allowedMediaUrl(image?.url);
      if (url && !result.some(c => c.url === url)) result.push({ url, width: image.width || null, height: image.height || null, fallback, note: fallback ? '原图不可用，使用页面提供的较小版本' : '' });
    };
    if (target && cover && asset(target) === asset(cover.url)) add(cover);
    add(original);
    if (!result.length) result.push(...derivedCandidates(target));
    add(thumb, true);
    return result;
  }

  function extractMedia(pin, { videos = true } = {}) {
    const media = [], skipped = [];
    const cover = pin?.images?.orig;
    const add = (part, images, videoList, page, total, videoHint = false) => {
      const video = pickVideo(videoList);
      if (video || videoHint) {
        if (!videos) skipped.push({ part, reason: '视频下载未启用' });
        else if (!video || video.hlsOnly) skipped.push({ part, reason: '仅流媒体视频或缺少 MP4，未下载（不以封面图代替）' });
        else media.push({ part, page, pages: total, kind: 'video', candidates: [{ ...video, note: '' }], width: video.width, height: video.height });
        return;
      }
      const candidates = imageCandidates(images, cover);
      if (!candidates.length) { skipped.push({ part, reason: '没有可用的图片地址' }); return; }
      media.push({ part, page, pages: total, kind: 'image', candidates, width: candidates[0].width || null, height: candidates[0].height || null,
        thumb: allowedMediaUrl(images?.['236x']?.url) || allowedMediaUrl(images?.['474x']?.url) || '' });
    };
    const slots = pin?.carousel_data?.carousel_slots;
    const pages = pin?.story_pin_data?.pages;
    if (Array.isArray(slots) && slots.length) {
      slots.forEach((s, i) => add(`carousel:${s?.id ?? i}`, s?.images, s?.videos?.video_list, i + 1, slots.length, !!s?.is_video));
    } else if (Array.isArray(pages) && pages.length > 1) {
      pages.forEach((page, i) => {
        const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
        blocks.forEach((b, j) => {
          if (b?.video || /video/.test(b?.type || b?.block_type || '')) add(`story:${page.id ?? i}:${b.id ?? j}`, b?.image?.images, b?.video?.video_list, i + 1, pages.length, true);
          else if (b?.image) add(`story:${page.id ?? i}:${b.id ?? j}`, b.image.images, null, i + 1, pages.length);
        });
      });
      if (Number(pin.story_pin_data.page_count) > pages.length) skipped.push({ reason: '故事页数据不完整，仅处理接口返回的页面' });
    } else {
      const blocks = Array.isArray(pages) ? pages.flatMap(p => Array.isArray(p?.blocks) ? p.blocks : []) : [];
      const block = blocks.find(b => b?.video);
      add('main', pin?.images, pin?.videos?.video_list || block?.video?.video_list, 1, 1, !!pin?.is_video || !!block);
    }
    if (!media.length && !skipped.length) skipped.push({ reason: '未找到支持的媒体内容' });
    return { media, skipped };
  }

  // ---- 命名模板 ----
  const fmtDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString().slice(0, 10) : ''; };
  const NAME_FIELDS = {
    '画板': i => i.board, '分区': i => i.section, '序号': i => String(i.seq).padStart(4, '0'),
    '分区序号': i => String(i.sectionSeq || i.seq).padStart(3, '0'),
    '标题': i => i.title, '描述': i => Array.from(i.description || '').slice(0, 40).join(''),
    '来源网站': i => i.domain, 'PinID': i => i.pinId, '日期': i => i.date,
    '尺寸': i => i.width && i.height ? `${i.width}x${i.height}` : '',
    '原文件名': i => String(i.originalName || '').replace(/\.[a-z0-9]{1,5}$/i, ''),
    '页码': i => i.pages > 1 ? `p${i.page}` : ''
  };
  const DEFAULT_FOLDER = '{分区}';
  const DEFAULT_FILE = '{序号}_{标题}_{页码}';
  function renderTemplate(template, item, length = 120) {
    const text = String(template || '').replace(/\{([^{}]+)\}/g, (_, key) => {
      const f = NAME_FIELDS[key.trim()];
      return f ? safeName(f(item) || '', 80).replace(/^未命名$/, '') : '';
    });
    const cleaned = text.replace(/([_\-\s.·])\1+/g, '$1').replace(/[_\-\s·]+(?=[_\-\s·])/g, '')
      .replace(/^[_\-\s.·]+|[_\-\s.·]+$/g, '');
    return cleaned ? safeName(cleaned, length) : '';
  }
  function makeNamer(folderTpl, fileTpl) {
    const used = new Set();
    return (item, ext) => {
      const folder = folderTpl ? renderTemplate(folderTpl, item, 100) : '';
      const stem = renderTemplate(fileTpl || DEFAULT_FILE, item) || item.pinId || '未命名';
      const dir = folder ? folder + '/' : '';
      let name = `${dir}${stem}.${ext}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${dir}${stem}_${n}.${ext}`;
      used.add(name.toLowerCase());
      return name;
    };
  }

  // ---- CSV（UTF-8 BOM，防公式注入） ----
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[\s\uFEFF]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(rows) {
    const head = ['PinID', 'Pin链接', '来源网址', '标题', '描述', '画板', '分区', '文件', '宽', '高', '类型', '备注'];
    const lines = [head, ...rows.map(r => [r.pinId, r.pinUrl, r.link, r.title, r.description, r.board, r.section, r.file, r.width, r.height, r.kind === 'video' ? '视频' : '图片', r.note])];
    return '\ufeff' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }


  // ---- Pinterest 网页接口（只读 GET，使用当前登录状态） ----
  const RESERVED = new Set(['pin', 'search', 'ideas', 'today', 'settings', 'business', 'explore', 'news_hub', '_', 'oauth', 'login', 'logout', 'signup', 'password', 'about', 'board', 'homefeed', 'resource', 'shopping', 'videos', 'notifications', 'messages', 'pin-builder', 'edit']);
  function parseRoute(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    if (parts[0] === 'pin' && /^\d+$/.test(parts[1] || '')) return { type: 'pin', pinId: parts[1] };
    if (parts.length < 2 || parts.length > 3 || RESERVED.has(parts[0].toLowerCase())) return null;
    if (['_saved', '_created', 'boards', 'pins', '_tried'].includes(parts[1])) return null;
    return { type: parts.length === 3 ? 'section' : 'board', username: parts[0], slug: parts[1], sectionSlug: parts[2] || null };
  }
  const isEndBookmark = bm => !Array.isArray(bm) || !bm[0] || bm[0] === '-end-' || String(bm[0]).startsWith('Y2JOb25lO');

  function makeApi(fetchImpl, { csrf, appVersion, wait = sleep } = {}) {
    async function get(resource, options, sourceUrl, handler, signal) {
      sourceUrl = new URL(sourceUrl, 'https://www.pinterest.com').pathname;
      const url = `/resource/${resource}Resource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        aborted(signal);
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('读取 Pinterest 超时', 'TimeoutError')), 45000);
        let r, j, networkError;
        try {
          r = await fetchImpl(url, { credentials: 'include', signal: controller.signal, headers: {
            'Accept': 'application/json, text/javascript, */*, q=0.01', 'X-Requested-With': 'XMLHttpRequest',
            'X-CSRFToken': csrf || '', 'X-APP-VERSION': appVersion || '', 'X-Pinterest-AppState': 'active',
            'X-Pinterest-Source-Url': sourceUrl, 'X-Pinterest-PWS-Handler': handler
          } });
          j = await r.json().catch(() => null);
        } catch (error) { networkError = error; }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
        aborted(signal);
        if (networkError || r.status === 429 || r.status >= 500) {
          if (attempt === 3) throw networkError || new Error(`Pinterest 请求失败：HTTP ${r.status}，请稍后重试。`);
          const header = r?.headers?.get?.('retry-after');
          const retry = header ? retryAfterMs(`Retry-After: ${header}`) : 0;
          await wait(Math.max(retry, r?.status === 429 ? 15000 : 1500 * 2 ** attempt), signal);
          continue;
        }
        if (r.status === 404) throw Object.assign(new Error('找不到画板或分区，或当前账号无权访问。'), { status: 404 });
        if (!r.ok || !j || j.resource_response?.error) throw Object.assign(new Error(`Pinterest 接口返回 HTTP ${r.status}。请确认已登录后刷新重试。`), { status: r.status });
        return j;
      }
    }
    async function paginate(resource, options, sourceUrl, handler, { signal, onPage, delay = 350, maxPages = 2000 } = {}) {
      const out = [], seenBookmarks = new Set();
      let bookmarks = null;
      for (let page = 0; page < maxPages; page++) {
        const j = await get(resource, bookmarks ? { ...options, bookmarks } : options, sourceUrl, handler, signal);
        let data = j?.resource_response?.data;
        if (data && !Array.isArray(data)) data = data.results;
        if (!Array.isArray(data)) throw new Error('Pinterest 返回的数据格式变了，无法确认清单完整，已停止。');
        out.push(...data);
        onPage?.(out.length);
        bookmarks = j?.resource?.options?.bookmarks;
        if (!Array.isArray(bookmarks)) throw new Error('缺少分页标记，无法确认完整性，已停止。');
        if (isEndBookmark(bookmarks)) return out;
        const cursor = JSON.stringify(bookmarks);
        if (seenBookmarks.has(cursor)) throw new Error('Pinterest 重复返回同一分页标记，已停止以免循环请求。');
        seenBookmarks.add(cursor);
        await wait(delay, signal);
      }
      throw new Error('分页次数超出上限，已停止。');
    }
    const H_BOARD = 'www/[username]/[slug].js', H_SECTION = 'www/[username]/[slug]/[section_slug].js', H_PIN = 'www/pin/[id].js';
    return {
      get, paginate,
      board: (u, slug, signal) => get('Board', { username: u, slug, field_set_key: 'detailed' }, `/${u}/${slug}/`, H_BOARD, signal).then(j => j.resource_response.data),
      sectionBySlug: (u, slug, sectionSlug, signal) => get('BoardSection', { username: u, board_slug: slug, section_slug: sectionSlug }, `/${u}/${slug}/${sectionSlug}/`, H_SECTION, signal).then(j => j.resource_response.data),
      sections: (board, signal) => paginate('BoardSections', { board_id: board.id }, board.url, H_BOARD, { signal, delay: 200 }),
      boardPins: (board, opts) => paginate('BoardFeed', { board_id: board.id, board_url: board.url, currentFilter: -1, field_set_key: 'react_grid_pin', filter_section_pins: true, sort: 'default', layout: 'default', page_size: 100, redux_normalize_feed: true }, board.url, H_BOARD, opts),
      sectionPins: (board, section, opts) => paginate('BoardSectionPins', { section_id: section.id, page_size: 25 }, `${board.url}${section.slug}/`, H_SECTION, opts),
      pin: (id, signal) => get('Pin', { id, field_set_key: 'detailed' }, `/pin/${id}/`, H_PIN, signal).then(j => j.resource_response.data)
    };
  }

  // 把 pin 展开成下载条目（每张图/每个视频一条）。
  function buildItems(groups, { board, videos = true } = {}) {
    const items = [], skipped = [], seen = new Set();
    let seq = 0;
    for (const g of groups) {
      let sectionSeq = 0;
      for (const pin of g.pins) {
        if (!pin || pin.type !== 'pin' || !pin.id || seen.has(String(pin.id))) continue;
        seen.add(String(pin.id)); seq++; sectionSeq++;
        const { media, skipped: sk } = extractMedia(pin, { videos });
        const base = {
          pinId: String(pin.id), pinUrl: `https://www.pinterest.com/pin/${pin.id}/`,
          link: typeof pin.link === 'string' ? pin.link : '', domain: pin.domain || pin.link_domain?.official_name || '',
          title: String(pin.title || pin.grid_title || '').trim(), description: String(pin.description || '').trim(),
          board: board?.name || '', section: g.title, sectionKey: g.key, seq, sectionSeq,
          date: fmtDate(pin.created_at), thumb: allowedMediaUrl(pin.images?.['236x']?.url) || allowedMediaUrl(pin.images?.['474x']?.url) || ''
        };
        for (const s of sk) skipped.push({ ...base, reason: s.reason });
        for (const m of media) {
          const first = m.candidates[0]?.url || '';
          items.push({ ...base, key: `${base.pinId}#${m.part}`, kind: m.kind, candidates: m.candidates, page: m.page, pages: m.pages,
            thumb: m.thumb || base.thumb, width: m.width, height: m.height, originalName: new URL(first).pathname.split('/').pop() });
        }
      }
    }
    return { items, skipped, pinCount: seq };
  }

  // 按候选地址依次下载：403/404 换下一个；429/5xx/网络错误限次重试；降级地址需显式允许。
  function requestOnce(url, signal, request) {
    return new Promise((resolve, reject) => {
      if (!allowedMediaUrl(url)) { reject(new Error('地址不在 Pinterest 图片服务器白名单内。')); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      let handle, done = false;
      const finish = (err, val) => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); err ? reject(err) : resolve(val); };
      const onAbort = () => { finish(signal.reason || new DOMException('任务已停止', 'AbortError')); handle?.abort?.(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        handle = request({
          method: 'GET', url, responseType: 'arraybuffer', timeout: 120000, anonymous: true,
          onprogress: e => { if (e.loaded > MAX_FILE_BYTES || e.total > MAX_FILE_BYTES) { finish(new Error('文件超过 128 MiB，请导出链接单独下载。')); handle?.abort?.(); } },
          onload: res => {
            try {
              if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryMs: retryAfterMs(res.responseHeaders) });
              if (res.finalUrl && !allowedMediaUrl(res.finalUrl)) throw new Error('被重定向到非 Pinterest 地址，已拒绝。');
              if (!res.response || typeof res.response.byteLength !== 'number') throw new Error('未收到二进制文件。');
              if (res.response.byteLength > MAX_FILE_BYTES) throw new Error('文件超过 128 MiB，请导出链接单独下载。');
              const data = new Uint8Array(res.response || new ArrayBuffer(0));
              finish(null, { data, ext: detectType(data) });
            } catch (e) { finish(e); }
          },
          onerror: () => finish(Object.assign(new Error('网络错误'), { transient: true })),
          ontimeout: () => finish(Object.assign(new Error('下载超时'), { transient: true })),
          onabort: () => finish(signal?.reason || new DOMException('请求已取消', 'AbortError'))
        });
      } catch (e) { finish(e); }
    });
  }
  async function downloadMedia(item, { signal, request, allowFallback = false, wait = sleep, notify = () => {} }) {
    let lastErr = null;
    for (const cand of item.candidates) {
      if (cand.fallback && !allowFallback) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        aborted(signal);
        try {
          const r = await requestOnce(cand.url, signal, request);
          if (item.kind === 'video' && !['mp4', 'mov'].includes(r.ext)) throw new Error('响应不是视频文件，未以封面图代替。');
          if (item.kind === 'image' && ['mp4', 'mov'].includes(r.ext)) throw new Error('响应不是图片文件。');
          return { ...r, url: cand.url, note: cand.note || '', width: cand.width || null, height: cand.height || null };
        } catch (e) {
          aborted(signal); lastErr = e;
          if (e.status === 403 || e.status === 404 || /不是图片或视频/.test(e.message)) break;
          if (!(e.transient || e.status === 429 || e.status >= 500) || attempt === 2) throw e;
          const ms = Math.max(e.retryMs || 0, e.status === 429 ? 15000 : 1000 * 2 ** attempt);
          notify(`请求受限或失败，${Math.ceil(ms / 1000)} 秒后重试…`);
          await wait(ms, signal);
        }
      }
    }
    throw new Error(`${lastErr?.message || '没有可用的原图地址'}${!allowFallback && item.candidates.some(c => c.fallback) ? '（原图不可用；可在设置里开启较小版本）' : ''}`);
  }


  // ---- 预览页（用浏览器打印另存 PDF） ----
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeHref = u => /^https:\/\//i.test(String(u || '')) ? escapeHtml(u) : '';
  function previewHtml(boardName, items) {
    const groups = new Map(), seen = new Set();
    for (const it of items) {
      if (seen.has(it.pinId)) continue;
      seen.add(it.pinId);
      if (!groups.has(it.section)) groups.set(it.section, []);
      groups.get(it.section).push(it);
    }
    const body = [...groups].map(([section, list]) => `<h2>${escapeHtml(section)} <small>${list.length} 个 pin</small></h2><div class="g">${
      list.map(it => `<figure><a rel="noopener noreferrer" href="${safeHref(it.pinUrl)}"><img loading="eager" referrerpolicy="no-referrer" src="${safeHref(allowedMediaUrl(it.thumb) || '')}" alt=""></a><figcaption>${escapeHtml(it.title || String(it.description || '').slice(0, 40) || it.pinId)}${it.link ? `<br><a rel="noopener noreferrer" href="${safeHref(it.link)}">${escapeHtml(it.domain || '来源')}</a>` : ''}</figcaption></figure>`).join('')
    }</div>`).join('');
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://*.pinimg.com; style-src 'unsafe-inline'"><title>${escapeHtml(boardName)} - Pinterest 画板预览</title><style>
body{font:13px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#111}h1{margin:0 0 4px}h2{margin:28px 0 10px;font-size:16px;break-after:avoid}small{color:#777;font-weight:normal}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}figure{margin:0;break-inside:avoid}img{width:100%;border-radius:6px;background:#eee;display:block}
figcaption{font-size:11px;color:#444;margin-top:4px;word-break:break-all}a{color:#2563eb;text-decoration:none}.tip{color:#777}@media print{.tip{display:none}}</style></head><body>
<h1>${escapeHtml(boardName)}</h1><p class="tip">按 ⌘P（Windows：Ctrl+P），目标选「另存为 PDF」即可保存。等图片加载完再打印。</p>${body}</body></html>`;
  }

  const core = { safeName, allowedMediaUrl, detectType, crc32, makeZip, extractMedia, derivedCandidates, renderTemplate, makeNamer,
    NAME_FIELDS, DEFAULT_FOLDER, DEFAULT_FILE, csvCell, toCsv, parseRoute, isEndBookmark, makeApi, buildItems, requestOnce,
    downloadMedia, escapeHtml, previewHtml };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') { module.exports = core; return; }
  if (window.top !== window.self || document.getElementById('pin-board-downloader')) return;

  // ================= 界面 =================
  const SETTINGS_KEY = 'pbd-settings-v1', HISTORY_KEY = 'pbd-history-v1';
  const PRESETS = [
    { label: '按分区分文件夹（推荐）', folder: DEFAULT_FOLDER, file: DEFAULT_FILE },
    { label: '全部平铺', folder: '', file: '{分区}_{序号}_{标题}_{页码}' },
    { label: '保留原文件名', folder: '{分区}', file: '{原文件名}' },
    { label: '标题_来源网站', folder: '{分区}', file: '{序号}_{标题}_{来源网站}_{页码}' }
  ];
  const DEFAULTS = { autoSave: true, size: 50, videos: true, onlyNew: true, allowFallback: false, hover: true, folderTpl: DEFAULT_FOLDER, fileTpl: DEFAULT_FILE };
  const gmGet = (k, d) => { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d; } catch { return d; } };
  const gmSet = (k, v) => { try { if (typeof GM_setValue === 'function') Promise.resolve(GM_setValue(k, v)).catch(() => {}); } catch { /* 忽略 */ } };
  const stored = gmGet(SETTINGS_KEY, {}) || {};
  const prefs = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof stored[k] === typeof DEFAULTS[k]) prefs[k] = stored[k];
  if (![25, 50, 100].includes(prefs.size)) prefs.size = 50;
  let history = gmGet(HISTORY_KEY, {}) || {};
  if (typeof history !== 'object' || Array.isArray(history)) history = {};

  const host = document.createElement('div');
  host.id = 'pin-board-downloader';
  host.style.cssText = 'all:initial;position:fixed;inset:auto 20px 20px auto;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host{font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:#111;color-scheme:light}
      [hidden]{display:none!important}*{box-sizing:border-box}
      button,select,input{font:inherit;color:#111}
      button{cursor:pointer;border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:5px 10px}
      button:hover:not(:disabled){background:#f4f4f5}button:disabled{opacity:.45;cursor:not-allowed}
      :is(button,select,input):focus-visible{outline:2px solid #e60023;outline-offset:2px}
      .primary{background:#e60023;color:#fff;border-color:#e60023}.primary:hover:not(:disabled){background:#ad081b}
      input[type=text],select{border:1px solid #d4d4d8;border-radius:8px;padding:5px 8px;background:#fff;width:100%}
      input[type=checkbox]{accent-color:#e60023;width:15px;height:15px;margin:0;flex:none}
      label{cursor:pointer}.muted{color:#71717a;font-size:12px}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      #toggle{float:right;border-radius:24px;padding:9px 16px;background:#e60023;color:#fff;border:0;box-shadow:0 4px 18px #0003;font-weight:600}
      #panel{clear:both;width:min(400px,calc(100vw - 40px));max-height:min(82vh,760px);overflow:auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:14px;box-shadow:0 10px 40px #0003;margin-bottom:10px;display:grid;gap:10px}
      h3{margin:0;font-size:15px}h4{margin:0;font-size:12px;color:#52525b}
      #sections{display:grid;gap:4px;max-height:200px;overflow:auto;border:1px solid #f0f0f0;border-radius:8px;padding:6px}
      #sections label{display:flex;gap:8px;align-items:center;padding:3px 4px;border-radius:6px}#sections label:hover{background:#fafafa}
      #sections .n{margin-left:auto;color:#71717a;font-size:12px}
      details{border-top:1px solid #f0f0f0;padding-top:8px}summary{cursor:pointer;font-weight:600;font-size:12px}
      .opts{display:grid;gap:6px;margin-top:8px}.opts label.c{display:flex;gap:6px;align-items:center}
      .chips{display:flex;flex-wrap:wrap;gap:4px}.chips button{padding:1px 7px;font-size:11px;border-radius:99px}
      #name-preview{font:11px/1.5 ui-monospace,Menlo,monospace;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px;white-space:pre-wrap;word-break:break-all;margin:0}
      #status{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-height:120px;overflow:auto}
      progress{width:100%;accent-color:#e60023;height:8px}#save{width:100%;background:#166534;color:#fff;border-color:#166534}
      #hoverbtn{position:fixed;z-index:2147483647;border-radius:20px;padding:4px 10px;background:#000c;color:#fff;border:0;font-size:12px;font-weight:600}
      #hoverbtn:hover:not(:disabled){background:#e60023}
      #picker{border:0;border-radius:14px;padding:0;width:min(1100px,96vw);height:min(840px,92vh);box-shadow:0 20px 80px #0005;color:#111;background:#fff}
      #picker[open]{display:flex;flex-direction:column}#picker::backdrop{background:#0008}
      .ph,.pf{padding:12px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ph{border-bottom:1px solid #eee}.pf{border-top:1px solid #eee;justify-content:space-between}
      #grid{flex:1;overflow:auto;padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;align-content:start}
      .tile{position:relative;border:2px solid transparent;border-radius:10px;overflow:hidden;background:#f4f4f5}.tile.on{border-color:#e60023}
      .tile img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}.tile input{position:absolute;top:6px;left:6px}
      .tile .b{position:absolute;bottom:4px;right:4px;font-size:10px;color:#fff;background:#000a;border-radius:4px;padding:0 4px}
      .tile .d{position:absolute;bottom:4px;left:4px;font-size:10px;color:#fff;background:#166534;border-radius:4px;padding:0 4px}
    </style>
    <button id="hoverbtn" hidden type="button">⬇ 下载</button>
    <section id="panel" hidden aria-label="Pinterest 画板下载">
      <div class="row" style="justify-content:space-between"><h3 id="board-title">画板下载</h3><button id="close" aria-label="收起面板">✕</button></div>
      <p id="board-meta" class="muted" style="margin:0"></p>
      <div><div class="row" style="justify-content:space-between;margin-bottom:4px"><h4>要下载的分区</h4><span class="row"><button id="sec-all">全选</button><button id="sec-none">清空</button></span></div><div id="sections" role="group" aria-label="分区"></div></div>
      <div class="opts">
        <label class="c"><input id="only-new" type="checkbox"> 只下新增（跳过已确认保存的文件）</label>
        <label class="c"><input id="videos" type="checkbox"> 包含视频（mp4）</label>
      </div>
      <details><summary>命名方式</summary><div class="opts">
        <label>预设<select id="preset"></select></label>
        <label>文件夹名（留空则不分文件夹）<input id="folder-tpl" type="text" spellcheck="false"></label>
        <label>文件名<input id="file-tpl" type="text" spellcheck="false"></label>
        <div class="chips" id="chips"></div>
        <pre id="name-preview"></pre>
      </div></details>
      <details><summary>更多设置</summary><div class="opts">
        <label class="c"><input id="auto" type="checkbox"> 自动保存 ZIP（不必每包确认）</label>
        <label>每包最多<select id="size"><option value="25">25 个文件</option><option value="50">50 个文件</option><option value="100">100 个文件</option></select></label>
        <label class="c"><input id="fallback" type="checkbox"> 原图失败时用较小版本代替（会在清单里注明）</label>
        <label class="c"><input id="hover" type="checkbox"> 鼠标悬停 pin 时显示下载按钮</label>
        <button id="clear-history">清除本画板的下载记录</button>
      </div></details>
      <progress id="progress" value="0" max="1"></progress>
      <p id="summary" class="muted" style="margin:0"></p>
      <p id="status" role="status" aria-live="polite"></p>
      <button id="save" hidden>保存 ZIP</button>
      <button id="confirm-saved" hidden>确认这些 ZIP 已保存</button>
      <p class="muted" style="margin:0">自动保存请允许浏览器下载多个文件。核对下载列表后点「确认已保存」，才会写入下载记录。刷新页面不能续传。</p>
      <div class="row"><button id="start" class="primary">开始下载</button><button id="pick">挑选单张</button><button id="stop" disabled>停止</button><button id="resume" disabled>继续剩余</button><button id="retry" disabled>重试失败</button></div>
      <div class="row"><button id="refresh">重新读取</button><button id="resave" disabled>重存最近一包</button><button id="links" disabled>导出链接</button><button id="preview" disabled>生成预览页</button><button id="report" disabled>导出报告</button></div>
    </section>
    <button id="toggle" hidden aria-expanded="false">⬇ 下载画板</button>
    <dialog id="picker" aria-label="挑选单张">
      <div class="ph"><strong>挑选要下载的 pin</strong><span id="pick-count" class="muted"></span><span style="flex:1"></span>
        <button id="pick-all">全选</button><button id="pick-none">清空</button><button id="pick-new">只选未下载</button></div>
      <div id="grid"></div>
      <div class="pf"><span class="row"><button id="pick-prev">上一页</button><span id="pick-page" class="muted"></span><button id="pick-next">下一页</button></span>
        <span class="row"><button id="pick-clear">不挑选（下载全部）</button><button id="pick-ok" class="primary">用这些开始下载</button></span></div>
    </dialog>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);


  const pws = () => { try { return JSON.parse(document.getElementById('__PWS_DATA__')?.textContent || '{}'); } catch { return {}; } };
  const csrfToken = () => (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
  const api = () => makeApi(window.fetch.bind(window), { csrf: csrfToken(), appVersion: pws().appVersion || '' });
  const routeKey = () => location.pathname;
  const state = { route: null, routeKey: '', board: null, groups: [], items: [], skipped: [], picked: null, pickPage: 0,
    task: [], remaining: [], done: new Set(), failed: new Map(), busy: false, controller: null, ready: null, lastSaved: null,
    part: 0, saves: 0, namer: null, fallbackUsed: [], loadedFor: '', options: null, offered: new Map() };
  const status = t => { $('status').textContent = t; };
  const boardHistory = () => (state.board && history[state.board.id]) || {};
  const isDone = it => !!boardHistory()[it.key];
  const selectionKey = () => selectedGroups().map(g => g.key).join(',') + '|' + prefs.videos;
  const scopeIsFresh = () => state.routeKey === routeKey() && state.loadedFor === selectionKey();
  const selectedItems = () => state.picked ? state.items.filter(it => state.picked.has(it.key)) : state.items;
  const pendingSaved = () => [...state.offered.values()].filter(r => r.boardId === state.board?.id);
  function ensureRoute() { if (state.routeKey !== routeKey()) throw new DOMException('页面已切换，请先保存待保存的 ZIP，再点「重新读取」。', 'AbortError'); }

  $('only-new').checked = prefs.onlyNew; $('videos').checked = prefs.videos; $('auto').checked = prefs.autoSave;
  $('size').value = String(prefs.size); $('fallback').checked = prefs.allowFallback; $('hover').checked = prefs.hover;
  $('folder-tpl').value = prefs.folderTpl; $('file-tpl').value = prefs.fileTpl;
  PRESETS.forEach((p, i) => $('preset').add(new Option(p.label, String(i)))); $('preset').add(new Option('自定义', 'custom'));
  let lastInput = null;
  for (const k of Object.keys(NAME_FIELDS)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = k;
    b.onclick = () => {
      const input = lastInput || $('file-tpl'); const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
      const before = input.value.slice(0, s), sep = before && !/[_\-\s/]$/.test(before) ? '_' : '';
      input.value = before + sep + `{${k}}` + input.value.slice(e);
      const pos = (before + sep + `{${k}}`).length; input.focus(); input.setSelectionRange(pos, pos); onNaming();
    };
    $('chips').appendChild(b);
  }
  function saveSettings() {
    Object.assign(prefs, { onlyNew: $('only-new').checked, videos: $('videos').checked, autoSave: $('auto').checked,
      size: Number($('size').value), allowFallback: $('fallback').checked, hover: $('hover').checked,
      folderTpl: $('folder-tpl').value.slice(0, 200), fileTpl: $('file-tpl').value.slice(0, 200) });
    gmSet(SETTINGS_KEY, prefs);
  }
  function syncPreset() {
    const i = PRESETS.findIndex(p => p.folder === $('folder-tpl').value && p.file === $('file-tpl').value);
    $('preset').value = i >= 0 ? String(i) : 'custom';
  }
  function renderNamePreview() {
    const namer = makeNamer($('folder-tpl').value, $('file-tpl').value);
    const sample = state.items.length ? state.items.slice(0, 3) : [{ board: state.board?.name || '画板', section: '未分区', seq: 1, sectionSeq: 1,
      title: '示例标题', description: '', domain: 'instagram.com', pinId: '1234567890', date: '2026-11-09', width: 1080, height: 1350,
      originalName: '088f9530b1c7fc63.jpg', page: 1, pages: 1 }];
    $('name-preview').textContent = sample.map(it => namer(it, 'jpg')).join('\n');
  }
  function onNaming() { syncPreset(); saveSettings(); renderNamePreview(); }
  $('folder-tpl').onfocus = $('file-tpl').onfocus = e => { lastInput = e.target; };
  $('folder-tpl').oninput = $('file-tpl').oninput = onNaming;
  $('preset').onchange = () => { const p = PRESETS[Number($('preset').value)]; if (p) { $('folder-tpl').value = p.folder; $('file-tpl').value = p.file; } saveSettings(); renderNamePreview(); };
  for (const id of ['only-new', 'videos', 'auto', 'size', 'fallback', 'hover']) $(id).onchange = () => { saveSettings(); if (id === 'videos') { state.loadedFor = ''; state.picked = null; } if (id === 'hover' && !prefs.hover) hideHover(); render(); };
  syncPreset();

  function selectedGroups() { return state.groups.filter(g => g.checked); }
  function render() {
    const locked = state.busy || !!state.ready || hoverBusy;
    const stale = state.routeKey !== routeKey();
    for (const id of ['start', 'pick']) $(id).disabled = locked || stale || !state.board || !selectedGroups().length;
    $('refresh').disabled = locked || !routeIsBoard();
    $('stop').disabled = !state.busy && !hoverBusy;
    $('resume').disabled = locked || stale || !state.remaining.length || !state.task.length;
    $('retry').disabled = locked || stale || !state.failed.size;
    $('resave').disabled = state.busy || !state.lastSaved;
    $('links').disabled = $('preview').disabled = locked || !scopeIsFresh() || !selectedItems().length;
    $('report').disabled = state.busy || !state.board;
    $('confirm-saved').hidden = !pendingSaved().length;
    $('confirm-saved').disabled = locked;
    $('confirm-saved').textContent = `确认已保存（${pendingSaved().length} 个文件）`;
    $('save').hidden = !state.ready;
    for (const id of ['only-new', 'videos', 'auto', 'size', 'fallback', 'preset', 'folder-tpl', 'file-tpl', 'sec-all', 'sec-none']) $(id).disabled = locked;
    shadow.querySelectorAll('#sections input').forEach(i => { i.disabled = locked; });
    shadow.querySelectorAll('#chips button').forEach(b => { b.disabled = locked; });
    $('progress').max = Math.max(1, state.task.length); $('progress').value = state.done.size;
    $('summary').textContent = state.task.length
      ? `本次 ${state.task.length} 个文件：已获取 ${state.done.size}，失败 ${state.failed.size}，待处理 ${state.remaining.length}，已发起 ${state.saves} 包保存`
      : state.picked ? `已挑选 ${state.picked.size} 个文件` : '';
  }
  function renderSections() {
    const box = $('sections'); box.replaceChildren();
    for (const g of state.groups) {
      const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = g.checked;
      c.onchange = () => { g.checked = c.checked; state.loadedFor = ''; state.picked = null; render(); };
      const t = document.createElement('span'); t.textContent = g.title;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = g.count != null ? `${g.count} 个 pin` : '';
      l.append(c, t, n); box.appendChild(l);
    }
  }


  // ---- 读取画板 ----
  async function openBoard() {
    const route = parseRoute(location.pathname);
    if (!route || route.type === 'pin' || state.busy || state.ready || hoverBusy) return;
    state.busy = true; state.controller = new AbortController(); const signal = state.controller.signal;
    Object.assign(state, { route, routeKey: routeKey(), board: null, groups: [], items: [], skipped: [], picked: null, task: [], remaining: [], loadedFor: '' });
    state.done.clear(); state.failed.clear();
    $('board-title').textContent = '读取画板…'; $('board-meta').textContent = ''; renderSections(); render();
    status('正在读取画板信息…');
    try {
      const a = api();
      const board = await a.board(route.username, route.slug, signal);
      aborted(signal); ensureRoute();
      if (!board?.id) throw new Error('没有读到画板信息。');
      state.board = { id: String(board.id), name: board.name || route.slug, url: board.url || `/${route.username}/${route.slug}/`,
        pinCount: board.pin_count, sectionCount: board.section_count || 0, owner: board.owner?.username || route.username };
      let sections = [];
      if (route.type === 'section') {
        const s = await a.sectionBySlug(route.username, route.slug, route.sectionSlug, signal);
        if (!s?.id) throw new Error('没有读到这个分区。');
        sections = [s];
      } else if (state.board.sectionCount > 0) sections = await a.sections(state.board, signal);
      aborted(signal); ensureRoute();
      const secTotal = sections.reduce((n, s) => n + (s.pin_count || 0), 0);
      state.groups = [];
      if (route.type === 'board') state.groups.push({ key: 'main', title: sections.length ? '未分区' : state.board.name, count: sections.length ? Math.max(0, (state.board.pinCount || 0) - secTotal) : state.board.pinCount, checked: true });
      for (const s of sections) state.groups.push({ key: 's:' + s.id, id: String(s.id), slug: s.slug, title: s.title || s.slug, count: s.pin_count, checked: true });
      $('board-title').textContent = state.board.name;
      const owned = state.board.owner && state.board.owner === (pws().context?.user?.username || '');
      $('board-meta').textContent = `${state.board.pinCount ?? '?'} 个 pin · ${sections.length} 个分区 · ${owned ? '我的画板' : '作者：' + state.board.owner}`;
      const prev = Object.keys(boardHistory()).length;
      status(prev ? `此画板有 ${prev} 个文件已确认保存。「只下新增」会跳过它们。` : '选好分区后点「开始下载」。');
      renderSections(); renderNamePreview();
    } catch (e) {
      state.board = null; state.groups = []; state.loadedFor = ''; renderSections();
      status(e.name === 'AbortError' ? '已取消读取。' : e.message);
      $('board-title').textContent = '画板下载';
    } finally { state.busy = false; state.controller = null; render(); }
  }

  async function loadPins(signal) {
    ensureRoute(); aborted(signal);
    const key = selectionKey();
    if (state.loadedFor === key) return;
    const a = api(), groups = [];
    for (const g of selectedGroups()) {
      const onPage = n => status(`正在读取「${g.title}」：已读到 ${n} 个 pin…`);
      const pins = g.key === 'main' ? await a.boardPins(state.board, { signal, onPage }) : await a.sectionPins(state.board, g, { signal, onPage });
      groups.push({ key: g.key, title: g.title, pins });
    }
    aborted(signal); ensureRoute();
    const built = buildItems(groups, { board: state.board, videos: prefs.videos });
    state.items = built.items; state.skipped = built.skipped; state.loadedFor = key;
    const expected = selectedGroups().reduce((n, g) => n + (Number(g.count) || 0), 0);
    if (expected && expected !== built.pinCount) state.skipped.push({ reason: `页面标注约 ${expected} 个 pin，接口实际返回 ${built.pinCount} 个；可能有已删除、隐藏或变化的条目。` });
    status(`读取到分页结束：${built.pinCount} 个 pin，共 ${built.items.length} 个文件${state.skipped.length ? `；${state.skipped.length} 条跳过/数量提示可查看报告` : ''}。`);
    renderNamePreview();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.documentElement.appendChild(a);
    try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }
  function offerSaved(records) {
    for (const record of records) state.offered.set(`${state.board.id}|${record.key}`, { boardId: state.board.id, key: record.key });
  }
  function markConfirmed() {
    if (!state.board || !pendingSaved().length) return;
    if (!confirm('请先核对浏览器下载列表，确认本次所有已发起保存的 ZIP 都已落盘。确认后，这些文件才会被“只下新增”跳过。')) return;
    const map = { ...boardHistory() }, now = Date.now();
    for (const r of pendingSaved()) { map[r.key] = now; state.offered.delete(`${r.boardId}|${r.key}`); }
    history = { ...history, [state.board.id]: map }; gmSet(HISTORY_KEY, history);
    status('已记录你确认保存的文件；下次“只下新增”会跳过它们。'); render();
  }
  function report(failures) {
    return JSON.stringify({ version: VERSION, board: state.board?.name, boardUrl: 'https://www.pinterest.com' + (state.board?.url || ''),
      createdAt: new Date().toISOString(), files: state.task.length, naming: { folder: state.options?.folderTpl || prefs.folderTpl, file: state.options?.fileTpl || prefs.fileTpl },
      failed: failures, skipped: state.skipped.map(s => ({ pinId: s.pinId, pinUrl: s.pinUrl, reason: s.reason })),
      fallbackUsed: state.fallbackUsed, note: '保存次数只代表已发起下载，请核对浏览器下载列表。' }, null, 2);
  }


  // ---- 打包与下载（同时 3 个） ----
  function zipName(part) {
    const sec = state.route?.type === 'section' ? '_' + (state.groups[0]?.title || '') : '';
    return `${safeName(state.board.name + sec, 80)}_part-${String(part).padStart(3, '0')}.zip`;
  }
  function stagePart(files, records, failures, signal) {
    const part = ++state.part;
    const blob = makeZip([...files, { name: '清单.csv', data: toCsv(records) }, { name: '下载报告.json', data: report(failures) }]);
    const packet = { blob, filename: zipName(part), records };
    if (prefs.autoSave && signal && !signal.aborted) {
      try {
        saveBlob(blob, packet.filename); state.lastSaved = packet; state.saves++; offerSaved(records);
        status(`已发起第 ${part} 包保存，继续下载…（Chrome 提示多个下载时请点允许）`); render();
        return Promise.resolve();
      } catch (e) { $('auto').checked = false; saveSettings(); status(`自动保存失败：${e.message}，已切换为手动保存。`); }
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => { if (state.ready) state.ready.resume = null; reject(signal.reason); };
      state.ready = { ...packet, resume: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
      if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
      else { state.ready.resume = null; resolve(); }
      $('save').textContent = `保存第 ${part} 包（${files.length} 个文件，${(blob.size / 1048576).toFixed(1)} MiB）`;
      render();
    });
  }

  async function runTask() {
    if (state.busy || state.ready || !state.remaining.length) return;
    try { ensureRoute(); } catch (e) { status(e.message); return; }
    if (typeof GM_xmlhttpRequest !== 'function') { status('缺少脚本猫下载权限，请以用户脚本方式安装。'); return; }
    state.busy = true; state.controller = new AbortController();
    const signal = state.controller.signal, max = state.options?.size || prefs.size;
    let files = [], records = [], bytes = 0, failures = [];
    const flush = async () => { const f = files, r = records, x = failures; files = []; records = []; bytes = 0; failures = []; await stagePart(f, r, x, signal); aborted(signal); };
    render();
    try {
      while (state.remaining.length) {
        aborted(signal);
        if (routeKey() !== state.routeKey) throw new DOMException('页面已切换，任务已停止。', 'AbortError');
        const batch = state.remaining.slice(0, 3);
        status(`正在下载 ${state.done.size + 1}–${state.done.size + batch.length} / ${state.task.length}：${batch[0].title || batch[0].pinId}`);
        const results = await Promise.allSettled(batch.map(it => downloadMedia(it, { signal, request: GM_xmlhttpRequest, allowFallback: state.options?.allowFallback ?? prefs.allowFallback, notify: status })));
        aborted(signal);
        for (let i = 0; i < batch.length; i++) {
          const it = batch[i], r = results[i];
          if (r.status === 'rejected') {
            if (r.reason?.name === 'AbortError') throw r.reason;
            state.failed.set(it.key, { item: it, error: r.reason.message }); failures.push({ pinId: it.pinId, pinUrl: it.pinUrl, page: it.page, error: r.reason.message });
            state.remaining.shift();
            continue;
          }
          if (files.length && bytes + r.value.data.length > PART_BYTES) await flush();
          aborted(signal); ensureRoute();
          const record = { ...it, width: r.value.width, height: r.value.height };
          const path = state.namer(record, r.value.ext);
          files.push({ name: path, data: r.value.data }); bytes += r.value.data.length;
          records.push({ ...record, file: path, actualUrl: r.value.url, note: r.value.note });
          state.remaining.shift();
          if (r.value.note) state.fallbackUsed.push({ pinId: it.pinId, page: it.page, note: r.value.note });
          state.done.add(it.key); state.failed.delete(it.key);
          if (files.length >= max || bytes >= PART_BYTES) await flush();
        }
        render();
        await sleep(200, signal);
      }
      if (files.length || failures.length) await flush();
      status(`完成：获取 ${state.done.size}/${state.task.length} 个文件，失败 ${state.failed.size} 个。已发起 ${state.saves} 包保存。核对下载列表后点「确认已保存」以便下次只下新增。`);
    } catch (e) {
      if (files.length || failures.length) await stagePart(files, records, failures, null);
      status(`${e.message}${state.ready ? '\n已获取的部分可点绿色按钮保存，之后可「继续剩余」。' : ''}`);
    } finally { state.busy = false; state.controller = null; render(); }
  }

  async function startDownload() {
    if (state.busy || state.ready || !state.board) return;
    try { ensureRoute(); } catch (e) { status(e.message); return; }
    if (state.remaining.length && state.task.length && !confirm('之前的任务还有未完成文件。重新开始会替换剩余队列；仅想继续请点“继续剩余”。确定重新开始吗？')) return;
    if (state.task.length) state.loadedFor = '';
    state.busy = true; state.controller = new AbortController(); render();
    try { await loadPins(state.controller.signal); }
    catch (e) { status(e.name === 'AbortError' ? '已停止读取。' : e.message); state.busy = false; state.controller = null; render(); return; }
    state.busy = false; state.controller = null;
    let list = state.picked ? state.items.filter(it => state.picked.has(it.key)) : state.items;
    const before = list.length;
    if (prefs.onlyNew && !state.picked) list = list.filter(it => !isDone(it));
    if (!list.length) { status(before ? `所选文件均已确认保存（${before} 个）。要重新下载，请取消「只下新增」或手动挑选。` : '没有可下载的文件；可点「导出报告」查看跳过原因。'); render(); return; }
    saveSettings();
    state.namer = makeNamer(prefs.folderTpl, prefs.fileTpl);
    Object.assign(state, { task: list, remaining: [...list], saves: 0, fallbackUsed: [], options: { ...prefs } });
    state.done.clear(); state.failed.clear();
    if (before > list.length) status(`跳过以前下载过的 ${before - list.length} 个，开始下载新增的 ${list.length} 个…`);
    await runTask();
  }

  // ---- 挑选单张 ----
  const PICK_PAGE = 60;
  function renderPicker() {
    const list = state.items, pages = Math.max(1, Math.ceil(list.length / PICK_PAGE));
    state.pickPage = Math.min(state.pickPage, pages - 1);
    const grid = $('grid'); grid.replaceChildren();
    for (const it of list.slice(state.pickPage * PICK_PAGE, (state.pickPage + 1) * PICK_PAGE)) {
      const t = document.createElement('label'); t.className = 'tile' + (state.picked.has(it.key) ? ' on' : '');
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = state.picked.has(it.key);
      c.onchange = () => { c.checked ? state.picked.add(it.key) : state.picked.delete(it.key); t.classList.toggle('on', c.checked); countPicked(); };
      const img = document.createElement('img'); img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.alt = it.title || '';
      img.src = it.thumb || it.candidates.find(x => x.fallback)?.url || '';
      t.append(c, img);
      if (it.pages > 1 || it.kind === 'video') { const b = document.createElement('span'); b.className = 'b'; b.textContent = it.kind === 'video' ? '视频' : `${it.page}/${it.pages}`; t.appendChild(b); }
      if (isDone(it)) { const d = document.createElement('span'); d.className = 'd'; d.textContent = '已下载'; t.appendChild(d); }
      grid.appendChild(t);
    }
    $('pick-page').textContent = `第 ${state.pickPage + 1}/${pages} 页`;
    $('pick-prev').disabled = state.pickPage === 0; $('pick-next').disabled = state.pickPage >= pages - 1;
    grid.scrollTop = 0; countPicked();
  }
  function countPicked() { $('pick-count').textContent = `已选 ${state.picked.size} / ${state.items.length} 个文件`; $('pick-ok').disabled = !state.picked.size; }
  async function openPicker() {
    if (state.busy || state.ready || !state.board) return;
    try { ensureRoute(); } catch (e) { status(e.message); return; }
    state.busy = true; state.controller = new AbortController(); render();
    try { await loadPins(state.controller.signal); }
    catch (e) { status(e.name === 'AbortError' ? '已停止读取。' : e.message); return; }
    finally { state.busy = false; state.controller = null; render(); }
    if (!state.items.length) { status('没有可挑选的文件。'); return; }
    if (!state.picked) state.picked = new Set(state.items.filter(it => !(prefs.onlyNew && isDone(it))).map(it => it.key));
    state.pickPage = 0; renderPicker(); $('picker').showModal();
  }


  // ---- 悬停单个 pin 下载 ----
  let hoverPinId = null, hoverTimer = null, hoverBusy = false, hoverController = null;
  const hb = $('hoverbtn');
  function hideHover() { if (!hoverBusy) { hb.hidden = true; hoverPinId = null; } }
  document.addEventListener('mouseover', e => {
    if (!prefs.hover || hoverBusy || state.busy || state.ready) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host)) { clearTimeout(hoverTimer); return; }
    const card = e.target?.closest?.('[data-test-id="pin"], [data-grid-item="true"]');
    const link = card?.querySelector('a[href*="/pin/"]');
    const id = /\/pin\/(\d+)/.exec(link?.getAttribute('href') || '')?.[1];
    if (!id) { clearTimeout(hoverTimer); hoverTimer = setTimeout(hideHover, 250); return; }
    clearTimeout(hoverTimer);
    const r = (card.querySelector('img') || card).getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return;
    hoverPinId = id;
    hb.style.top = Math.max(8, r.top + 8) + 'px';
    hb.style.left = Math.max(8, r.right - 86) + 'px';
    hb.textContent = '⬇ 下载'; hb.disabled = false; hb.hidden = false;
  }, true);
  window.addEventListener('scroll', () => hideHover(), { passive: true, capture: true });
  hb.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const id = hoverPinId; if (!id || hoverBusy || state.busy || state.ready) return;
    if (typeof GM_xmlhttpRequest !== 'function') { hb.textContent = '缺少权限'; return; }
    hoverBusy = true; hoverController = new AbortController();
    const signal = hoverController.signal;
    hb.disabled = true; hb.textContent = '下载中…';
    $('panel').hidden = false; status(`正在读取 pin ${id}…`); render();
    let files = [], rows = [], failures = [], skipped = [], bytes = 0, part = 0, count = 0;
    const emit = () => {
      if (!files.length && !failures.length && !skipped.length) return;
      const direct = count === 1 && files.length === 1 && !failures.length && !skipped.length;
      const blob = direct ? new Blob([files[0].data]) : makeZip([...files,
        { name: '清单.csv', data: toCsv(rows) }, { name: '下载报告.json', data: JSON.stringify({ pinId: id, failed: failures, skipped }, null, 2) }]);
      const filename = direct ? files[0].name : `pin_${id}_part-${String(++part).padStart(3, '0')}.zip`;
      state.lastSaved = { blob, filename, records: [] };
      files = []; rows = []; bytes = 0; failures = []; skipped = [];
      saveBlob(blob, filename);
    };
    try {
      const pin = await api().pin(id, signal); aborted(signal);
      const built = buildItems([{ key: 'pin', title: pin.board?.name || '', pins: [pin] }], { board: { name: pin.board?.name || '' }, videos: prefs.videos });
      skipped = built.skipped; count = built.items.length;
      const namer = makeNamer('', '{标题}_{PinID}_{页码}');
      for (const it of built.items) {
        aborted(signal); status(`下载单个 pin：${id}，第 ${it.page}/${it.pages} 页`);
        let r;
        try { r = await downloadMedia(it, { signal, request: GM_xmlhttpRequest, allowFallback: prefs.allowFallback, notify: status }); }
        catch (error) { aborted(signal); failures.push({ key: it.key, error: error.message }); continue; }
        if (files.length && bytes + r.data.length > PART_BYTES) emit();
        const name = namer(it, r.ext);
        files.push({ name, data: r.data }); rows.push({ ...it, file: name, note: r.note }); bytes += r.data.length;
        if (files.length >= prefs.size || bytes >= PART_BYTES) emit();
      }
      emit(); hb.textContent = '已发起保存';
      status(`单个 pin 处理结束。请核对下载列表；跳过或失败的内容见报告。悬停下载不写入画板的已保存记录。`);
    } catch (error) {
      if (files.length) { try { emit(); } catch { /* 最近一包仍可手动补存。 */ } }
      hb.textContent = error.name === 'AbortError' ? '已停止' : '✕ 失败'; hb.title = error.message;
      status(`${error.message}。已生成的最近一包可手动补存。`);
    } finally { hoverBusy = false; hoverController = null; hb.disabled = false; render(); setTimeout(hideHover, 1500); }
  };

  // ---- 事件 ----
  const routeIsBoard = () => { const r = parseRoute(location.pathname); return !!r && r.type !== 'pin'; };
  $('toggle').onclick = () => {
    const open = $('panel').hidden;
    $('panel').hidden = !open; $('toggle').setAttribute('aria-expanded', String(open));
    if (open && (!state.board || state.routeKey !== routeKey()) && !state.busy && !state.ready) openBoard();
  };
  $('close').onclick = () => { $('panel').hidden = true; $('toggle').setAttribute('aria-expanded', 'false'); };
  $('sec-all').onclick = () => { state.groups.forEach(g => { g.checked = true; }); state.loadedFor = ''; state.picked = null; renderSections(); render(); };
  $('sec-none').onclick = () => { state.groups.forEach(g => { g.checked = false; }); state.loadedFor = ''; state.picked = null; renderSections(); render(); };
  $('start').onclick = startDownload;
  $('pick').onclick = openPicker;
  $('stop').onclick = () => { const reason = new DOMException('你已停止任务。', 'AbortError'); state.controller?.abort(reason); hoverController?.abort(reason); };
  $('resume').onclick = runTask;
  $('retry').onclick = () => {
    const keys = new Set(state.remaining.map(i => i.key));
    for (const { item } of state.failed.values()) if (!keys.has(item.key)) state.remaining.push(item);
    runTask();
  };
  $('save').onclick = () => {
    const r = state.ready; if (!r) return;
    try { saveBlob(r.blob, r.filename); } catch (e) { status(`保存失败：${e.message}，可再点一次。`); return; }
    state.lastSaved = { blob: r.blob, filename: r.filename, records: r.records }; state.saves++; state.ready = null;
    offerSaved(r.records); r.resume?.(); render();
  };
  $('resave').onclick = () => { if (state.lastSaved) { saveBlob(state.lastSaved.blob, state.lastSaved.filename); status('已重新发起保存：' + state.lastSaved.filename); } };
  $('confirm-saved').onclick = markConfirmed;
  $('refresh').onclick = () => { if (!state.remaining.length || confirm('重新读取将重置剩余队列，继续吗？')) openBoard(); };
  $('report').onclick = () => saveBlob(new Blob([report([...state.failed.values()].map(f => ({ pinId: f.item.pinId, page: f.item.page, error: f.error })))], { type: 'application/json;charset=utf-8' }), `${safeName(state.board?.name || 'pinterest')}-下载报告.json`);
  $('links').onclick = () => {
    const lines = selectedItems().map(it => it.candidates.find(c => !c.fallback)?.url).filter(Boolean);
    saveBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), `${safeName(state.board?.name || 'pinterest', 60)}-原图链接.txt`);
  };
  $('preview').onclick = () => {
    const blob = new Blob([previewHtml(state.board?.name || 'Pinterest', selectedItems())], { type: 'text/html;charset=utf-8' });
    const w = window.open('about:blank', '_blank');
    if (!w) { saveBlob(blob, `${safeName(state.board?.name || 'pinterest')}-预览.html`); return; }
    const url = URL.createObjectURL(blob);
    w.opener = null; w.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  };
  $('clear-history').onclick = () => {
    if (!state.board || !confirm('清除本画板的「已下载」记录？不会删除已保存的文件。')) return;
    for (const r of pendingSaved()) state.offered.delete(`${r.boardId}|${r.key}`);
    const h = { ...history }; delete h[state.board.id]; history = h; gmSet(HISTORY_KEY, history); status('已清除本画板的下载记录。');
  };
  $('pick-all').onclick = () => { state.items.forEach(it => state.picked.add(it.key)); renderPicker(); };
  $('pick-none').onclick = () => { state.picked.clear(); renderPicker(); };
  $('pick-new').onclick = () => { state.picked = new Set(state.items.filter(it => !isDone(it)).map(it => it.key)); renderPicker(); };
  $('pick-prev').onclick = () => { state.pickPage--; renderPicker(); };
  $('pick-next').onclick = () => { state.pickPage++; renderPicker(); };
  $('pick-clear').onclick = () => { state.picked = null; $('picker').close(); render(); status('已取消挑选，将下载所选分区的全部文件。'); };
  $('pick-ok').onclick = () => { $('picker').close(); render(); startDownload(); };

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('打开画板下载面板', () => {
    if (!routeIsBoard()) { alert('请先打开一个 Pinterest 画板或分区页面。'); return; }
    if ($('panel').hidden) $('toggle').click();
  });

  let lastPath = location.pathname;
  function syncRoute() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname; hideHover();
      $('picker').close();
      state.controller?.abort(new DOMException('页面已切换，任务已停止。待保存内容仍保留；保存后请点“重新读取”。', 'AbortError'));
      hoverController?.abort();
      if (state.routeKey && state.routeKey !== routeKey() && !state.busy) status('页面已切换。待保存 ZIP 仍保留；完成保存后点「重新读取」。');
      render();
    }
    const show = routeIsBoard() || state.busy || hoverBusy || !!state.ready;
    $('toggle').hidden = !show;
    if (!show) $('panel').hidden = true;
  }
  window.addEventListener('beforeunload', e => { if (state.busy || state.ready || hoverBusy) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('popstate', syncRoute);
  setInterval(syncRoute, 800);
  syncRoute(); renderNamePreview(); render();
})();
