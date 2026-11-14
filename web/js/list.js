import { api } from './api.js';
import { COLORS, sizeFor } from './layout.js';
import {
  $, esc, toast, timeAgo, formDialog, confirmDialog, showMenu, downloadText, copyText, slug,
} from './ui.js';

let entries = [];
let query = '';
let bound = false;

export async function mountList() {
  if (!bound) bind();
  await refresh();
}

function bind() {
  bound = true;
  $('#btn-new').addEventListener('click', createLayout);
  $('#btn-empty-new').addEventListener('click', createLayout);
  $('#btn-example').addEventListener('click', loadExample);
  $('#btn-import').addEventListener('click', () => $('#file-json').click());
  $('#file-json').addEventListener('change', importFile);
  $('#search').addEventListener('input', (event) => {
    query = event.target.value.trim();
    render();
  });
  $('#grid').addEventListener('click', onGridClick);
  $('#grid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('.dots')) return;
    const card = event.target.closest('.card');
    if (!card) return;
    event.preventDefault();
    openLayout(Number(card.dataset.id));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || $('#view-list').hidden) return;
    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    event.preventDefault();
    $('#search').focus();
  });
  // 桌面窗口里没有浏览器标签页：REST API 链接会让窗口变成一堆 JSON，藏掉
  if (!setupDesktop()) {
    window.addEventListener('pywebviewready', () => setupDesktop(), { once: true });
  }
  api.health().then((info) => {
    $('#store-path').textContent = `${info.data || '本地数据'} · SQLite`;
    $('#store-path').title = info.data || '';
  }).catch(() => {
    $('#store-path').textContent = '本地数据 · SQLite';
  });
}

function setupDesktop() {
  if (!window.pywebview) return false;
  const link = $('#link-api');
  if (link) link.hidden = true;
  return true;
}

