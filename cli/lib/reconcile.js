'use strict';

function byFingerprint(a, b) {
  const left = String(a.fingerprint ?? '');
  const right = String(b.fingerprint ?? '');
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function setDiff(prior, next) {
  const priorList = Array.isArray(prior) ? prior : [];
  const nextList = Array.isArray(next) ? next : [];

  const nextFpSet = new Set(nextList.map((record) => record.fingerprint));
  const priorFpSet = new Set(priorList.map((record) => record.fingerprint));

  const resolve = priorList.filter((record) => !nextFpSet.has(record.fingerprint)).sort(byFingerprint);
  const post = nextList.filter((record) => !priorFpSet.has(record.fingerprint)).sort(byFingerprint);
  const keep = nextList.filter((record) => priorFpSet.has(record.fingerprint)).sort(byFingerprint);

  return { resolve, post, keep };
}

module.exports = { setDiff };
