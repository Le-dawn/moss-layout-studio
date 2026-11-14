import { api } from './api.js';
import {
  COLORS, LABELS, normDoc, pairsOverlap, hasOcclusion, sizeFor,
} from './layout.js';
import {
  $, $$, esc, toast, copyText, downloadText, formDialog, confirmDialog, slug,
} from './ui.js';

const MIN_W = 300;
const KLABEL = { object: '物体', character: '人物', text: '文字' };

const S = {
  id: null,
  name: '',
  doc: null,
  rev: 0,
  updated: null,
  image: false,
  imageName: '',
  imageUrl: '',
  sel: -1,
  dirty: false,
  saving: false,
  pending: false,
  undo: [],
  redo: [],
  preEdit: null,
  tab: 'moss',
  check: null,
  checkState: 'idle',
  checkSeq: 0,
  exportData: null,
  exportSeq: 0,
  klein: { task: 't2i', refs: 1, instruction: '', from: {}, prefix: 'ref_images.ref_image_' },
  ports: {},
};

let bound = false;
let saveTimer = null;
let checkTimer = null;
let exportTimer = null;

/* ── 载入 ─────────────────────────────────────────────────────────────── */

export async function mountEditor(id) {
  clearTimeout(saveTimer);
  clearTimeout(checkTimer);
  clearTimeout(exportTimer);
  const dialog = $('#export-dialog');
  if (dialog.open) dialog.close();

  let record;
  try {
    record = (await api.get(id)).layout;
  } catch (error) {
    toast(error.message, 'error');
    location.hash = '#/';
    return;
  }

  S.id = record.id;
  S.name = record.name;
  S.doc = normDoc(record.doc);
  S.rev = record.rev;
  S.updated = record.updated_at;
  S.image = Boolean(record.image);
  S.imageName = record.image_name || '';
  S.imageUrl = S.image ? `${api.imageUrl(id)}?t=${Date.now()}` : '';
  const groundIndex = S.doc.items.findIndex((item) => {
    const w = item.bbox[2] - item.bbox[0];
    const h = item.bbox[3] - item.bbox[1];
    return w >= S.doc.width * 0.94 && h >= S.doc.height * 0.94;
  });
  S.sel = S.doc.items.length ? (groundIndex === 0 && S.doc.items.length > 1 ? 1 : Math.max(0, groundIndex)) : -1;
  S.dirty = false;
  S.saving = false;
  S.pending = false;
  S.undo = [];
  S.redo = [];
  S.preEdit = null;
  S.check = null;
  S.checkState = 'idle';
  S.exportData = null;
  S.tab = 'moss';
  S.klein = { task: 't2i', refs: 1, instruction: '', from: {}, prefix: 'ref_images.ref_image_' };
  S.ports = {};

  if (!bound) {
    bind();
    bound = true;
  }

  $('#ename').value = S.name;
  document.title = `${S.name} · Layout Studio`;
  renderAll();
  requestAnimationFrame(fitCanvas);
  scheduleCheck(260);
  setSaveState('已保存');
}

export async function leaveEditor() {
  clearTimeout(saveTimer);
  clearTimeout(checkTimer);
  clearTimeout(exportTimer);
  const dialog = $('#export-dialog');
  if (dialog.open) dialog.close();
  if (S.id && S.dirty) await save({ silent: true });
}

/* ── 基础状态 ─────────────────────────────────────────────────────────── */

const currentItem = () => S.doc?.items?.[S.sel] || null;

const clampSel = () => {
  if (!S.doc?.items.length) return -1;
  return Math.max(0, Math.min(S.sel, S.doc.items.length - 1));
};

function setSaveState(text, kind = '') {
  $('#save-state').textContent = text;
  $('#sdot').className = `sdot${kind ? ` ${kind}` : ''}`;
}

function markChanged() {
  S.dirty = true;
  setSaveState('未保存', 'dirty');
  scheduleSave(900);
  scheduleCheck(900);
}

function scheduleSave(milliseconds = 900) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save({ silent: true }), milliseconds);
}

function snapshot() {
  return JSON.stringify(S.doc);
}

function pushUndo() {
  if (!S.doc) return;
  S.undo.push(snapshot());
  if (S.undo.length > 80) S.undo.shift();
  S.redo = [];
  renderTop();
}

function commitEdit() {
  if (S.preEdit && S.preEdit !== snapshot()) {
    S.undo.push(S.preEdit);
    if (S.undo.length > 80) S.undo.shift();
    S.redo = [];
  }
  S.preEdit = null;
  renderTop();
}

function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  S.doc = JSON.parse(S.undo.pop());
  S.sel = clampSel();
  renderAll();
  markChanged();
}

function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  S.doc = JSON.parse(S.redo.pop());
  S.sel = clampSel();
  renderAll();
  markChanged();
}

/* ── 保存 ─────────────────────────────────────────────────────────────── */

