/* Executed by fixture-server.cjs only. All media/save operations are test doubles. */
window.runPinterestSmoke = async function () {
  if (!window.__mock || location.hostname !== '127.0.0.1') throw new Error('Use the local fixture');
  const m = window.__mock, checks = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (f, label) => { for (let i = 0; i < 800; i++) { if (f()) return; await pause(20); } throw new Error('Timeout: ' + label); };
  await wait(() => document.getElementById('pin-board-downloader')?.shadowRoot?.getElementById('toggle')?.onclick, 'initialization');
  const shadow = document.getElementById('pin-board-downloader').shadowRoot;
  const $ = id => shadow.getElementById(id);
  const change = (id, value) => { const e = $(id); if (e.type === 'checkbox') e.checked = value; else e.value = value; e.dispatchEvent(new Event('change')); };
  const refresh = async () => { $('refresh').click(); await wait(() => !$('start').disabled, 'board refresh'); };
  const mainOnly = () => { $('sec-none').click(); shadow.querySelector('#sections input').click(); };
  const complete = () => wait(() => $('stop').disabled && $('status').textContent.startsWith('完成：'), 'download completion');
  const manualFinish = async () => { for (let i = 0; i < 800; i++) { if (!$('save').hidden) $('save').click(); if ($('stop').disabled) return; await pause(20); } throw new Error('Manual task did not finish'); };
  const readZip = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer()), v = new DataView(bytes.buffer), decode = new TextDecoder(), files = new Map();
    let p = 0;
    while (v.getUint32(p, true) === 0x04034b50) {
      const n = v.getUint16(p + 26, true), x = v.getUint16(p + 28, true), size = v.getUint32(p + 18, true), start = p + 30 + n + x;
      files.set(decode.decode(bytes.subarray(p + 30, p + 30 + n)), bytes.slice(start, start + size)); p = start + size;
    }
    return files;
  };
  const zipNames = async downloads => (await Promise.all(downloads.filter(d => d.name.endsWith('.zip')).map(async d => [...(await readZip(d.blob)).keys()].filter(k => !/\.(csv|json)$/.test(k))))).flat();

  assert(m.api.length === 0 && m.requests.length === 0, 'No account requests before user action');
  $('toggle').click(); await wait(() => !$('start').disabled, 'board opens');
  assert(shadow.querySelectorAll('#sections input').length === 3, 'Board lists unsectioned pins and two sections');
  assert([...shadow.querySelectorAll('#sections input')].every(e => e.checked), 'Whole board selected by default');
  assert(!m.api.some(a => a.resource === 'BoardFeed'), 'Opening panel reads metadata, not the whole feed');
  $('size').add(new Option('2', '2')); change('size', '2'); $('start').click(); await complete();
  assert(m.requests.length === 8 && !m.requests.some(r => r.id === '3001'), 'All supported files fetched, HLS omitted without downloading cover');
  assert(m.maxActive <= 3 && m.maxActive > 1, 'Media concurrency is bounded to three');
  assert(m.api.filter(a => a.resource === 'BoardFeed').length === 2, 'Main feed pagination follows bookmark');
  assert(m.downloads.length === 4, 'Automatic saving produces four two-file packages without extra clicks');
  const files = (await Promise.all(m.downloads.map(d => readZip(d.blob)))).flatMap(x => [...x.keys()]);
  assert(files.some(f => f.endsWith('.mp4')) && files.some(f => f.endsWith('.heic')), 'Video and HEIC formats retained');
  const first = await readZip(m.downloads[0].blob);
  assert(first.has('清单.csv') && first.has('下载报告.json'), 'Each package includes provenance CSV and report');
  const report = JSON.parse(new TextDecoder().decode(first.get('下载报告.json')));
  assert(report.skipped.some(r => r.pinId === '3001'), 'HLS skip appears in report');
  assert(!sessionStorage.getItem('pbd-history-v1'), 'Saving attempts do not falsely mark files as downloaded');
  m.confirmAnswer = false; $('confirm-saved').click(); assert(!sessionStorage.getItem('pbd-history-v1'), 'Declining confirmation leaves history unchanged');
  m.confirmAnswer = true; $('confirm-saved').click();
  assert(Object.keys(JSON.parse(sessionStorage.getItem('pbd-history-v1'))['100']).length === 8, 'Explicit confirmation records all eight saved assets');
  const oldRequests = m.requests.length; $('start').click(); await wait(() => $('stop').disabled && $('status').textContent.includes('均已确认'), 'already saved');
  assert(m.requests.length === oldRequests, 'Only-new mode does not refetch confirmed assets');
  m.mainCount = 4; await refresh(); const beforeNew = m.requests.length; $('start').click(); await complete();
  assert(m.requests.length === beforeNew + 1 && m.requests.at(-1).id === '1004', 'Repeated download picks up newly added pin only');
  $('confirm-saved').click(); change('only-new', false); m.mainCount = 3; await refresh(); mainOnly();
  m.failIds.add('1002'); $('start').click(); await complete();
  assert($('summary').textContent.includes('失败 1') && $('summary').textContent.includes('已获取 2'), 'Failed file does not discard successful files');
  m.failIds.clear(); const beforeRetry = m.requests.length; $('retry').click(); await complete();
  assert(m.requests.length === beforeRetry + 1 && $('summary').textContent.includes('失败 0'), 'Retry downloads only failed file');
  $('pick').click(); await wait(() => $('picker').open, 'optional picker');
  $('pick-none').click(); assert($('pick-ok').disabled, 'Empty optional selection cannot download');
  shadow.querySelector('#grid input').click(); $('picker').close();
  const beforeLinks = m.downloads.length; $('links').click();
  assert((await m.downloads[beforeLinks].blob.text()).trim().split('\n').length === 1, 'Exported links follow optional selection');
  $('pick').click(); await wait(() => $('picker').open, 'reopen picker'); const beforePick = m.requests.length; $('pick-ok').click(); await complete();
  assert(m.requests.length === beforePick + 1, 'Optional picker downloads only chosen file');

  m.mainCount = 5; await refresh(); mainOnly(); change('auto', false); const beforeManual = m.downloads.length;
  $('start').click(); await wait(() => !$('save').hidden, 'manual package ready');
  assert(m.downloads.length === beforeManual, 'Manual mode does not auto-save');
  $('stop').click(); await wait(() => $('stop').disabled, 'stop while waiting for save');
  assert(!$('save').hidden && $('summary').textContent.includes('待处理 3'), 'Stopping at count boundary preserves ready ZIP and unprocessed items');
  $('save').click(); $('resume').click(); await manualFinish();
  const savedNames = await zipNames(m.downloads.slice(beforeManual));
  assert(savedNames.length === 5 && new Set(savedNames).size === 5, 'Resume saves five distinct files with none missing');

  await refresh(); mainOnly(); change('size', '50'); const beforeActive = m.requests.length;
  $('start').click(); await wait(() => $('progress').value === 3, 'first batch'); m.delay = 5000;
  await wait(() => m.requests.length === beforeActive + 5, 'second batch active'); $('stop').click(); await wait(() => $('stop').disabled, 'abort active requests');
  assert(m.aborts >= 2 && !$('save').hidden && $('summary').textContent.includes('待处理 2'), 'Active cancellation preserves partial package and remaining queue');
  $('save').click(); m.delay = 15; $('resume').click(); await manualFinish();

  await refresh(); mainOnly(); const beforeRoute = m.requests.length; $('start').click(); await wait(() => $('progress').value === 3, 'route first batch'); m.delay = 5000;
  await wait(() => m.requests.length === beforeRoute + 5, 'route second batch'); history.pushState({}, '', '/demo/other/'); window.dispatchEvent(new PopStateEvent('popstate'));
  await wait(() => $('stop').disabled && !$('save').hidden, 'route abort package');
  assert($('resume').disabled && $('refresh').disabled, 'Navigation preserves unsaved ZIP and blocks wrong-board resume');
  $('save').click(); m.delay = 15; await refresh(); assert(!$('start').disabled, 'New board can load after old ZIP is saved');

  m.mainCount = 2; await refresh(); mainOnly(); change('size', '100'); m.large = true;
  $('start').click(); await wait(() => !$('save').hidden, '64 MiB crossing'); $('stop').click(); await wait(() => $('stop').disabled, 'stop at byte boundary');
  assert($('summary').textContent.includes('待处理 1'), 'Cancellation before byte-limit flush does not remove the next file');
  $('save').click(); m.large = false; $('resume').click(); await manualFinish();
  assert($('summary').textContent.includes('已获取 2'), 'Resume after byte boundary finishes both files');
  for (const [url, blob] of m.blobs) if (blob.size > 10 * 1024 * 1024) URL.revokeObjectURL(url);
  m.downloads = m.downloads.filter(d => d.blob.size < 10 * 1024 * 1024);

  change('auto', true); await refresh(); mainOnly(); change('size', '2'); m.saveError = true;
  $('start').click(); await wait(() => !$('save').hidden, 'auto-save exception');
  assert(!$('auto').checked, 'Automatic save exception falls back to manual mode');
  m.saveError = false; await manualFinish();
  const photo = document.querySelector('[data-test-id="pin"] img');
  photo.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  assert(!$('hoverbtn').hidden, 'Hover button appears on a Pin card');
  const beforeHover = m.downloads.length; $('hoverbtn').click(); await wait(() => m.downloads.length > beforeHover && !$('hoverbtn').disabled, 'hover download');
  assert(m.downloads.at(-1).name.endsWith('.png'), 'Single-Pin download saves detected image format directly');

  m.mainCount = 65; m.pageSize = 100; await refresh(); mainOnly(); $('pick').click(); await wait(() => $('picker').open, 'large picker');
  assert(shadow.querySelectorAll('#grid input').length === 60, 'Optional large picker renders at most 60 thumbnails per page');
  $('pick-none').click(); shadow.querySelector('#grid input').click(); $('pick-next').click();
  assert(shadow.querySelectorAll('#grid input').length === 5, 'Last picker page contains remaining five files');
  shadow.querySelector('#grid input').click(); $('pick-prev').click();
  assert(shadow.querySelector('#grid input').checked && $('pick-count').textContent.includes('已选 2'), 'Selection survives pagination');
  $('picker').close(); const beforePreview = m.downloads.length; $('preview').click();
  assert(m.opens.length === 1 && m.previewURL && m.downloads.length === beforePreview, 'Preview opens once without also triggering a download');
  m.popupBlocked = true; $('preview').click(); assert(m.downloads.at(-1).name.endsWith('.html'), 'Blocked preview popup falls back to HTML export');
  $('report').click(); assert(m.downloads.at(-1).name.endsWith('.json'), 'Download report can be exported independently');

  m.apiStatus = 403; $('refresh').click(); await wait(() => $('stop').disabled, 'denied board');
  assert($('start').disabled && $('status').textContent.includes('403'), 'Permission error disables stale download action');
  change('size', '100'); change('auto', false);
  assert(JSON.parse(sessionStorage.getItem('pbd-settings-v1')).size === 100, 'Preferences persisted');
  assert(m.errors.length === 0, 'No browser runtime errors or unhandled rejections');
  return { passed: checks.length, checks, apiCalls: m.api.length, mediaRequests: m.requests.length, savedActions: m.downloads.length, maxConcurrent: m.maxActive };
};