async function refresh() {
  try {
    const res = await api.list();
    entries = res.layouts || [];
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function render() {
  const needle = query.toLowerCase();
  const filtered = needle
    ? entries.filter((entry) => `${entry.name} ${entry.caption}`.toLowerCase().includes(needle))
    : entries;

  const totalItems = entries.reduce((sum, entry) => sum + entry.item_count, 0);
  $('#stats').textContent = entries.length ? `${entries.length} 份 · ${totalItems} 个元素` : '';

  $('#grid').innerHTML = filtered.map(cardHTML).join('');
  $('#grid').hidden = !filtered.length;
  $('#empty').hidden = Boolean(filtered.length);

  if (!filtered.length) {
    const title = $('#empty h2');
    const text = $('#empty p');
    const actions = $('.empty-actions');
    if (!entries.length) {
      title.textContent = '还没有草稿';
      text.textContent = '新建一张空白画布，或把已有的 layout JSON 导进来。';
      actions.hidden = false;
    } else {
      title.textContent = '没有匹配的草稿';
      text.textContent = '换个关键词，或者清空搜索。';
      actions.hidden = true;
    }
  }
}

function cardHTML(entry) {
  const caption = entry.caption ? esc(entry.caption) : '还没有整图描述';
  return `<article class="card" data-id="${entry.id}" tabindex="0" role="button" aria-label="${esc(entry.name)}">
    <div class="thumb">${thumb(entry)}</div>
    <div class="card-body">
      <div class="ctop">
        <h3>${esc(entry.name)}</h3>
        <button class="dots" data-menu="${entry.id}" title="更多操作" aria-label="更多操作">⋯</button>
      </div>
      <p class="ccap${entry.caption ? '' : ' is-empty'}">${caption}</p>
      <div class="cmeta">
        <span>${entry.width}×${entry.height}</span>
        <i class="dotsep"></i>
        <span>${entry.item_count} 个元素</span>
        <i class="dotsep"></i>
        <span>${timeAgo(entry.updated_at)}</span>
        ${entry.has_image ? '<span class="badge">有底图</span>' : ''}
      </div>
    </div>
  </article>`;
}

function thumb(entry) {
  const width = entry.width || 1024;
  const height = entry.height || 1024;
  const pad = 0.075;
  const stroke = Math.max(1, width / 800);
  const viewBox = `${-width * pad} ${-height * pad} ${width * (1 + pad * 2)} ${height * (1 + pad * 2)}`;

  const rects = (entry.items || []).slice(0, 80).map((item) => {
    const box = (item.bbox || []).map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return '';
    const x1 = Math.max(0, Math.min(width, box[0]));
    const y1 = Math.max(0, Math.min(height, box[1]));
    const x2 = Math.max(0, Math.min(width, box[2]));
    const y2 = Math.max(0, Math.min(height, box[3]));
    if (x2 <= x1 || y2 <= y1) return '';
    const color = COLORS[item.label] || '#8b95a5';
    const ground = (x2 - x1) >= width * 0.9 && (y2 - y1) >= height * 0.9;
    return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="${width * 0.005}" fill="${color}" fill-opacity="${ground ? 0.05 : 0.15}" stroke="${color}" stroke-opacity="${ground ? 0.35 : 0.8}" stroke-width="${stroke}"/>`;
  }).join('');

  const empty = (entry.items || []).length ? '' : `<text x="${width / 2}" y="${height / 2 + width * 0.008}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="${Math.max(12, width * 0.024)}" letter-spacing="${width * 0.005}" fill="#b6bdc9">EMPTY</text>`;

  return `<svg class="mini" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs>
      <pattern id="grid${entry.id}" width="${width / 10}" height="${height / 10}" patternUnits="userSpaceOnUse">
        <path d="M ${width / 10} 0 L 0 0 0 ${height / 10}" fill="none" stroke="#2c5a96" stroke-opacity="0.12" stroke-width="${stroke}"/>
      </pattern>
      <filter id="shadow${entry.id}" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="${height * 0.012}" stdDeviation="${width * 0.018}" flood-color="#000" flood-opacity="0.6"/>
      </filter>
    </defs>
    <rect width="${width}" height="${height}" fill="#fbfaf6" filter="url(#shadow${entry.id})"/>
    <rect width="${width}" height="${height}" fill="url(#grid${entry.id})"/>
    ${rects}${empty}
  </svg>`;
}

function findEntry(id) {
  return entries.find((entry) => entry.id === id);
}

function openLayout(id) {
  location.hash = `#/e/${id}`;
}

function onGridClick(event) {
  const dots = event.target.closest('.dots');
  const card = event.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  if (dots) {
    event.preventDefault();
    event.stopPropagation();
    openCardMenu(dots, id);
    return;
  }
  openLayout(id);
}

function openCardMenu(anchor, id) {
  const entry = findEntry(id);
  if (!entry) return;
  showMenu(anchor, [
    { label: '打开', onClick: () => openLayout(id) },
    { sep: true },
    { label: '重命名', onClick: () => renameLayout(entry) },
    { label: '复制一份', onClick: () => duplicateLayout(entry) },
    { label: '复制 MOSS 提示词', onClick: () => copyPrompt(entry) },
    { label: '下载草稿 JSON', onClick: () => downloadDraft(entry) },
    { sep: true },
    { label: '删除', danger: true, onClick: () => removeLayout(entry) },
  ]);
}

async function createLayout() {
  const values = await formDialog({
    title: '新建画布',
    fields: [
      { name: 'name', label: '名称', value: '未命名画布', placeholder: '比如：春季新品海报' },
      {
        name: 'ratio',
        label: '比例',
        type: 'select',
        value: '3:4',
        options: [
          ['1:1', '1:1 方图'], ['4:3', '4:3 横图'], ['3:4', '3:4 竖图'],
          ['16:9', '16:9 宽屏'], ['9:16', '9:16 手机'], ['21:9', '21:9 长横幅'],
          ['1:8', '1:8 条漫'], ['3:2', '3:2 横构图'], ['2:3', '2:3 竖构图'],
        ].map(([value, label]) => ({ value, label })),
      },
      {
        name: 'mp',
        label: '目标像素',
        type: 'select',
        value: '1.5',
        options: [
          { value: '1', label: '1 MP' },
          { value: '1.5', label: '1.5 MP' },
          { value: '2', label: '2 MP' },
          { value: '4', label: '4 MP' },
        ],
      },
    ],
    okText: '创建',
  });
  if (!values) return;
  const size = sizeFor(values.ratio, Number(values.mp));
  try {
    const res = await api.create({
      name: values.name || '未命名画布',
      width: size[0],
      height: size[1],
    });
    openLayout(res.layout.id);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadExample() {
  try {
    const example = await api.example();
    const res = await api.create({ name: example.name, doc: example.doc });
    toast('示例已载入', 'ok');
    openLayout(res.layout.id);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function importFile(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;

  const parsedFiles = [];
  for (const file of files) {
    const text = await file.text();
    try {
      parsedFiles.push({ file, text, data: JSON.parse(text) });
    } catch (error) {
      toast(`${file.name} 解析失败：${error.message}`, 'error');
      return;
    }
  }

  const isNotes = (data) => Boolean(
    data && typeof data === 'object' && data.summary_zh !== undefined && !data.summary
    && (!Array.isArray(data.items)
      || data.items.every((item) => item && item.bbox === undefined && item.caption_zh !== undefined)),
  );
  const draft = parsedFiles.find((entry) => !isNotes(entry.data) && entry.data && typeof entry.data === 'object');
  const notes = parsedFiles.find((entry) => isNotes(entry.data));
  if (!draft) {
    toast('只找到旧的 .notes.json，请把草稿 JSON 一起选中', 'error');
    return;
  }

  const name = draft.file.name
    .replace(/\.json$/i, '')
    .replace(/\.(draft|layout|prompt)$/i, '');

  let size = {};
  if (draft.data?.bbox_coord_space === 'abs_centralized' && !draft.data.width) {
    const values = await formDialog({
      title: '这份是编译稿',
      message: '编译稿的坐标以画布中心为原点，本身不带尺寸。填一下原画布大小，才能换回左上原点。',
      fields: [
        { name: 'width', label: '画布宽', type: 'number', value: '1152' },
        { name: 'height', label: '画布高', type: 'number', value: '1536' },
      ],
      okText: '继续导入',
    });
    if (!values) return;
    size = {
      width: Math.max(16, Math.round((Number(values.width) || 1152) / 16) * 16),
      height: Math.max(16, Math.round((Number(values.height) || 1536) / 16) * 16),
    };
  }

  try {
    const res = await api.importJson({
      name,
      json: draft.text,
      notes: notes ? notes.data : undefined,
      ...size,
    });
    await refresh();
    if (res.warnings?.length) toast(res.warnings[0], 'ok');
    else if (notes) toast('草稿和中文参考一起导入了（中文已并进图层描述）', 'ok');
    openLayout(res.layout.id);
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
  }
}

async function renameLayout(entry) {
  const values = await formDialog({
    title: '重命名',
    fields: [{ name: 'name', label: '名称', value: entry.name }],
    okText: '保存',
  });
  if (!values || !values.name) return;
  try {
    await api.update(entry.id, { name: values.name });
    await refresh();
    toast('已重命名', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function duplicateLayout(entry) {
  try {
    await api.duplicate(entry.id);
    await refresh();
    toast('已复制一份', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyPrompt(entry) {
  try {
    const record = await api.get(entry.id);
    const res = await api.compile({ doc: record.layout.doc });
    if (res.validation.errors.length) {
      toast(res.validation.errors[0], 'error');
      return;
    }
    if (await copyText(res.formats.moss)) toast('MOSS 提示词已复制', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadDraft(entry) {
  try {
    const record = await api.get(entry.id);
    const res = await api.compile({ doc: record.layout.doc });
    downloadText(`${slug(entry.name)}-draft.json`, res.formats.draft);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeLayout(entry) {
  const ok = await confirmDialog(
    '删除这份草稿？',
    `「${esc(entry.name)}」将被永久删除，不能恢复。`,
    { okText: '删除', danger: true },
  );
  if (!ok) return;
  try {
    await api.remove(entry.id);
    await refresh();
    toast('已删除', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}
