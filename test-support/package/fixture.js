'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { posixPath, walkFiles } = require('../surface-test-utils');

function packAndExtract(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', dir], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tarballs = fs.readdirSync(dir).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball, got ${tarballs.join(', ')}`);
  execFileSync('tar', ['-xzf', tarballs[0], '-C', dir], { cwd: dir });
  return { dir, extracted: path.join(dir, 'package') };
}

function withPackedPackage(root, callback) {
  const { dir, extracted } = packAndExtract(root);
  try {
    return callback(extracted);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function packedPaths(extracted) {
  return new Set(walkFiles(extracted).map((file) => posixPath(path.relative(extracted, file))));
}

module.exports = { packAndExtract, packedPaths, withPackedPackage };