async function save({ silent = true } = {}) {
  if (!S.id || !S.doc) return true;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (S.saving) {
    S.pending = true;
    return false;
  }
  if (!S.dirty) {
    if (!silent) toast('没有需要保存的改动');
    return true;
  }

  S.saving = true;
  setSaveState('保存中…', 'busy');
  const snap = JSON.stringify(S.doc);
  let ok = true;

  try {
    const res = await api.update(S.id, { name: S.name, doc: JSON.parse(snap), rev: S.rev });
    S.rev = res.layout.rev;
    S.updated = res.layout.updated_at;
  } catch (error) {
    if (error.status === 409) {
      S.saving = false;
      ok = await overwriteRemote();
      S.saving = true;
    } else {
      ok = false;
      setSaveState('保存失败', 'error');
      toast(error.message, 'error');
    }
  }

  S.saving = false;
  if (ok) {
    if (JSON.stringify(S.doc) === snap) {
      S.dirty = false;
      setSaveState('已保存');
      if (!silent) toast('已保存', 'ok');
    } else {
      setSaveState('未保存', 'dirty');
    }
  }
  if (S.pending) {
    S.pending = false;
    if (S.dirty) scheduleSave(160);
  } else if (S.dirty) {
    scheduleSave(1000);
  }
  return ok;
}

