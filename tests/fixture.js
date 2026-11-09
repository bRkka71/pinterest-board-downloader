/* Browser test doubles. Never load this file on a real Pinterest page. */
(function () {
  'use strict';
  if (location.hostname !== '127.0.0.1') throw new Error('Fixture is localhost-only');
  if (new URLSearchParams(location.search).get('run') === '1') sessionStorage.clear();
  const mock = window.__mock = { api: [], requests: [], downloads: [], errors: [], blobs: new Map(), delay: 15, large: false,
    failIds: new Set(), mainCount: 3, saveError: false, apiStatus: 200, active: 0, maxActive: 0, aborts: 0, opens: [], popupBlocked: false, confirmAnswer: true };
  window.addEventListener('error', e => { if (e.message) mock.errors.push(e.message); });
  window.addEventListener('unhandledrejection', e => mock.errors.push(String(e.reason)));
  window.confirm = () => mock.confirmAnswer;
  window.alert = message => mock.errors.push('Unexpected alert: ' + message);
  window.GM_getValue = (key, fallback) => JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback;
  window.GM_setValue = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));
  window.GM_registerMenuCommand = (title, callback) => { mock.menu = callback; };
  const nativeFetch = window.fetch.bind(window);
  const img = (id, ext = 'jpg') => ({ url: `https://i.pinimg.com/originals/aa/bb/cc/${id}.${ext}`, width: 1080, height: 1440 });
  const pin = (id, extra = {}) => ({ type: 'pin', id: String(id), title: `灵感 ${id}`, description: `图片 ${id}`, domain: 'example.com', link: `https://example.com/reference/${id}`, board: { name: '示例画板' }, images: { orig: img(id), '736x': { ...img(id), url: img(id).url.replace('/originals/', '/736x/') }, '236x': { ...img(id), url: img(id).url.replace('/originals/', '/236x/') } }, ...extra });
  const video = pin(2002, { videos: { video_list: { V_720P: { url: 'https://v1.pinimg.com/videos/2002.mp4', width: 720, height: 1280 } } } });
  const carousel = pin(2003, { carousel_data: { carousel_slots: [ { id: 'first', images: { orig: img(20031), '236x': img(20031) } }, { id: 'second', images: { orig: img(20032), '236x': img(20032) } } ] } });
  const hls = pin(3001, { videos: { video_list: { V_HLSV4: { url: 'https://v1.pinimg.com/videos/3001.m3u8' } } } });
  const heic = pin(3002, { images: { orig: img(3002, 'heic'), '236x': img(3002) } });
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, location.href);
    if (!url.pathname.startsWith('/resource/')) return nativeFetch(input, options);
    if (options.signal?.aborted) throw options.signal.reason;
    const resource = /\/resource\/(\w+)Resource/.exec(url.pathname)[1];
    const data = JSON.parse(url.searchParams.get('data')).options;
    mock.api.push({ resource, options: data, headers: options.headers });
    if (mock.apiStatus !== 200) return new Response('{}', { status: mock.apiStatus, headers: { 'Content-Type': 'application/json' } });
    let result, bookmarks = ['-end-'];
    const board = { id: data.slug === 'other' ? '101' : '100', name: '示例画板', url: `/demo/${data.slug || 'board'}/`, owner: { username: 'demo' }, pin_count: mock.mainCount + 5, section_count: 2 };
    const sections = [{ id: '201', slug: 'style', title: '穿搭', pin_count: 3 }, { id: '301', slug: 'spaces', title: '空间', pin_count: 2 }];
    if (resource === 'Board') result = board;
    else if (resource === 'BoardSections') result = sections;
    else if (resource === 'BoardSection') result = sections.find(s => s.slug === data.section_slug);
    else if (resource === 'Pin') result = pin(data.id);
    else if (resource === 'BoardFeed') {
      const offset = Number(data.bookmarks?.[0] || 0), size = mock.pageSize || 2;
      result = Array.from({ length: mock.mainCount }, (_, i) => pin(1001 + i)).slice(offset, offset + size);
      if (offset + size < mock.mainCount) bookmarks = [String(offset + size)];
    } else if (resource === 'BoardSectionPins') result = data.section_id === '201' ? [pin(2001), video, carousel] : [hls, heic];
    else throw new Error('Unexpected API resource ' + resource);
    return new Response(JSON.stringify({ resource_response: { data: result }, resource: { options: { bookmarks } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { get: desc.get, set(value) { desc.set.call(this, '/thumb.svg'); } });
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); mock.blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { mock.blobs.delete(url); revoke(url); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      if (mock.saveError) throw new Error('模拟保存异常');
      mock.downloads.push({ name: this.download, blob: mock.blobs.get(this.href) }); return;
    }
    return click.call(this);
  };
  window.open = (...args) => {
    mock.opens.push(args); if (mock.popupBlocked) return null;
    return { opener: window, location: { replace(url) { mock.previewURL = url; } } };
  };
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  window.GM_xmlhttpRequest = options => {
    const id = /\/(\d+)\.[a-z0-9]+(?:[?#]|$)/i.exec(options.url)?.[1];
    mock.requests.push({ id, url: options.url, method: options.method, anonymous: options.anonymous });
    mock.active++; mock.maxActive = Math.max(mock.active, mock.maxActive);
    let done = false;
    const finish = callback => { if (done) return; done = true; mock.active--; callback(); };
    const timer = setTimeout(() => finish(() => {
      let data = png;
      if (options.url.endsWith('.mp4')) data = new TextEncoder().encode('0000ftypisom0000000000000000000000');
      else if (options.url.endsWith('.heic')) data = new TextEncoder().encode('0000ftypheic0000000000000000000000');
      else if (mock.large) { data = new Uint8Array(34 * 1024 * 1024); data.set(png); }
      options.onload({ status: mock.failIds.has(id) ? 404 : 200, finalUrl: options.url, response: data.buffer });
    }), mock.delay);
    return { abort() { if (!done) mock.aborts++; clearTimeout(timer); finish(() => options.onabort?.()); } };
  };
})();
