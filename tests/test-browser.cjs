'use strict';
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {webkit, devices} = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.QC_TEST_ARTIFACTS || path.join(require('node:os').tmpdir(), 'quietchat-browser-check');
fs.mkdirSync(artifacts, {recursive: true});
const requests = [], errors = [];
let networkDisabled = false;
const types = {'.js': 'application/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png'};
const server = http.createServer((req, res) => {
  requests.push({method: req.method, url: req.url});
  if (networkDisabled) { req.socket.destroy(); return; }
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!pathname.startsWith('/quietchat-test/')) { res.writeHead(404); res.end(); return; }
  const filename = path.resolve(root, pathname.slice('/quietchat-test/'.length) || 'index.html');
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, {'Content-Type': types[path.extname(filename)] || 'text/plain', 'Cache-Control': 'no-cache'}); res.end(fs.readFileSync(filename)); }
  catch (_) { res.writeHead(404); res.end(); }
});
const wait = async (page, expression, arg) => page.waitForFunction(expression, arg, {timeout: 30000});
async function context(browser) {
  const ctx = await browser.newContext({...devices['iPhone 13'], acceptDownloads: true});
  await ctx.addInitScript(() => {
    window.__clip = ''; window.__share = null; window.__clipboardDenied = false;
    Object.defineProperty(navigator, 'clipboard', {value: {
      writeText: async text => { if (window.__clipboardDenied) throw new Error('Denied'); window.__clip = text; },
      readText: async () => { if (window.__clipboardDenied) throw new Error('Denied'); return window.__clip; }
    }});
    Object.defineProperty(navigator, 'share', {value: async data => { window.__share = data; }});
    Object.defineProperty(navigator, 'canShare', {value: () => false});
  });
  const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message));
  return {ctx, page};
}
async function create(page, url, password) {
  await page.goto(url); await page.locator('#gate').waitFor({state: 'visible', timeout: 30000});
  await page.locator('#password').fill(password); await page.locator('#password-again').fill(password);
  await page.locator('#gate-submit').click(); await page.locator('#workspace').waitFor({state: 'visible', timeout: 30000});
  await page.locator('#open-key').click(); const key = await page.locator('#my-card').inputValue();
  const fp = await page.locator('#my-fingerprint').inputValue();
  await page.locator('[data-copy="my-card"]').click(); assert.equal(await page.evaluate(() => window.__clip), key);
  await page.locator('[data-close="key-dialog"]').click();
  return {key, fp};
}
async function contact(page, name, key, fp, verified = true) {
  await page.locator('[data-panel="contacts"]').click(); await page.locator('#add-contact').click();
  await page.locator('#contact-name').fill(name);
  await page.evaluate(text => { window.__clip = text; }, key);
  await page.locator('[data-paste="contact-card"]').click();
  await wait(page, fp => document.getElementById('contact-fingerprint').value === fp, fp);
  if (verified) await page.locator('#contact-verified').check();
  await page.locator('#save-contact').click(); await page.locator('#contact-dialog').waitFor({state: 'hidden'});
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/quietchat-test/`;
  const browser = await webkit.launch(process.env.QC_WEBKIT_EXECUTABLE ? {executablePath: process.env.QC_WEBKIT_EXECUTABLE} : {});
  try {
    const alice = await context(browser), bob = await context(browser);
    const alicePassword = 'Alice browser test password 123456', bobPassword = 'Bob browser test password 123456';
    const a = await create(alice.page, url, alicePassword), b = await create(bob.page, url, bobPassword);
    await alice.page.screenshot({path: path.join(artifacts, 'iphone-start.png'), fullPage: true});
    await alice.page.locator('[data-panel="contacts"]').click(); await alice.page.locator('#add-contact').click();
    await alice.page.locator('#contact-card').fill('QCK1:random');
    await wait(alice.page, () => document.getElementById('contact-error').textContent.length > 0);
    await alice.page.locator('[data-close="contact-dialog"]').click();
    await contact(alice.page, 'Боб', b.key, b.fp, false);
    await alice.page.locator('[data-panel="send"]').click(); assert(await alice.page.locator('#encrypt').isDisabled());
    await alice.page.locator('[data-panel="contacts"]').click(); await alice.page.locator('#contact-list button').click();
    assert(await alice.page.locator('#contact-card').evaluate(el => el.readOnly));
    await alice.page.locator('#contact-verified').check(); await alice.page.locator('#save-contact').click();
    await alice.page.locator('#contact-dialog').waitFor({state: 'hidden'});
    await contact(bob.page, 'Алиса', a.key, a.fp);
    await alice.page.locator('[data-panel="send"]').click();
    const text = 'Привет с iPhone! 🔐\nНаш текст <img src=x onerror=alert(1)>.';
    await alice.page.evaluate(text => { window.__clip = text; }, text);
    await alice.page.locator('[data-paste="draft"]').click(); assert.equal(await alice.page.locator('#draft').inputValue(), text);
    await alice.page.locator('#encrypt').click(); await alice.page.locator('#outgoing-card').waitFor({state: 'visible'});
    const token = await alice.page.locator('#outgoing').inputValue(); assert(token.startsWith('QC1:'));
    await alice.page.locator('[data-copy="outgoing"]').click(); assert.equal(await alice.page.evaluate(() => window.__clip), token);
    await alice.page.locator('#share-message').click(); assert.equal(await alice.page.evaluate(() => window.__share.text), token);
    await alice.page.screenshot({path: path.join(artifacts, 'iphone-send.png'), fullPage: true});
    const messageDownload = alice.page.waitForEvent('download'); await alice.page.locator('#save-message').click();
    const msg = await messageDownload; await msg.saveAs(path.join(artifacts, 'message.qcm'));
    assert.equal(fs.readFileSync(path.join(artifacts, 'message.qcm'), 'utf8').trim(), token);
    await bob.page.locator('[data-panel="receive"]').click();
    await bob.page.evaluate(text => { window.__clip = text; }, token); await bob.page.locator('[data-paste="incoming"]').click();
    await bob.page.locator('#plaintext-card').waitFor({state: 'visible', timeout: 30000});
    assert.equal(await bob.page.locator('#plaintext').inputValue(), text);
    await bob.page.locator('[data-copy="plaintext"]').click(); assert.equal(await bob.page.evaluate(() => window.__clip), text);
    await bob.page.screenshot({path: path.join(artifacts, 'iphone-read.png'), fullPage: true});
    await bob.page.evaluate(() => { window.__clipboardDenied = true; });
    await bob.page.locator('[data-copy="plaintext"]').click();
    assert.equal(await bob.page.locator('#plaintext').evaluate(el => el.selectionEnd - el.selectionStart), text.length);
    await bob.page.evaluate(() => { window.__clipboardDenied = false; });
    const envelope = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString());
    const raw = Buffer.from(envelope.box, 'base64url'); raw[raw.length - 1] ^= 1; envelope.box = raw.toString('base64url');
    const tampered = 'QC1:' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
    await bob.page.locator('#incoming').fill(tampered);
    assert.equal(await bob.page.locator('#plaintext').inputValue(), '');
    await wait(bob.page, () => document.getElementById('receive-status').textContent.includes('подлинности не пройдена'));
    await bob.page.locator('#incoming').fill(token); await bob.page.locator('#plaintext-card').waitFor({state: 'visible'});
    assert((await bob.page.locator('#sender').innerText()).includes('Уже читали'));
    await alice.page.locator('[data-panel="settings"]').click();
    const downloadEvent = alice.page.waitForEvent('download'); await alice.page.locator('#backup').click();
    const backup = await downloadEvent; const backupPath = path.join(artifacts, 'alice.qcbkp'); await backup.saveAs(backupPath);
    const encryptedProfile = fs.readFileSync(backupPath, 'utf8');
    assert(!encryptedProfile.includes('Боб')); assert(!encryptedProfile.includes(text)); assert(!encryptedProfile.includes(alicePassword));
    await alice.page.locator('#change-password').click();
    await alice.page.locator('#new-password').fill('New Alice password 123456');
    await alice.page.locator('#new-password-again').fill('New Alice password 123456');
    await alice.page.locator('#password-submit').click(); await alice.page.locator('#password-dialog').waitFor({state: 'hidden'});
    await alice.page.locator('#lock').click(); await alice.page.locator('#gate').waitFor({state: 'visible'});
    assert.equal(await alice.page.locator('#draft').inputValue(), ''); assert.equal(await alice.page.locator('#outgoing').inputValue(), '');
    await alice.page.locator('#password').fill('wrong password'); await alice.page.locator('#gate-submit').click();
    await wait(alice.page, () => document.getElementById('gate-error').textContent.includes('Неверный пароль'));
    await alice.page.locator('#password').fill('New Alice password 123456'); await alice.page.locator('#gate-submit').click();
    await alice.page.locator('#workspace').waitFor({state: 'visible'});
    await alice.page.locator('#open-key').click(); assert.equal(await alice.page.locator('#my-card').inputValue(), a.key);
    await alice.page.locator('[data-close="key-dialog"]').click();
    const restored = await context(browser); await restored.page.goto(url); await restored.page.locator('#gate').waitFor({state: 'visible'});
    await restored.page.locator('#restore').click(); await restored.page.locator('#restore-file').setInputFiles(backupPath);
    await restored.page.locator('#restore-password').fill(alicePassword); await restored.page.locator('#restore-submit').click();
    await restored.page.locator('#workspace').waitFor({state: 'visible'});
    await restored.page.locator('#open-key').click(); assert.equal(await restored.page.locator('#my-card').inputValue(), a.key);
    await restored.page.locator('[data-close="key-dialog"]').click();
    await wait(alice.page, () => !!navigator.serviceWorker.controller);
    console.log('Cache contents:', await alice.page.evaluate(async () => {
      const result = {};
      for (const name of await caches.keys()) result[name] = (await (await caches.open(name)).keys()).map(request => request.url);
      return result;
    }));
    networkDisabled = true; await alice.page.reload();
    await alice.page.locator('#gate').waitFor({state: 'visible', timeout: 30000});
    await alice.page.locator('#password').fill('New Alice password 123456'); await alice.page.locator('#gate-submit').click();
    await alice.page.locator('#workspace').waitFor({state: 'visible'});
    await alice.page.locator('#draft').fill('Шифруется без сети'); await alice.page.locator('#encrypt').click();
    await alice.page.locator('#outgoing-card').waitFor({state: 'visible'});
    assert((await alice.page.locator('#outgoing').inputValue()).startsWith('QC1:'));
    networkDisabled = false;
    for (const width of [320, 390, 430, 1024]) {
      await alice.page.setViewportSize({width, height: 844});
      for (const panel of ['send', 'receive', 'contacts', 'settings']) {
        await alice.page.locator(`[data-panel="${panel}"]`).click();
        assert(await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow: ${panel} at ${width}`);
      }
    }
    // A second open page cannot overwrite a newer saved profile.
    const other = await alice.ctx.newPage(); other.on('pageerror', error => errors.push(error.message));
    await other.goto(url); await other.locator('#gate').waitFor({state: 'visible'});
    await other.locator('#password').fill('New Alice password 123456'); await other.locator('#gate-submit').click();
    await other.locator('#workspace').waitFor({state: 'visible'});
    await other.locator('[data-panel="contacts"]').click(); await other.locator('#contact-list button').click();
    await other.locator('#contact-name').fill('Боб обновлён'); await other.locator('#save-contact').click();
    await other.locator('#contact-dialog').waitFor({state: 'hidden'});
    await alice.page.locator('[data-panel="contacts"]').click(); await alice.page.locator('#contact-list button').click();
    await alice.page.locator('#contact-name').fill('Устаревшее имя'); await alice.page.locator('#save-contact').click();
    await alice.page.locator('#gate').waitFor({state: 'visible'});
    await alice.page.locator('#password').fill('New Alice password 123456'); await alice.page.locator('#gate-submit').click();
    await alice.page.locator('#workspace').waitFor({state: 'visible'});
    await alice.page.locator('[data-panel="contacts"]').click();
    assert((await alice.page.locator('#contact-list').innerText()).includes('Боб обновлён'));
    await alice.page.evaluate(() => { lastActivity = Date.now() - 300001; });
    await alice.page.locator('#gate').waitFor({state: 'visible', timeout: 15000});
    await other.close();
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert(requests.every(req => req.method === 'GET' && req.url.startsWith('/quietchat-test/')));
    console.log('WebKit iPhone UI OK: profile, key, verified contacts, paste/copy/share, tamper/replay, backup/restore, password, lock, offline reload, widths 320–1024, concurrent-write protection, inactivity lock.');
    console.log('Share sheet and clipboard calls mocked; native iPhone installation remains a device check.');
  } catch (error) {
    let index = 0;
    for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
      console.error('Page state:', (await page.locator('body').innerText()).slice(0, 1800));
      await page.screenshot({path: path.join(artifacts, 'failure-' + index++ + '.png'), fullPage: true});
    }
    console.error('Page errors:', errors); throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
