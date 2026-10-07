'use strict';
const $ = id => document.getElementById(id);
const PROFILE_LIMIT = 4 * 1024 * 1024, TOKEN_LIMIT = 802816;
let db, worker, profile = null, stored = null, revision = null, requestID = 0;
let busy = false, generation = 0, inputVersion = 0, inspectVersion = 0, decryptTimer, toastTimer;
let lastSender = null, lastActivity = Date.now(), hiddenAt = null, editingContact = null;
const pending = new Map();

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function openDB() {
  return new Promise((resolve, reject) => {
    const path = new URL('./', location.href).pathname;
    const request = indexedDB.open('QuietChat-v1:' + path, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('profile');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Не удалось открыть хранилище. Откройте обычную вкладку Safari, без частного режима.'));
  });
}
function readRecord() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profile', 'readonly'), request = tx.objectStore('profile').get('vault');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Не удалось прочитать профиль.'));
  });
}
async function persist(envelope) {
  const expected = revision;
  try {
    const newRevision = await new Promise((resolve, reject) => {
      const tx = db.transaction('profile', 'readwrite'), store = tx.objectStore('profile');
      const request = store.get('vault'); let next, conflict = false;
      request.onsuccess = () => {
        const current = request.result;
        if ((current ? current.revision : null) !== expected) { conflict = true; tx.abort(); return; }
        next = (expected || 0) + 1; store.put({envelope, revision: next}, 'vault');
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = tx.onerror = () => reject(new Error(conflict
        ? 'Профиль изменён в другом окне. Откройте его снова здесь.'
        : 'Не удалось сохранить профиль. Проверьте свободное место. Последняя сохранённая копия не изменена.'));
    });
    stored = envelope; revision = newRevision;
  } catch (error) { await lock(false); throw error; }
}
function startWorker() {
  if (worker) return;
  worker = new Worker('./crypto-worker.js');
  worker.onmessage = ({data}) => {
    const task = pending.get(data.id); if (!task) return;
    pending.delete(data.id); clearTimeout(task.timer);
    data.error ? task.reject(new Error(data.error)) : task.resolve(data.value);
  };
  worker.onerror = () => {
    const message = 'Не удалось загрузить шифрование. Проверьте, что папка vendor загружена на GitHub.';
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); }
    pending.clear(); worker.terminate(); worker = null;
    if (profile) lock(false).then(() => toast(message));
  };
}
function call(operation, args = {}) {
  startWorker(); const id = ++requestID;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { lock(false).then(() => toast('Шифрование не ответило. Перезапустите приложение.')); }, 90000);
    pending.set(id, {resolve, reject, timer}); worker.postMessage({id, operation, args});
  });
}
async function action(button, fn, errorID) {
  if (busy) { toast('Дождитесь завершения текущего действия.'); return; }
  busy = true; const epoch = generation;
  const oldText = button.textContent; button.disabled = true; button.textContent = 'Подождите…';
  if (errorID) $(errorID).textContent = '';
  try { await fn(epoch); }
  catch (error) {
    if (epoch === generation) errorID ? $(errorID).textContent = error.message : toast(error.message);
    else if (error.message !== 'Профиль закрыт.') toast(error.message);
  } finally {
    busy = false; button.disabled = false; button.textContent = oldText;
    if (button.id === 'encrypt') button.disabled = !profile?.contacts.find(c => c.id === $('recipient').value)?.verified;
  }
}
async function gateMode() {
  const record = await readRecord();
  stored = record ? record.envelope : null; revision = record ? record.revision : null;
  $('gate-title').textContent = record ? 'С возвращением' : 'Начнём с ключа';
  $('gate-description').textContent = record ? 'Введите пароль своего профиля.' : 'Создайте пароль. Он защитит ваш ключ на этом iPhone.';
  $('confirmation').hidden = !!record; $('password-again').required = !record;
  $('password').minLength = record ? 1 : 12;
  $('password').autocomplete = record ? 'current-password' : 'new-password';
  $('password').placeholder = record ? 'Ваш пароль' : 'Не менее 12 символов';
  $('gate-submit').textContent = record ? 'Открыть профиль' : 'Создать профиль';
  $('restore').hidden = !!record;
  $('gate').hidden = false; $('gate-submit').disabled = false;
}
function renderProfile(selected) {
  const previous = selected || $('recipient').value;
  $('recipient').replaceChildren(); $('contact-list').replaceChildren();
  const contacts = [...profile.contacts].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!contacts.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Добавьте друга'; $('recipient').append(option);
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Здесь появятся сохранённые друзья.'; $('contact-list').append(empty);
  }
  for (const c of contacts) {
    const option = document.createElement('option'); option.value = c.id; option.textContent = c.name; $('recipient').append(option);
    const card = document.createElement('div'); card.className = 'card contact-item';
    const info = document.createElement('div'), name = document.createElement('strong'), status = document.createElement('p');
    name.textContent = c.name; status.className = 'small muted'; status.textContent = c.verified ? 'Отпечаток сверен' : 'Нужно сверить ключ';
    info.append(name, status);
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'Ключ';
    button.addEventListener('click', () => contactDialog(c)); card.append(info, button); $('contact-list').append(card);
  }
  if (contacts.some(c => c.id === previous)) $('recipient').value = previous;
  $('no-contacts').hidden = contacts.length !== 0; recipientChanged();
  $('my-card').value = profile.card; $('my-fingerprint').value = profile.fingerprint;
}
function enterProfile(value) {
  profile = value; lastActivity = Date.now();
  $('gate').hidden = true; $('workspace').hidden = false; $('navigation').hidden = false; $('lock').hidden = false;
  $('gate-form').reset(); $('gate-error').textContent = ''; renderProfile(); switchPanel('send');
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}
function switchPanel(name) {
  for (const node of document.querySelectorAll('.panel')) node.hidden = node.id !== name + '-panel';
  for (const button of document.querySelectorAll('[data-panel]')) {
    if (button.dataset.panel === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  window.scrollTo({top: 0});
}
function clearOutgoing() { $('outgoing').value = ''; $('outgoing-card').hidden = true; }
function recipientChanged() {
  clearOutgoing(); const c = profile?.contacts.find(c => c.id === $('recipient').value);
  $('recipient-status').textContent = c ? (c.verified ? 'Ключ сверен с другом' : 'Откройте «Друзья» и сверьте отпечаток') : 'Добавьте друга во вкладке «Друзья»';
  $('encrypt').disabled = !c || !c.verified;
}
function clearPlaintext() { $('plaintext').value = ''; $('sender').replaceChildren(); $('plaintext-card').hidden = true; lastSender = null; }
async function lock(announce = true) {
  generation++; inputVersion++; clearTimeout(decryptTimer); clearPlaintext(); clearOutgoing();
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Профиль закрыт.')); }
  pending.clear(); if (worker) { worker.terminate(); worker = null; }
  profile = null; $('draft').value = ''; $('incoming').value = ''; $('my-card').value = ''; $('my-fingerprint').value = '';
  $('contact-list').replaceChildren(); $('recipient').replaceChildren();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  for (const form of document.querySelectorAll('form')) form.reset();
  $('workspace').hidden = true; $('navigation').hidden = true; $('lock').hidden = true;
  try { await gateMode(); } catch (error) { $('boot-status').hidden = false; $('boot-status').textContent = error.message; }
  if (announce) toast('Профиль закрыт. Для чтения нужен пароль.');
}
function contactDialog(contact = null) {
  editingContact = contact; inspectVersion++;
  $('contact-form').reset(); $('contact-error').textContent = '';
  $('contact-title').textContent = contact ? 'Ключ друга' : 'Добавить друга';
  $('contact-name').value = contact?.name || ''; $('contact-card').value = contact?.public || '';
  $('contact-card').readOnly = !!contact; $('contact-verified').checked = !!contact?.verified;
  $('contact-fingerprint').value = ''; $('contact-dialog').showModal();
  if (contact) inspectCard(false);
}
async function inspectCard(reset = true) {
  const version = ++inspectVersion, text = $('contact-card').value;
  if (reset) $('contact-verified').checked = false;
  $('contact-fingerprint').value = ''; $('contact-error').textContent = '';
  if (!text.trim()) return;
  try {
    const value = await call('inspect', {card: text});
    if (version === inspectVersion && $('contact-dialog').open) $('contact-fingerprint').value = value.fingerprint;
  } catch (error) { if (version === inspectVersion) $('contact-error').textContent = error.message; }
}
async function copyField(id) {
  const field = $(id); if (!field.value) { toast('Сначала заполните это поле.'); return; }
  try { await navigator.clipboard.writeText(field.value); toast('Скопировано.'); }
  catch (_) {
    field.focus(); field.select();
    toast('Нажмите на выделенный текст и выберите «Скопировать».');
  }
}
async function pasteField(id) {
  const field = $(id); if (field.readOnly) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text.length > TOKEN_LIMIT) throw new Error('Содержимое буфера слишком большое.');
    field.setRangeText(text, field.selectionStart || 0, field.selectionEnd || 0, 'end');
    field.dispatchEvent(new Event('input', {bubbles: true})); field.focus();
  } catch (error) {
    field.focus();
    toast(error.message === 'Содержимое буфера слишком большое.' ? error.message : 'Удерживайте палец в поле и выберите «Вставить».');
  }
}
async function shareText(text, fieldID) {
  if (!text) return;
  if (navigator.share) {
    try { await navigator.share({text}); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  await copyField(fieldID);
}
function download(text, filename, mime) {
  const blob = new Blob([text], {type: mime}), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function saveFile(text, filename, mime) {
  const file = new File([text], filename, {type: mime});
  if (navigator.canShare?.({files: [file]})) {
    try { await navigator.share({files: [file]}); return true; }
    catch (error) { if (error.name === 'AbortError') return false; }
  }
  download(text, filename, mime); toast('Файл подготовлен. Сохраните его в «Файлы».'); return true;
}
async function decryptMessage(manual = false) {
  if (!profile) return;
  if (busy) { if (!manual) decryptTimer = setTimeout(() => decryptMessage(), 350); return; }
  const token = $('incoming').value, version = inputVersion;
  if (!token.trim()) { $('receive-status').textContent = 'После вставки расшифруем автоматически.'; return; }
  await action($('decrypt'), async epoch => {
    const value = await call('decrypt', {token});
    if (epoch !== generation) return;
    await persist(value.envelope);
    if (epoch !== generation || version !== inputVersion) return;
    const m = value.message; $('plaintext').value = m.text; lastSender = m.sender.id;
    const name = document.createElement('span'), meta = document.createElement('small');
    name.textContent = 'От: ' + m.sender.name;
    meta.textContent = new Date(m.sentAt).toLocaleString('ru-RU') + (m.duplicate ? ' · Уже читали' : '');
    $('sender').replaceChildren(name, meta); $('plaintext-card').hidden = false;
    $('receive-status').textContent = 'Подлинность сообщения проверена.';
  }, 'receive-status');
}
function incomingChanged() {
  inputVersion++; clearPlaintext(); clearTimeout(decryptTimer);
  $('receive-status').textContent = 'После вставки расшифруем автоматически.';
  if ($('incoming').value.trim()) decryptTimer = setTimeout(() => decryptMessage(), 400);
}

$('gate-form').addEventListener('submit', event => {
  event.preventDefault(); action($('gate-submit'), async epoch => {
    const record = await readRecord(); stored = record?.envelope || null; revision = record?.revision ?? null;
    const password = $('password').value;
    if (!record && password !== $('password-again').value) throw new Error('Пароли не совпадают.');
    const value = await call(record ? 'open' : 'create', {password, envelope: stored});
    if (epoch !== generation) return;
    if (!record) await persist(value.envelope);
    if (epoch === generation) { enterProfile(value.profile); if (!record) toast('Профиль создан. Сохраните резервную копию во вкладке «Профиль».'); }
  }, 'gate-error');
});
$('restore').addEventListener('click', () => { $('restore-form').reset(); $('restore-error').textContent = ''; $('restore-dialog').showModal(); });
$('restore-form').addEventListener('submit', event => {
  event.preventDefault(); action($('restore-submit'), async epoch => {
    const file = $('restore-file').files[0]; if (!file || file.size > PROFILE_LIMIT) throw new Error('Выберите копию размером до 4 МиБ.');
    if (await readRecord()) throw new Error('На этом устройстве уже есть профиль. Восстановление поверх него отключено.');
    const value = await call('open', {envelope: await file.text(), password: $('restore-password').value});
    if (epoch !== generation) return;
    revision = null; await persist(value.envelope);
    if (epoch === generation) { $('restore-dialog').close(); $('restore-form').reset(); enterProfile(value.profile); }
  }, 'restore-error');
});
$('lock').addEventListener('click', () => lock());
for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => switchPanel(button.dataset.panel));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', event => { event.preventDefault(); copyField(button.dataset.copy); });
for (const button of document.querySelectorAll('[data-paste]')) button.addEventListener('click', event => { event.preventDefault(); pasteField(button.dataset.paste); });
for (const id of ['open-key', 'settings-key']) $(id).addEventListener('click', () => $('key-dialog').showModal());
for (const id of ['add-contact', 'first-contact']) $(id).addEventListener('click', () => contactDialog());
$('contact-card').addEventListener('input', () => inspectCard());
$('contact-form').addEventListener('submit', event => {
  event.preventDefault(); action($('save-contact'), async epoch => {
    if (editingContact && $('contact-card').value !== editingContact.public) throw new Error('Создайте отдельный контакт для нового ключа.');
    const value = await call('contact', {name: $('contact-name').value, card: $('contact-card').value, verified: $('contact-verified').checked});
    if (epoch !== generation) return;
    await persist(value.envelope);
    if (epoch === generation) { profile = value.profile; renderProfile(value.contactID); $('contact-dialog').close(); toast('Контакт сохранён.'); }
  }, 'contact-error');
});
$('recipient').addEventListener('change', recipientChanged);
$('draft').addEventListener('input', () => { clearOutgoing(); $('text-size').textContent = (new TextEncoder().encode($('draft').value).length / 1024).toFixed(1) + ' / 64 КиБ'; });
$('encrypt').addEventListener('click', () => action($('encrypt'), async epoch => {
  const text = $('draft').value, contactID = $('recipient').value;
  const {token} = await call('encrypt', {text, contactID});
  if (epoch === generation && text === $('draft').value && contactID === $('recipient').value) {
    $('outgoing').value = token; $('outgoing-card').hidden = false;
    $('outgoing-card').scrollIntoView({block: 'nearest'});
  }
}));
$('share-message').addEventListener('click', () => shareText($('outgoing').value, 'outgoing'));
$('share-key').addEventListener('click', () => shareText($('my-card').value, 'my-card'));
$('save-message').addEventListener('click', () => { if ($('outgoing').value) saveFile($('outgoing').value + '\n', 'message.qcm', 'text/plain'); });
$('incoming').addEventListener('input', incomingChanged);
$('decrypt').addEventListener('click', () => { clearTimeout(decryptTimer); decryptMessage(true); });
$('clear-message').addEventListener('click', () => { $('incoming').value = ''; incomingChanged(); });
$('open-message').addEventListener('click', () => $('message-file').click());
$('message-file').addEventListener('change', async () => {
  const file = $('message-file').files[0]; if (!file) return;
  const epoch = generation;
  try {
    if (file.size > TOKEN_LIMIT) throw new Error('Файл сообщения слишком большой.');
    const text = await file.text();
    if (epoch === generation && profile) { $('incoming').value = text; incomingChanged(); }
  } catch (error) { toast(error.message); }
  $('message-file').value = '';
});
$('reply').addEventListener('click', () => { if (lastSender) { $('recipient').value = lastSender; recipientChanged(); switchPanel('send'); $('draft').focus(); } });
$('backup').addEventListener('click', () => action($('backup'), async epoch => {
  const {envelope} = await call('backup'); if (epoch !== generation) return;
  const sent = await saveFile(envelope + '\n', 'quietchat-' + new Date().toISOString().slice(0, 10) + '.qcbkp', 'application/json');
  if (sent) $('backup-note').textContent = 'Проверьте, что файл сохранён в «Файлы». Не пересылайте его другу.';
}));
$('change-password').addEventListener('click', () => { $('password-form').reset(); $('password-error').textContent = ''; $('password-dialog').showModal(); });
$('password-form').addEventListener('submit', event => {
  event.preventDefault(); action($('password-submit'), async epoch => {
    if ($('new-password').value !== $('new-password-again').value) throw new Error('Пароли не совпадают.');
    const value = await call('password', {password: $('new-password').value}); if (epoch !== generation) return;
    await persist(value.envelope);
    if (epoch === generation) { $('password-dialog').close(); $('password-form').reset(); toast('Пароль изменён. Сделайте новую резервную копию.'); }
  }, 'password-error');
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  for (const field of dialog.querySelectorAll('input[type=password]')) field.value = '';
});
for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, () => { lastActivity = Date.now(); }, {passive: true});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); }
  else if (profile && hiddenAt && Date.now() - hiddenAt >= 60000) lock();
});
setInterval(() => { if (profile && (Date.now() - lastActivity >= 300000 || (document.hidden && hiddenAt && Date.now() - hiddenAt >= 60000))) lock(); }, 10000);
window.addEventListener('pagehide', () => { if (profile) lock(false); });

