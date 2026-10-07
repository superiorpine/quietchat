'use strict';
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.join(__dirname, '..');
const sodiumCore = require(path.join(root, 'vendor', 'libsodium-sumo.js'));
const exported = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor', 'libsodium-wrappers.js'), 'utf8'), {
  exports: exported, require: name => {
    if (name !== 'libsodium-sumo') throw new Error('Unexpected dependency');
    return sodiumCore;
  }, Uint8Array, Uint32Array, ArrayBuffer, TextEncoder, TextDecoder, console
});
module.exports = exported;
