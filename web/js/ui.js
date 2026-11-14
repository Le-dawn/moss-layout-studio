export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const arr = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
};

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function toast(message, kind = 'ok') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<i></i><span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const diff = Date.now() - then.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < 45 * 1000) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.round(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.round(diff / day)} 天前`;
  const d = new Date(then);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 桌面窗口的桥（pywebview）；浏览器里访问时是 undefined。 */
function desktopApi() {
  return window.pywebview && window.pywebview.api ? window.pywebview.api : null;
}

export async function copyText(text) {
  if (!text) {
    toast('没有可复制的内容', 'error');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    area.remove();
    if (ok) return true;
    const desktop = desktopApi();
    if (desktop && desktop.copy_text) {
      try {
        if (await desktop.copy_text(text)) return true;
      } catch (e) {
        // 落到底下的 toast
      }
    }
    toast('复制失败，请手动选中', 'error');
    return false;
  }
}

export function downloadText(filename, text) {
  if (!text) {
    toast('没有可下载的内容', 'error');
    return;
  }
  // 桌面窗口里走原生「另存为」，浏览器里退回 blob 下载
  const desktop = desktopApi();
  if (desktop && desktop.save_text) {
    desktop.save_text(filename, text).then((saved) => {
      if (saved) toast(`已保存到 ${saved}`, 'ok');
    }).catch(() => fallbackDownload(filename, text));
    return;
  }
  fallbackDownload(filename, text);
}

function fallbackDownload(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/* ── 通用弹窗 ─────────────────────────────────────────────────────────── */

let dialogResolve = null;
let dialogResult = null;

function fieldHTML(field) {
  const hint = field.hint ? `<em>${esc(field.hint)}</em>` : '';
  const label = `<span>${esc(field.label)}${hint}</span>`;
  if (field.type === 'select') {
    const options = (field.options || []).map((opt) => {
      const value = typeof opt === 'string' ? opt : opt.value;
      const text = typeof opt === 'string' ? opt : opt.label;
      const selected = String(value) === String(field.value) ? ' selected' : '';
      return `<option value="${esc(value)}"${selected}>${esc(text)}</option>`;
    }).join('');
    return `<label class="field">${label}<select name="${esc(field.name)}">${options}</select></label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="field">${label}<textarea name="${esc(field.name)}" rows="${field.rows || 3}" placeholder="${esc(field.placeholder || '')}">${esc(field.value || '')}</textarea></label>`;
  }
  return `<label class="field">${label}<input name="${esc(field.name)}" type="${field.type || 'text'}" value="${esc(field.value || '')}" placeholder="${esc(field.placeholder || '')}" ${field.type === 'number' ? 'step="1"' : ''}></label>`;
}

export function formDialog({ title, message = '', fields = [], okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#mini-dialog');
    $('#mini-title').textContent = title;
    $('#mini-ok').textContent = okText;
    $('#mini-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#mini-cancel').textContent = cancelText;
    $('#mini-body').innerHTML = (message ? `<p>${message}</p>` : '') + fields.map(fieldHTML).join('');
    dialogResult = null;
    dialogResolve = resolve;
    dlg.returnValue = '';
    dlg.showModal();
    const first = $('#mini-body input, #mini-body textarea, #mini-body select');
    if (first) {
      setTimeout(() => {
        first.focus();
        if (first.select && first.type !== 'number') first.select();
      }, 40);
    }
  });
}

export const confirmDialog = (title, message, options = {}) => formDialog({
  title,
  message,
  okText: options.okText || '确定',
  cancelText: options.cancelText || '取消',
  danger: Boolean(options.danger),
});

export function initDialogs() {
  const dlg = $('#mini-dialog');
  const form = $('#mini-form');
  $('#mini-cancel').addEventListener('click', () => dlg.close('cancel'));
  $('#mini-close').addEventListener('click', () => dlg.close('cancel'));
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) dlg.close('cancel');
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = $$('#mini-body [name]');
    const result = {};
    for (const input of fields) result[input.name] = input.value.trim();
    dialogResult = result;
    dlg.close('ok');
  });
  dlg.addEventListener('close', () => {
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(dlg.returnValue === 'ok' ? (dialogResult || {}) : null);
  });
}

/* ── 浮动菜单 ─────────────────────────────────────────────────────────── */

let openMenuEl = null;
let menuOutside = null;

export function closeMenu() {
  if (menuOutside) {
    document.removeEventListener('pointerdown', menuOutside, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
    menuOutside = null;
  }
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

export function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  for (const item of items) {
    if (item.sep) {
      const line = document.createElement('div');
      line.className = 'msep';
      menu.appendChild(line);
      continue;
    }
    const button = document.createElement('button');
    button.className = `mi${item.danger ? ' danger' : ''}`;
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeMenu();
      item.onClick?.();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  openMenuEl = menu;

  menuOutside = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', menuOutside, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }, 0);
}

export const slug = (name) => String(name || 'layout')
  .trim()
  .replace(/[\\/:*?"<>|\s]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'layout';