let registration, updateRequested = false;
async function registerOffline() {
  if (!('serviceWorker' in navigator)) { $('offline-status').textContent = 'Работа без сети недоступна в этом браузере.'; return; }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', {scope: './', updateViaCache: 'none'});
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = 'Приложение сохранено для работы без интернета.';
    const checkWaiting = () => { $('apply-update').hidden = !registration.waiting; };
    checkWaiting();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', checkWaiting);
    });
  } catch (_) { $('offline-status').textContent = 'Автономная загрузка не завершилась. Откройте приложение при хорошем соединении.'; }
}
$('check-update').addEventListener('click', async () => {
  try { await registration?.update(); toast(registration?.waiting ? 'Обновление готово.' : 'Проверка завершена.'); $('apply-update').hidden = !registration?.waiting; }
  catch (_) { toast('Для проверки обновления нужен интернет.'); }
});
$('apply-update').addEventListener('click', async () => {
  if (!registration?.waiting) return;
  updateRequested = true;
  await lock(false); registration.waiting.postMessage({type: 'ACTIVATE'});
});
let reloading = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (registration?.active && !reloading && navigator.serviceWorker.controller) {
    // First installation does not reload an already open profile.
    if (updateRequested) {
      reloading = true; location.reload();
    }
  }
});

(async function boot() {
  if (!window.isSecureContext) { $('boot-status').textContent = 'Откройте сайт по HTTPS. Файл из архива нужно сначала разместить на GitHub Pages.'; return; }
  try {
    db = await openDB(); await call('ready'); await gateMode(); $('boot-status').hidden = true;
    registerOffline();
  } catch (error) { $('boot-status').textContent = error.message; $('boot-status').classList.add('error'); }
})();