async function overwriteRemote() {
  const ok = await confirmDialog(
    '这份草稿在别处被改过',
    '服务器上的版本比你打开时更新。用当前页面的内容覆盖它吗？覆盖后另一边的改动会丢。',
    { okText: '覆盖保存', danger: true },
  );
  if (!ok) {
    setSaveState('未保存', 'dirty');
    toast('已取消覆盖，刷新页面可载入服务器版本');
    return false;
  }
  try {
    const res = await api.update(S.id, {
      name: S.name, doc: S.doc, rev: S.rev, force: true,
    });
    S.rev = res.layout.rev;
    S.updated = res.layout.updated_at;
    setSaveState('已保存');
    toast('已覆盖服务器版本', 'ok');
    return true;
  } catch (error) {
    setSaveState('保存失败', 'error');
    toast(error.message, 'error');
    return false;
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */

function renderAll() {
  if (!S.doc) return;
  S.sel = clampSel();
  renderTop();
  renderSummary();
  renderCanvas();
  renderLayers();
  renderInspector();
  renderOverlaps();
}

function renderTop() {
  if (!S.doc) return;
  if (document.activeElement !== $('#ename')) $('#ename').value = S.name;
  $('#ename-meta').textContent = `${S.doc.width}×${S.doc.height} · ${S.doc.items.length} 个元素`;
  if (document.activeElement !== $('#i-w')) $('#i-w').value = S.doc.width;
  if (document.activeElement !== $('#i-h')) $('#i-h').value = S.doc.height;
  $('#b-undo').disabled = !S.undo.length;
  $('#b-redo').disabled = !S.redo.length;
  $('#b-del').disabled = !currentItem();
  $('#basebar').hidden = !S.image;
  $('#basebar-name').textContent = S.imageName || '';
}

function setValue(selector, value) {
  const el = $(selector);
  if (el && document.activeElement !== el) el.value = value;
}

function renderSummary() {
  const summary = S.doc.summary;
  setValue('#s-cap', summary.caption);
  setValue('#s-meta', summary.meta.join(', '));
  setValue('#s-pal', summary.palette.join(', '));
  $('#s-canvas').value = summary.canvas;
  updateSummaryCount();
  $('#sum-chips').innerHTML = [
    `<span class="chip">meta ${esc(summary.meta.length ? summary.meta.join(' / ') : '—')}</span>`,
    `<span class="chip">canvas ${esc(summary.canvas)}</span>`,
    `<span class="chip${summary.palette.length ? ' hot' : ''}">palette ${summary.palette.length ? `${summary.palette.length} 色` : '—'}</span>`,
  ].join('');
  renderPalette();
}

function updateSummaryCount() {
  const caption = S.doc.summary.caption.trim();
  const words = caption.split(/\s+/).filter(Boolean).length;
  $('#s-count').textContent = `${caption.length} 字符 · ${words} 词`;
}

function normHex(color) {
  const value = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value.slice(1).split('').map((ch) => ch + ch).join('')}`;
  }
  return null;
}

function renderPalette() {
  const host = $('#palette');
  host.innerHTML = '';
  S.doc.summary.palette.forEach((color, index) => {
    const wrap = document.createElement('span');
    wrap.className = 'sw';
    wrap.style.background = color;
    wrap.title = color;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = normHex(color) || '#888888';
    input.addEventListener('input', (event) => {
      S.doc.summary.palette[index] = event.target.value;
      wrap.style.background = event.target.value;
      syncPaletteText();
    });
    input.addEventListener('change', () => {
      pushUndo();
      renderSummary();
      markChanged();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'x';
    remove.textContent = '×';
    remove.title = '删掉这个颜色';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      pushUndo();
      S.doc.summary.palette.splice(index, 1);
      renderSummary();
      markChanged();
    });
    wrap.append(input, remove);
    host.appendChild(wrap);
  });
}

function syncPaletteText() {
  const el = $('#s-pal');
  if (document.activeElement !== el) el.value = S.doc.summary.palette.join(', ');
}

function tagHTML(item, index) {
  const caption = item.caption.trim();
  const text = item.text.trim();
  const head = `<div class="thd"><b>${index + 1}</b><span>${KLABEL[item.label]}</span></div>`;
  if (item.label === 'text') {
    return `<div class="tag">${head}${text
      ? `<div class="ttext">${esc(text)}</div>`
      : '<div class="tcap miss">未填文字</div>'}</div>`;
  }
  return `<div class="tag">${head}
    <div class="tcap${caption ? '' : ' miss'}">${caption ? esc(caption) : '描述还没填'}</div>
  </div>`;
}

function paintBox(el, item, index) {
  const { width, height } = S.doc;
  const [x1, y1, x2, y2] = item.bbox;
  const boxW = x2 - x1;
  const boxH = y2 - y1;
  const full = boxW >= width * 0.94 && boxH >= height * 0.94;
  const tiny = boxW < 200 || boxH < 78;
  const small = boxW < 400 || boxH < 160;

  el.className = `bx${index === S.sel ? ' sel' : ''}${full ? ' full' : ''}${tiny ? ' tiny' : small ? ' small' : ''}`;
  el.style.left = `${(x1 / width) * 100}%`;
  el.style.top = `${(y1 / height) * 100}%`;
  el.style.width = `${(boxW / width) * 100}%`;
  el.style.height = `${(boxH / height) * 100}%`;
  el.style.zIndex = index === S.sel ? 999 : 10 + index;
  el.style.setProperty('--c', COLORS[item.label] || '#8b95a5');
  el.innerHTML = tagHTML(item, index)
    + ['nw', 'ne', 'sw', 'se'].map((handle) => `<i class="h ${handle}" data-h="${handle}"></i>`).join('');
}

function emptyHTML() {
  return `<div class="cv-empty">
    <p>画布还是空的</p>
    <small>先放一个铺满画布的背景，再往上叠主体和文字。框只是位置标注，不会画成边框。</small>
    <div class="row">
      <button class="btn" data-add="ground">＋ 背景块</button>
      <button class="btn" data-add="text">＋ 文字块</button>
    </div>
  </div>`;
}

function renderCanvas() {
  const cv = $('#cv');
  cv.innerHTML = '';
  if (S.image && S.imageUrl) {
    const image = document.createElement('img');
    image.className = 'base';
    image.src = S.imageUrl;
    image.alt = '';
    cv.appendChild(image);
  }
  S.doc.items.forEach((item, index) => {
    const el = document.createElement('div');
    el.dataset.i = String(index);
    paintBox(el, item, index);
    cv.appendChild(el);
    bindBox(el, index);
  });
  if (!S.doc.items.length) cv.insertAdjacentHTML('beforeend', emptyHTML());
}

function renderLayers() {
  const host = $('#layers');
  const items = S.doc.items;
  $('#layer-count').textContent = items.length ? `${items.length} 个` : '';
  host.innerHTML = items.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => {
    const preview = item.label === 'text'
      ? (item.text || '（无文字）').replace(/\n/g, ' / ')
      : (item.caption || '（无描述）');
    return `<button class="lrow${index === S.sel ? ' sel' : ''}" data-i="${index}" style="--c:${COLORS[item.label]}">
      <i class="ldot"></i><span class="lnum">${index + 1}</span>
      <span class="lprev">${esc(preview.slice(0, 80))}</span>
      <span class="lz">${index + 1}/${items.length}</span>
    </button>`;
  }).join('');
  $$('.lrow', host).forEach((row) => {
    row.addEventListener('click', () => select(Number(row.dataset.i)));
  });
}

function renderInspector() {
  const item = currentItem();
  const fields = $('#insp-fields');
  const empty = $('#insp-empty');
  fields.hidden = !item;
  empty.hidden = Boolean(item);
  $('#i-num').textContent = item ? `#${S.sel + 1}` : '#—';
  $('#i-kind').textContent = item ? KLABEL[item.label] : '没有选中元素';
  $('#i-pos').textContent = item ? `${item.bbox[2] - item.bbox[0]}×${item.bbox[3] - item.bbox[1]} px` : '';
  if (!item) return;

  $('#i-num').style.setProperty('--c', COLORS[item.label]);
  $$('#i-type button').forEach((button) => {
    button.classList.toggle('on', button.dataset.label === item.label);
  });
  $('#wrap-text').hidden = item.label !== 'text';
  setValue('#f-text', item.text);
  $('#c-text').textContent = item.label === 'text' ? `${item.text.length} 字 / ${item.text.split('\n').length} 行` : '';
  setValue('#f-cap', item.caption);
  ['x1', 'y1', 'x2', 'y2'].forEach((key, index) => {
    const input = $(`#f-${key}`);
    if (document.activeElement !== input) input.value = item.bbox[index];
  });
  setValue('#f-tags', item.tags.join(', '));
}

function nameOf(index) {
  const item = S.doc.items[index];
  if (!item) return `#${index + 1}`;
  const signature = (item.caption || '').replace(/[，。；、].*$/, '');
  return `#${index + 1} ${KLABEL[item.label]}${signature ? `（${signature.slice(0, 14)}）` : ''}`;
}

function renderOverlaps() {
  const pairs = pairsOverlap(S.doc);
  const list = $('#ovp-list');
  $('#ovp-count').textContent = pairs.length ? `${pairs.length} 对重叠` : '无重叠';
  $('#ovp').classList.toggle('none', !pairs.length);
  list.innerHTML = pairs.map((pair) => {
    const done = hasOcclusion(S.doc.items[pair.i]) || hasOcclusion(S.doc.items[pair.j]);
    return `<li class="${done ? 'done' : ''}"><span class="q">${done ? '✓' : '?'}</span>
      <span>${esc(nameOf(pair.i))} × ${esc(nameOf(pair.j))} · ${pair.rect[2] - pair.rect[0]}×${pair.rect[3] - pair.rect[1]}</span></li>`;
  }).join('');
}

function askText() {
  const pairs = pairsOverlap(S.doc);
  if (!pairs.length) return '没有重叠的框，不需要定前后。';
  const lines = [
    `【前后关系询问单】画布 ${S.doc.width}×${S.doc.height}（layout 提示词）`,
    '以下框两两重叠，请逐条给出「谁在前 / 谁在后」，并把遮挡句写进各自 caption：',
  ];
  pairs.forEach((pair, index) => {
    lines.push(`${index + 1}. ${nameOf(pair.i)} × ${nameOf(pair.j)}   重叠区间 x ${pair.rect[0]}–${pair.rect[2]}, y ${pair.rect[1]}–${pair.rect[3]}`);
  });
  lines.push(
    '',
    '说明：layout 规范没有 z 字段，遮挡只能写成 caption 里的句子（谁在前、挡住谁的哪一部分）。',
    '写句子时指代一律用方位短语（the bust above it / the bust on its right / the central bust），',
    '不要复用 caption 开头的词——多人构图里那样会退化成同一个模糊指代。',
    '写好后把草稿 JSON 交回来，这份画布能直接打开。',
  );
  return lines.join('\n');
}

/* ── 画布几何 ─────────────────────────────────────────────────────────── */

function fitCanvas() {
  if (!S.doc) return;
  const stage = $('#stage');
  const cv = $('#cv');
  const availW = Math.max(80, stage.clientWidth - 48);
  const availH = Math.max(80, stage.clientHeight - 48);
  let width = availW;
  let height = (width * S.doc.height) / S.doc.width;
  if (height > availH) {
    height = availH;
    width = (height * S.doc.width) / S.doc.height;
  }
  if (width < MIN_W) {
    width = MIN_W;
    height = (width * S.doc.height) / S.doc.width;
  }
  cv.style.width = `${Math.round(width)}px`;
  cv.style.height = `${Math.round(height)}px`;
}

function clampBox(box) {
  let [x1, y1, x2, y2] = box;
  const width = x2 - x1;
  const height = y2 - y1;
  x1 = Math.max(0, Math.min(S.doc.width - width, x1));
  y1 = Math.max(0, Math.min(S.doc.height - height, y1));
  return [Math.round(x1), Math.round(y1), Math.round(x1 + width), Math.round(y1 + height)];
}

function bindBox(el, index) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const handle = event.target.dataset?.h || '';
    select(index);
    startTransform(index, event, handle);
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (S.doc.items[index]?.label === 'text') {
      $('#f-text').focus();
      $('#f-text').select();
    } else {
      $('#f-cap').focus();
    }
  });
}

