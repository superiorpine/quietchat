'use strict';
importScripts('./vendor/libsodium-sumo.js', './vendor/libsodium-wrappers.js', './crypto-core.js');
let session = null, core;
const ready = sodium.ready.then(() => { core = QuietChatCore.createCore(sodium); });
let queue = Promise.resolve();
self.onmessage = ({data: request}) => {
  queue = queue.then(async () => {
    try {
      await ready;
      const {id, operation, args = {}} = request;
      let value;
      if (operation === 'ready') value = {ready: true};
      else if (operation === 'inspect') {
        const pub = core.readCard(args.card); value = {card: core.card(pub), fingerprint: core.fingerprint(pub)};
      } else if (operation === 'create' || operation === 'open') {
        core.destroy(session); session = null;
        session = operation === 'create' ? core.create(args.password) : core.open(args.envelope, args.password);
        value = {profile: core.view(session), envelope: core.exportProfile(session)};
      } else {
        if (!session) throw new QuietChatCore.UserError('Сначала откройте профиль.');
        if (operation === 'contact') {
          const contactID = core.saveContact(session, args.name, args.card, args.verified);
          value = {profile: core.view(session), envelope: core.exportProfile(session), contactID};
        } else if (operation === 'encrypt') value = {token: core.encrypt(session, args.contactID, args.text)};
        else if (operation === 'decrypt') {
          const message = core.decrypt(session, args.token);
          value = {message, envelope: core.exportProfile(session)};
        } else if (operation === 'backup') value = {envelope: core.exportProfile(session)};
        else if (operation === 'password') {
          core.changePassword(session, args.password); value = {envelope: core.exportProfile(session)};
        } else if (operation === 'lock') { core.destroy(session); session = null; value = {}; }
        else throw new QuietChatCore.UserError('Неизвестное действие.');
      }
      self.postMessage({id, value});
    } catch (error) {
      const message = error instanceof QuietChatCore.UserError ? error.message : 'Не удалось выполнить действие. Перезапустите приложение.';
      self.postMessage({id: request.id, error: message});
    }
  });
};
