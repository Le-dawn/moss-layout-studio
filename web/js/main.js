import { $, initDialogs } from './ui.js';
import { mountList } from './list.js';
import { mountEditor, leaveEditor } from './editor.js';

initDialogs();

let current = '';

function show(view) {
  $('#view-list').hidden = view !== 'list';
  $('#view-edit').hidden = view !== 'edit';
  document.body.dataset.view = view;
}

async function route() {
  const match = location.hash.match(/^#\/e\/(\d+)/);
  if (match) {
    show('edit');
    current = 'edit';
    await mountEditor(Number(match[1]));
    return;
  }
  if (current === 'edit') await leaveEditor();
  show('list');
  current = 'list';
  document.title = 'MOSS Layout Studio · JSON 提示词画布';
  await mountList();
}

window.addEventListener('hashchange', route);

if (!location.hash) history.replaceState(null, '', '#/');
route();