function startTransform(index, event, handle) {
  event.preventDefault();
  const rect = $('#cv').getBoundingClientRect();
  const scaleX = S.doc.width / rect.width;
  const scaleY = S.doc.height / rect.height;
  const base = S.doc.items[index].bbox.slice();
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;

  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - startX) * scaleX;
    const dy = (moveEvent.clientY - startY) * scaleY;
    if (!dx && !dy) return;
    if (!moved) {
      pushUndo();
      moved = true;
    }
    const item = S.doc.items[index];
    if (!handle) {
      item.bbox = clampBox([base[0] + dx, base[1] + dy, base[2] + dx, base[3] + dy]);
    } else {
      let [x1, y1, x2, y2] = base;
      if (handle.includes('w')) x1 = Math.max(0, Math.min(base[2] - 10, base[0] + dx));
      if (handle.includes('e')) x2 = Math.min(S.doc.width, Math.max(base[0] + 10, base[2] + dx));
      if (handle.includes('n')) y1 = Math.max(0, Math.min(base[3] - 10, base[1] + dy));
      if (handle.includes('s')) y2 = Math.min(S.doc.height, Math.max(base[1] + 10, base[3] + dy));
      item.bbox = [x1, y1, x2, y2].map((value) => Math.round(value));
    }
    const el = $(`#cv .bx[data-i="${index}"]`);
    if (el) paintBox(el, item, index);
    syncBboxInputs(index);
    $('#i-pos').textContent = `${item.bbox[2] - item.bbox[0]}×${item.bbox[3] - item.bbox[1]} px`;
  };

  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!moved) return;
    renderCanvas();
    renderLayers();
    renderInspector();
    renderOverlaps();
    markChanged();
  };

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function syncBboxInputs(index) {
  const item = S.doc.items[index];
  if (!item) return;
  ['x1', 'y1', 'x2', 'y2'].forEach((key, i) => {
    const input = $(`#f-${key}`);
    if (document.activeElement !== input) input.value = item.bbox[i];
  });
}

function select(index) {
  S.sel = index;
  $$('#cv .bx').forEach((el) => {
    const current = Number(el.dataset.i);
    el.classList.toggle('sel', current === index);
    el.style.zIndex = current === index ? 999 : 10 + current;
  });
  renderLayers();
  renderInspector();
  renderTop();
}

/* ── 编辑动作 ─────────────────────────────────────────────────────────── */

