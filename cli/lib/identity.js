'use strict';

const crypto = require('node:crypto');

function normalizeMessage(message) {
  return String(message ?? '').split(/\r?\n/).join('\n').trim();
}

function fingerprint({ file, ruleId, message, occurrence }) {
  const normalized = [
    String(file ?? ''),
    String(ruleId ?? ''),
    normalizeMessage(message),
    String(occurrence ?? ''),
  ].join('\x00');

  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function markerFor(phase) {
  return `<!-- pocket-phase-${phase}-summary -->`;
}

function parseMarker(comment) {
  const match = /^<!-- pocket-phase-(\d+)-summary -->$/.exec(String(comment ?? ''));
  return match ? Number(match[1]) : null;
}

module.exports = {
  fingerprint,
  markerFor,
  parseMarker,
};
