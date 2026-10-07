/* QuietChat v1 wire format. All cryptographic primitives come from libsodium. */
(function (scope) {
  'use strict';
  const MAX_TEXT = 65536, MAX_BOX = MAX_TEXT * 6 + 4096;
  const MAX_TOKEN = MAX_BOX * 2 + 8192, MAX_PROFILE = 4 * 1024 * 1024;
  const OPS = 3, MEMORY = 64 * 1024 * 1024;
  const ID = /^[0-9a-f]{64}$/, MID = /^[0-9a-f]{32}$/;
  class UserError extends Error {}
  const fail = text => { throw new UserError(text); };
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fields = (v, names) => object(v) && Object.keys(v).sort().join('|') === [...names].sort().join('|');
  const json = v => JSON.stringify(v);
  function createCore(s) {
    const b64 = bytes => s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
    const bytes = text => {
      if (typeof text !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
        fail('Текст содержит некорректные символы.');
      return s.from_string(text);
    };
    function unb64(value, maximum = MAX_BOX, size) {
      if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value))
        fail('Повреждена кодировка или превышен размер данных.');
      let raw;
      try { raw = s.from_base64(value, s.base64_variants.URLSAFE_NO_PADDING); }
      catch (_) { fail('Повреждена кодировка данных.'); }
      if (raw.length > maximum || (size !== undefined && raw.length !== size) || b64(raw) !== value)
        fail('Некорректная длина данных.');
      return raw;
    }
    function parse(data) {
      let result;
      try { result = JSON.parse(typeof data === 'string' ? data : s.to_string(data)); }
      catch (_) { fail('Не удалось прочитать формат данных.'); }
      if (!object(result) || result.v !== 1) fail('Неподдерживаемый формат данных.');
      return result;
    }
    const concat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
    const keyID = pub => s.to_hex(s.crypto_hash_sha256(concat(bytes('QuietChat/public/v1\0'), pub)));
    const fingerprint = pub => keyID(pub).toUpperCase().match(/.{4}/g).join(' ');
    const card = pub => 'QCK1:' + b64(pub) + '.' + keyID(pub).slice(0, 12);
    function readCard(text) {
      if (typeof text !== 'string' || text.length > 2048) fail('Вставьте полный публичный ключ друга.');
      const value = text.replace(/\s/g, '');
      if (!value.startsWith('QCK1:')) fail('Публичный ключ должен начинаться с QCK1:.');
      const parts = value.slice(5).split('.');
      if (parts.length !== 2) fail('Скопируйте ключ целиком, вместе с проверочным кодом.');
      const pub = unb64(parts[0], 32, 32);
      if (parts[1] !== keyID(pub).slice(0, 12)) fail('В публичном ключе ошибка. Скопируйте его заново.');
      const secret = s.randombytes_buf(32);
      try { s.memzero(s.crypto_box_beforenm(pub, secret)); }
      catch (_) { fail('Этот публичный ключ нельзя использовать.'); }
      finally { s.memzero(secret); }
      return pub;
    }
    function passwordBytes(password, fresh = false) {
      const raw = bytes(password);
      if (!raw.length || raw.length > 1024 || (fresh && [...password].length < 12)) {
        s.memzero(raw);
        fail('Пароль: не менее 12 символов при создании и не более 1024 байт.');
      }
      return raw;
    }
    function derive(password, salt, fresh = false) {
      const raw = passwordBytes(password, fresh);
      try { return s.crypto_pwhash(32, raw, salt, OPS, MEMORY, s.crypto_pwhash_ALG_ARGON2ID13); }
      catch (_) { fail('Не хватило памяти для защиты профиля. Закройте другие вкладки и попробуйте снова.'); }
      finally { s.memzero(raw); }
    }
    function pack(document, storageKey, salt) {
      const nonce = s.randombytes_buf(24), plain = bytes(json(document));
      try {
        const box = concat(nonce, s.crypto_secretbox_easy(plain, nonce, storageKey));
        const envelope = json({v: 1, kdf: 'argon2id', ops: OPS, mem: MEMORY, salt: b64(salt), box: b64(box)});
        if (bytes(envelope).length > MAX_PROFILE) fail('Профиль превысил допустимый размер.');
        return envelope;
      } finally { s.memzero(plain); }
    }
    function validateDocument(doc) {
      if (!fields(doc, ['v', 'private', 'contacts', 'seen']) || doc.v !== 1) fail('Повреждён профиль.');
      const privateKey = unb64(doc.private, 32, 32);
      const pub = s.crypto_scalarmult_base(privateKey), ownID = keyID(pub);
      try {
        if (!object(doc.contacts) || Object.keys(doc.contacts).length > 100) fail('Повреждён список контактов.');
        const names = new Set();
        for (const [id, c] of Object.entries(doc.contacts)) {
          if (!fields(c, ['name', 'public', 'verified']) || typeof c.name !== 'string' || !c.name.trim()
              || [...c.name].length > 60 || /[\x00-\x1f]/.test(c.name) || typeof c.verified !== 'boolean')
            fail('Повреждена запись контакта.');
          const publicKey = readCard(c.public), name = c.name.toLocaleLowerCase('und');
          if (!ID.test(id) || id === ownID || id !== keyID(publicKey) || names.has(name)) fail('Повреждён ключ контакта.');
          names.add(name);
        }
        if (!Array.isArray(doc.seen) || doc.seen.length > 10000 || doc.seen.some(x => typeof x !== 'string' || !ID.test(x))
            || new Set(doc.seen).size !== doc.seen.length) fail('Повреждён список прочитанных сообщений.');
        return {document: doc, privateKey, publicKey: pub, id: ownID};
      } catch (error) { s.memzero(privateKey); throw error; }
    }
    function open(envelopeText, password) {
      if (typeof envelopeText !== 'string' || bytes(envelopeText).length > MAX_PROFILE) fail('Файл профиля слишком большой.');
      const e = parse(envelopeText);
      if (!fields(e, ['v', 'kdf', 'ops', 'mem', 'salt', 'box']) || e.kdf !== 'argon2id' || e.ops !== OPS || e.mem !== MEMORY)
        fail('Неподдерживаемые параметры защиты профиля.');
      const salt = unb64(e.salt, 16, 16), encrypted = unb64(e.box, MAX_PROFILE);
      if (encrypted.length < 40) fail('Файл профиля повреждён.');
      const storageKey = derive(password, salt);
      let plain;
      try {
        try { plain = s.crypto_secretbox_open_easy(encrypted.subarray(24), encrypted.subarray(0, 24), storageKey); }
        catch (_) { fail('Неверный пароль или повреждённая резервная копия.'); }
        const session = validateDocument(parse(plain));
        return {...session, storageKey, salt};
      } catch (error) { s.memzero(storageKey); throw error; }
      finally { if (plain) s.memzero(plain); }
    }
    function create(password) {
      const salt = s.randombytes_buf(16), storageKey = derive(password, salt, true);
      const pair = s.crypto_box_keypair();
      return {document: {v: 1, private: b64(pair.privateKey), contacts: {}, seen: []},
        privateKey: pair.privateKey, publicKey: pair.publicKey, id: keyID(pair.publicKey), storageKey, salt};
    }
    const exportProfile = session => pack(session.document, session.storageKey, session.salt);
    const view = session => ({id: session.id, card: card(session.publicKey), fingerprint: fingerprint(session.publicKey),
      contacts: Object.entries(session.document.contacts).map(([id, c]) => ({id, ...c}))});
    function saveContact(session, name, publicCard, verified) {
      if (typeof name !== 'string') fail('Введите имя друга.');
      name = name.trim();
      if (!name || [...name].length > 60 || /[\x00-\x1f]/.test(name)) fail('Имя: от 1 до 60 символов без переносов строки.');
      if (typeof verified !== 'boolean') fail('Некорректная отметка проверки.');
      const pub = readCard(publicCard), id = keyID(pub), contacts = session.document.contacts;
      if (id === session.id) fail('Это ваш ключ. Вставьте публичный ключ друга.');
      if (!contacts[id] && Object.keys(contacts).length >= 100) fail('Можно сохранить до 100 контактов.');
      if (Object.entries(contacts).some(([other, c]) => other !== id && c.name.toLocaleLowerCase('und') === name.toLocaleLowerCase('und')))
        fail('Контакт с таким именем уже есть.');
      contacts[id] = {name, public: card(pub), verified};
      return id;
    }
    function encrypt(session, contactID, text) {
      const c = session.document.contacts[contactID];
      if (!c) fail('Добавьте друга и выберите получателя.');
      if (!c.verified) fail('Сначала сверьте отпечаток ключа друга.');
      if (typeof text !== 'string' || !text.trim() || bytes(text).length > MAX_TEXT) fail('Введите сообщение длиной до 64 КиБ.');
      const payload = {v: 1, kind: 'QuietChat/message', from: session.id, to: contactID,
        mid: s.to_hex(s.randombytes_buf(16)), sent_at: new Date().toISOString(), text};
      const nonce = s.randombytes_buf(24), plain = bytes(json(payload));
      try {
        const box = concat(nonce, s.crypto_box_easy(plain, nonce, readCard(c.public), session.privateKey));
        return 'QC1:' + b64(bytes(json({v: 1, from: session.id, to: contactID, box: b64(box)})));
      } finally { s.memzero(plain); }
    }
    function decrypt(session, token) {
      if (typeof token !== 'string' || token.length > MAX_TOKEN) fail('Шифротекст слишком большой.');
      const compact = token.replace(/\s/g, '');
      if (!compact.startsWith('QC1:')) fail('Вставьте целиком сообщение, начинающееся с QC1:.');
      const e = parse(unb64(compact.slice(4), MAX_BOX * 2));
      if (!fields(e, ['v', 'from', 'to', 'box']) || typeof e.from !== 'string' || typeof e.to !== 'string'
          || !ID.test(e.from) || !ID.test(e.to)) fail('Повреждён формат сообщения.');
      if (e.to !== session.id) fail('Сообщение предназначено другому ключу.');
      const c = session.document.contacts[e.from];
      if (!c) fail('Сначала добавьте публичный ключ отправителя.');
      if (!c.verified) fail('Сначала сверьте отпечаток ключа отправителя.');
      const encrypted = unb64(e.box);
      if (encrypted.length < 40) fail('Шифротекст повреждён.');
      let plain;
      try {
        try { plain = s.crypto_box_open_easy(encrypted.subarray(24), encrypted.subarray(0, 24), readCard(c.public), session.privateKey); }
        catch (_) { fail('Проверка подлинности не пройдена: сообщение повреждено или ключ не подходит.'); }
        const p = parse(plain);
        if (!fields(p, ['v', 'kind', 'from', 'to', 'mid', 'sent_at', 'text']) || p.kind !== 'QuietChat/message'
            || p.from !== e.from || p.to !== session.id || typeof p.mid !== 'string' || !MID.test(p.mid))
          fail('Не совпадают защищённые данные отправителя и получателя.');
        if (typeof p.text !== 'string' || !p.text.trim() || bytes(p.text).length > MAX_TEXT) fail('Недопустимый размер текста.');
        if (typeof p.sent_at !== 'string' || p.sent_at.length > 40 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(p.sent_at)
            || !Number.isFinite(Date.parse(p.sent_at))) fail('Некорректная дата сообщения.');
        const marker = s.to_hex(s.crypto_hash_sha256(bytes(e.from + ':' + p.mid)));
        const duplicate = session.document.seen.includes(marker);
        if (!duplicate) session.document.seen = [...session.document.seen, marker].slice(-10000);
        return {text: p.text, sender: {id: e.from, name: c.name}, sentAt: p.sent_at, duplicate};
      } finally { if (plain) s.memzero(plain); }
    }
    function changePassword(session, password) {
      const salt = s.randombytes_buf(16), key = derive(password, salt, true);
      s.memzero(session.storageKey); session.storageKey = key; session.salt = salt;
    }
    function destroy(session) {
      if (!session) return;
      s.memzero(session.privateKey); s.memzero(session.storageKey);
      session.document.private = ''; session.document.contacts = {}; session.document.seen = [];
    }
    return {create, open, exportProfile, view, readCard, card, fingerprint, keyID, saveContact, encrypt, decrypt,
      changePassword, destroy, UserError, limits: {MAX_TEXT, MAX_TOKEN, MAX_PROFILE}};
  }
  scope.QuietChatCore = {createCore, UserError};
})(globalThis);