function addItem(kind = 'text') {
  pushUndo();
  const width = S.doc.width;
  const height = S.doc.height;
  let item;
  if (kind === 'ground') {
    item = {
      label: 'object',
      caption: '',
      text: '',
      tags: [],
      palette: [],
      bbox: [0, 0, width, height],
    };
  } else {
    const boxW = Math.round(width * 0.36);
    const boxH = Math.round(height * 0.1);
    item = {
      label: 'text',
      text: '',
      caption: '',
      tags: [],
      palette: [],
      bbox: [
        Math.round((width - boxW) / 2), Math.round((height - boxH) / 2),
        Math.round((width + boxW) / 2), Math.round((height + boxH) / 2),
      ],
    };
  }
  S.doc.items.push(item);
  S.sel = S.doc.items.length - 1;
  renderAll();
  markChanged();
  setTimeout(() => {
    if (kind === 'ground') {
      $('#f-cap').focus();
    } else {
      $('#f-text').focus();
      $('#f-text').select();
    }
  }, 30);
}

function removeItem() {
  if (!S.doc.items.length) return;
  pushUndo();
  S.doc.items.splice(S.sel, 1);
  S.sel = clampSel();
  renderAll();
  markChanged();
}

function alignSelected(mode) {
  const item = currentItem();
  if (!item) return;
  const [x1, y1, x2, y2] = item.bbox;
  const boxW = x2 - x1;
  const boxH = y2 - y1;
  pushUndo();
  if (mode === 'h') {
    const left = Math.round((S.doc.width - boxW) / 2);
    item.bbox = [left, y1, left + boxW, y2];
  } else if (mode === 'v') {
    const top = Math.round((S.doc.height - boxH) / 2);
    item.bbox = [x1, top, x2, top + boxH];
  } else {
    item.bbox = [0, 0, S.doc.width, S.doc.height];
  }
  renderAll();
  markChanged();
}

function resizeTo(width, height) {
  if (width === S.doc.width && height === S.doc.height) return;
  pushUndo();
  const kx = width / S.doc.width;
  const ky = height / S.doc.height;
  S.doc.items.forEach((item) => {
    item.bbox = [
      Math.round(item.bbox[0] * kx), Math.round(item.bbox[1] * ky),
      Math.round(item.bbox[2] * kx), Math.round(item.bbox[3] * ky),
    ];
  });
  S.doc.width = width;
  S.doc.height = height;
  renderAll();
  requestAnimationFrame(fitCanvas);
  markChanged();
}

function applyPreset() {
  const ratio = $('#i-ratio').value;
  if (!ratio) return;
  const megapixels = Number($('#i-mp').value) || (S.doc.width * S.doc.height) / 1e6;
  const size = sizeFor(ratio, megapixels);
  if (!size) return;
  resizeTo(size[0], size[1]);
  toast(`画布 ${size[0]}×${size[1]}，所有框等比跟随`, 'ok');
}

/* ── 校验 ─────────────────────────────────────────────────────────────── */

function kleinPayload() {
  return {
    task: S.klein.task,
    refs: S.klein.refs,
    instruction: S.klein.instruction,
    from_map: S.klein.from,
    text_margin: 8,
    text_prefix: 'auto',
  };
}

function scheduleCheck(milliseconds = 700) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, milliseconds);
}

async function runCheck() {
  if (!S.doc) return;
  const seq = ++S.checkSeq;
  setCheckChip('busy');
  try {
    const res = await api.compile({ doc: S.doc, klein: kleinPayload() });
    if (seq !== S.checkSeq) return;
    S.check = res.validation;
    setCheckChip('done');
  } catch (error) {
    if (seq !== S.checkSeq) return;
    S.check = { errors: [error.message], warnings: [] };
    setCheckChip('error');
  }
}

function setCheckChip(mode) {
  const chip = $('#check-chip');
  const text = $('#check-text');
  chip.classList.remove('ok', 'warn', 'err');
  if (mode === 'busy') {
    text.textContent = '检查中…';
    return;
  }
  if (mode === 'error') {
    chip.classList.add('err');
    text.textContent = '检查失败';
    return;
  }
  const errors = S.check?.errors?.length || 0;
  const warnings = S.check?.warnings?.length || 0;
  if (errors) {
    chip.classList.add('err');
    text.textContent = `${errors} 个错误`;
  } else if (warnings) {
    chip.classList.add('warn');
    text.textContent = `${warnings} 条提醒`;
  } else {
    chip.classList.add('ok');
    text.textContent = '校验通过';
  }
}

/* ── 导出面板 ─────────────────────────────────────────────────────────── */

function syncExportTabs() {
  $$('#exp-tabs button').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === S.tab);
  });
  $$('#export-dialog .pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== S.tab;
  });
}

async function openExport() {
  if (!S.doc) return;
  clearTimeout(saveTimer);
  save({ silent: true });
  S.tab = 'moss';
  S.exportData = null;
  $('#exp-sub').textContent = `${S.name} · ${S.doc.width}×${S.doc.height}`;
  syncExportTabs();
  renderKleinConfig();
  const dialog = $('#export-dialog');
  if (!dialog.open) dialog.showModal();
  $('.mbody').scrollTop = 0;
  await refreshExport();
}

function scheduleExport(milliseconds = 280) {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(refreshExport, milliseconds);
}

async function refreshExport() {
  if (!S.doc) return;
  const seq = ++S.exportSeq;
  $('#exp-msg').textContent = '编译中…';
  try {
    const res = await api.compile({ doc: S.doc, klein: kleinPayload() });
    if (seq !== S.exportSeq) return;
    S.exportData = res;
    S.check = res.validation;
    setCheckChip('done');
    renderExport(res);
  } catch (error) {
    if (seq !== S.exportSeq) return;
    $('#exp-msg').textContent = `编译失败：${error.message}`;
    $('#o-moss').textContent = '';
    $('#vlist').innerHTML = `<div class="e">✕ ${esc(error.message)}</div>`;
  }
}

function renderExport(res) {
  const { errors, warnings } = res.validation;
  const vlist = $('#vlist');
  const lines = [];
  errors.forEach((message) => lines.push(`<div class="e">✕ ${esc(message)}</div>`));
  warnings.forEach((message) => lines.push(`<div class="w">! ${esc(message)}</div>`));
  if (!errors.length && !warnings.length) lines.push('<div class="ok">✓ 校验通过</div>');
  else if (!errors.length) lines.push(`<div class="ok">✓ 可以编译（${warnings.length} 条提醒）</div>`);
  vlist.innerHTML = lines.join('');

  $('#o-moss').textContent = res.formats.moss || '（先修掉上面的错误）';
  $('#o-draft').textContent = res.formats.draft;

  const edit = res.klein.task === 'edit';
  $('#kcfg').hidden = !edit;
  $('#k-warn').innerHTML = (res.klein.warnings || [])
    .map((message) => `<div class="w">! ${esc(message)}</div>`).join('');
  $('#o-klein').textContent = edit
    ? (res.klein.text || '（先填一句英文指令；文字块会自动带 Text reads）')
    : '（当前是文生图：不需要 Klein 编辑稿。要改已有图，上面切成「图像编辑」。）';
  $('#k-ids').textContent = edit ? `id：${res.klein.ids.join(' · ')}` : '';

  renderPortMap(res);
  updateExportMsg();
}

function updateExportMsg() {
  const res = S.exportData;
  if (!res) return;
  const errors = res.validation.errors.length;
  const warnings = res.validation.warnings.length;
  if (S.tab === 'klein') {
    const klein = res.klein.text
      ? `Klein ${res.klein.text.length} 字符 · ${res.klein.rows.length} 行`
      : (res.klein.task === 'edit' ? 'Klein 未生成（先填指令）' : '文生图不需要 Klein');
    $('#exp-msg').textContent = `${res.stats.items} 个元素 · ${klein}`;
    return;
  }
  if (S.tab === 'draft') {
    $('#exp-msg').textContent = `${res.stats.items} 个元素 · ${res.formats.draft.length} 字符`;
    return;
  }
  const moss = res.formats.moss ? `MOSS ${res.formats.moss.length} 字符` : 'MOSS 未生成';
  const tail = errors ? `${errors} 个错误` : (warnings ? `${warnings} 条提醒` : '校验通过');
  $('#exp-msg').textContent = `${res.stats.items} 个元素 · ${moss} · ${tail}`;
}

function renderKleinConfig() {
  if (!S.doc) return;
  $('#k-refs').value = S.klein.refs;
  if (document.activeElement !== $('#k-prefix')) $('#k-prefix').value = S.klein.prefix;
  if (document.activeElement !== $('#k-ins')) $('#k-ins').value = S.klein.instruction;

  const host = $('#kfrom');
  host.innerHTML = '';
  S.doc.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'fr';
    const name = document.createElement('span');
    const text = item.label === 'text' && item.text
      ? `「${item.text.replace(/\n/g, ' ').slice(0, 10)}」` : '';
    name.textContent = `#${index + 1} ${KLABEL[item.label]}${text}`;
    name.title = name.textContent;
    const select = document.createElement('select');
    const options = ['target', ...Array.from({ length: S.klein.refs }, (_, n) => `ref_image_${n}`)];
    let current = S.klein.from[index] || 'target';
    if (!options.includes(current)) {
      current = 'target';
      if (S.klein.from[index]) S.klein.from[index] = 'target';
    }
    options.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'target'
        ? 'target 新造'
        : `ref ${Number(value.split('_').pop()) + 1}`;
      if (value === current) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      S.klein.from[index] = select.value;
      scheduleExport(60);
    });
    row.append(name, select);
    host.appendChild(row);
  });
}

function renderPortMap(res) {
  const host = $('#k-pmap');
  if (res.klein.task !== 'edit') {
    host.innerHTML = '';
    return;
  }
  const rows = res.klein.rows || [];
  const used = [...new Set(rows.filter((row) => row.from.startsWith('ref_image_')).map((row) => row.from))]
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
  const prefix = S.klein.prefix || 'ref_images.ref_image_';
  let html = '<p class="pnote"><b>参考图端口映射（提交前逐行核对）</b>：提示词里写 <code>&lt;Picture N&gt;</code>（从 1 数），'
    + '表格里的 <code>from</code> 是 <code>ref_image_N</code>（从 0 数）——两边差 1。</p>';
  html += '<table><thead><tr><th>提示词引用</th><th>表格 from</th><th>ComfyUI 端口</th>'
    + '<th>这个端口实际接哪张图（自己填）</th></tr></thead><tbody>';
  used.forEach((value) => {
    const n = Number(value.split('_').pop());
    html += `<tr><td class="mono">&lt;Picture ${n + 1}&gt;</td><td class="mono">${esc(value)}</td>`
      + `<td class="mono">${esc(prefix + n)}</td>`
      + `<td><input data-port="${esc(prefix + n)}" value="${esc(S.ports[prefix + n] || '')}" placeholder="例：input/ref-${n + 1}.png"></td></tr>`;
  });
  if (rows.some((row) => row.from === 'target')) {
    html += '<tr><td class="mono">—</td><td class="mono">target</td><td class="mono">不接图</td>'
      + '<td>本次新造，不占参考图端口</td></tr>';
  }
  html += '</tbody></table>';
  host.innerHTML = html;
}

function exportText() {
  const res = S.exportData;
  if (!res) return '';
  if (S.tab === 'moss') return res.formats.moss || '';
  if (S.tab === 'draft') return res.formats.draft || '';
  return res.klein.text || '';
}

/* ── 底图 ─────────────────────────────────────────────────────────────── */

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    toast('图片超过 12MB', 'error');
    return;
  }
  try {
    const dataUrl = await readDataURL(file);
    await api.uploadImage(S.id, { data_url: dataUrl, name: file.name });
    S.image = true;
    S.imageName = file.name;
    S.imageUrl = `${api.imageUrl(S.id)}?t=${Date.now()}`;
    renderCanvas();
    renderTop();
    renderLayers();
    renderInspector();
    toast('底图已叠上，用来对框', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clearImage() {
  try {
    await api.removeImage(S.id);
    S.image = false;
    S.imageName = '';
    S.imageUrl = '';
    renderCanvas();
    renderTop();
    renderLayers();
    renderInspector();
    toast('底图已移除', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ── 事件绑定 ─────────────────────────────────────────────────────────── */

function bind() {
  $('#btn-back').addEventListener('click', async () => {
    await leaveEditor();
    location.hash = '#/';
  });
  $('#b-save').addEventListener('click', () => save({ silent: false }));
  $('#b-export').addEventListener('click', openExport);
  $('#b-undo').addEventListener('click', undo);
  $('#b-redo').addEventListener('click', redo);
  $('#b-add').addEventListener('click', () => addItem('text'));
  $('#b-del').addEventListener('click', removeItem);
  $('#b-image').addEventListener('click', () => $('#file-image').click());
  $('#b-image-clear').addEventListener('click', clearImage);
  $('#file-image').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    await uploadImage(file);
  });
  $('#b-ask').addEventListener('click', async () => {
    const text = askText();
    if (await copyText(text)) toast('询问单已复制', 'ok');
  });
  $('#check-chip').addEventListener('click', openExport);

  $('#ename').addEventListener('input', (event) => {
    S.name = event.target.value;
    markChanged();
  });
  $('#ename').addEventListener('blur', () => {
    if (!S.name.trim()) {
      S.name = '未命名画布';
      $('#ename').value = S.name;
    }
    document.title = `${S.name} · Layout Studio`;
    save({ silent: true });
  });
  $('#ename').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  });

  // 整图描述
  bindText('#s-cap', () => S.doc.summary.caption, (value) => {
    S.doc.summary.caption = value;
    updateSummaryCount();
  }, null);
  $('#s-meta').addEventListener('change', (event) => {
    pushUndo();
    S.doc.summary.meta = event.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    renderSummary();
    markChanged();
  });
  $('#s-canvas').addEventListener('change', (event) => {
    pushUndo();
    S.doc.summary.canvas = event.target.value;
    renderSummary();
    markChanged();
  });
  $('#s-pal').addEventListener('change', (event) => {
    pushUndo();
    S.doc.summary.palette = event.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    renderSummary();
    markChanged();
  });
  $('#pal-add').addEventListener('click', () => {
    pushUndo();
    const palette = S.doc.summary.palette;
    palette.push(palette.length ? palette[palette.length - 1] : '#888888');
    renderSummary();
    markChanged();
  });

  // 画布尺寸
  $('#i-w').addEventListener('change', (event) => {
    const width = Math.max(16, Math.round((Number(event.target.value) || S.doc.width) / 16) * 16);
    resizeTo(width, S.doc.height);
  });
  $('#i-h').addEventListener('change', (event) => {
    const height = Math.max(16, Math.round((Number(event.target.value) || S.doc.height) / 16) * 16);
    resizeTo(S.doc.width, height);
  });
  $('#i-ratio').addEventListener('change', applyPreset);
  $('#i-mp').addEventListener('change', applyPreset);

  // 图层 / 空状态
  $('#cv').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add]');
    if (button) addItem(button.dataset.add);
  });
  $('#inspector').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add]');
    if (button) addItem(button.dataset.add);
    const align = event.target.closest('[data-align]');
    if (align) alignSelected(align.dataset.align);
  });

  // 检查器
  $('#i-type').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-label]');
    const item = currentItem();
    if (!button || !item) return;
    pushUndo();
    item.label = button.dataset.label;
    renderAll();
    markChanged();
  });
  bindText('#f-text', () => currentItem()?.text || '', (value) => {
    const item = currentItem();
    if (!item) return;
    item.text = value;
    $('#c-text').textContent = `${value.length} 字 / ${value.split('\n').length} 行`;
    updateBox(S.sel);
    renderLayers();
  }, () => {
    const item = currentItem();
    if (!item) return;
    $('#c-text').textContent = `${item.text.length} 字 / ${item.text.split('\n').length} 行`;
  });
  bindText('#f-cap', () => currentItem()?.caption || '', (value) => {
    const item = currentItem();
    if (!item) return;
    item.caption = value;
    updateBox(S.sel);
    renderLayers();
    renderOverlaps();
  }, null);
  $('#f-tags').addEventListener('change', (event) => {
    const item = currentItem();
    if (!item) return;
    pushUndo();
    item.tags = event.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    markChanged();
  });
  ['x1', 'y1', 'x2', 'y2'].forEach((key, index) => {
    $(`#f-${key}`).addEventListener('change', (event) => {
      const item = currentItem();
      if (!item) return;
      const value = Math.round(Number(event.target.value) || 0);
      pushUndo();
      const box = item.bbox.slice();
      box[index] = value;
      if (box[0] < box[2] && box[1] < box[3]
        && box[0] >= 0 && box[1] >= 0 && box[2] <= S.doc.width && box[3] <= S.doc.height) {
        item.bbox = box;
      }
      renderAll();
      markChanged();
    });
  });

  // 导出面板
  $('#exp-close').addEventListener('click', () => $('#export-dialog').close());
  $('#exp-done').addEventListener('click', () => $('#export-dialog').close());
  $('#export-dialog').addEventListener('click', (event) => {
    if (event.target === $('#export-dialog')) $('#export-dialog').close();
  });
  $('#exp-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    S.tab = button.dataset.tab;
    syncExportTabs();
    updateExportMsg();
  });
  $('#exp-copy').addEventListener('click', async () => {
    const text = exportText();
    if (!text) {
      toast('当前页签没有可复制的内容', 'error');
      return;
    }
    if (await copyText(text)) {
      $('#exp-msg').textContent = `已复制 ${text.length} 字符`;
    }
  });
  $('#exp-download').addEventListener('click', () => {
    const text = exportText();
    if (!text) {
      toast('当前页签没有可下载的内容', 'error');
      return;
    }
    const names = {
      moss: '-moss.txt', draft: '-draft.json', klein: '-klein.txt',
    };
    downloadText(`${slug(S.name)}${names[S.tab] || '.txt'}`, text);
    $('#exp-msg').textContent = `已下载 ${slug(S.name)}${names[S.tab] || '.txt'}`;
  });
  $$('input[name=ktask]').forEach((radio) => {
    radio.addEventListener('change', (event) => {
      S.klein.task = event.target.value;
      if (S.klein.task === 'edit') {
        S.doc.items.forEach((item, index) => {
          if (!S.klein.from[index]) S.klein.from[index] = 'ref_image_0';
        });
      }
      renderKleinConfig();
      refreshExport();
    });
  });
  $('#k-refs').addEventListener('change', (event) => {
    const refs = Math.max(1, Math.min(4, Number(event.target.value) || 1));
    S.klein.refs = refs;
    event.target.value = refs;
    renderKleinConfig();
    refreshExport();
  });
  $('#k-prefix').addEventListener('input', (event) => {
    S.klein.prefix = event.target.value;
    scheduleExport(160);
  });
  $('#k-pmap').addEventListener('input', (event) => {
    const port = event.target.dataset?.port;
    if (port) S.ports[port] = event.target.value;
  });
  $('#k-ins').addEventListener('input', (event) => {
    S.klein.instruction = event.target.value;
    scheduleExport(260);
  });

  // 汇总折叠
  const collapsed = localStorage.getItem('moss.summaryCollapsed') === '1';
  $('#scard').classList.toggle('collapsed', collapsed);
  $('#sc-body').hidden = collapsed;
  $('#sc-toggle').addEventListener('click', () => {
    const next = !$('#scard').classList.contains('collapsed');
    $('#scard').classList.toggle('collapsed', next);
    $('#sc-body').hidden = next;
    localStorage.setItem('moss.summaryCollapsed', next ? '1' : '0');
    requestAnimationFrame(fitCanvas);
  });

  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', (event) => {
    if (!S.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const stage = $('#stage');
  if (window.ResizeObserver) {
    new ResizeObserver(() => fitCanvas()).observe(stage);
  } else {
    window.addEventListener('resize', fitCanvas);
  }
}

function bindText(selector, get, apply, after) {
  const el = $(selector);
  if (!el) return;
  el.addEventListener('focus', () => {
    S.preEdit = snapshot();
  });
  el.addEventListener('input', () => {
    apply(el.value);
    if (after) after();
    markChanged();
  });
  el.addEventListener('blur', commitEdit);
}

function updateBox(index) {
  const item = S.doc.items[index];
  const el = $(`#cv .bx[data-i="${index}"]`);
  if (!item || !el) return;
  paintBox(el, item, index);
}

function isTyping(target) {
  const tag = (target?.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
}

function onKeydown(event) {
  if ($('#view-edit').hidden) return;
  if ($('#mini-dialog').open || $('#export-dialog').open) return;
  const typing = isTyping(event.target);
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save({ silent: false });
    return;
  }
  if (meta && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    openExport();
    return;
  }
  if (typing) return;

  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (!currentItem()) return;
    event.preventDefault();
    removeItem();
    return;
  }
  const item = currentItem();
  if (!item) return;
  const step = event.shiftKey ? 10 : 1;
  let delta = null;
  if (event.key === 'ArrowLeft') delta = [-step, 0];
  if (event.key === 'ArrowRight') delta = [step, 0];
  if (event.key === 'ArrowUp') delta = [0, -step];
  if (event.key === 'ArrowDown') delta = [0, step];
  if (!delta) return;
  event.preventDefault();
  pushUndo();
  item.bbox = clampBox([
    item.bbox[0] + delta[0], item.bbox[1] + delta[1],
    item.bbox[2] + delta[0], item.bbox[3] + delta[1],
  ]);
  renderAll();
  markChanged();
}
