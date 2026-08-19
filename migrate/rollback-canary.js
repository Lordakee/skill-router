#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { within, expandHome, hashBuffer } = require('../lib/router-core.js');

function manifestDigest(record) {
  const copy = { ...record };
  delete copy.manifestHash;
  return hashBuffer(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function removeExact(target, root, label) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error(`${label} must be an absolute path`);
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!within(resolvedRoot, resolvedTarget) || resolvedTarget === resolvedRoot) throw new Error(`${label} is outside its recorded root`);
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync.native(resolvedRoot);
    let probe = fs.existsSync(resolvedTarget) ? resolvedTarget : path.dirname(resolvedTarget);
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const realProbe = fs.realpathSync.native(probe);
    if (!within(realRoot, realProbe)) throw new Error(`${label} escapes its recorded root through a junction or symlink`);
  }
  if (fs.existsSync(resolvedTarget) && fs.lstatSync(resolvedTarget).isSymbolicLink()) throw new Error(`${label} may not be a symlink or junction`);
  if (fs.existsSync(resolvedTarget)) assertNoLinks(resolvedTarget, resolvedRoot, label);
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function assertNoLinks(target, root, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction`);
  const real = fs.realpathSync.native(target);
  const realRoot = fs.realpathSync.native(root);
  if (!within(realRoot, real)) throw new Error(`${label} escapes its root through a junction or symlink`);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction`);
    if (entry.isDirectory()) assertNoLinks(child, root, label);
  }
}

function rollback(manifestPath) {
  const file = path.resolve(expandHome(manifestPath));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record || !Array.isArray(record.entries) || !record.vault || !record.stubOut || typeof record.rollbackToken !== 'string' || !record.rollbackToken) throw new Error('Invalid migration manifest');
  if (!path.isAbsolute(record.vault) || !path.isAbsolute(record.stubOut)) throw new Error('Migration roots must be absolute paths');
  if (typeof record.manifestHash !== 'string' || record.manifestHash !== manifestDigest(record)) throw new Error('Migration manifest integrity check failed');
  for (const entry of record.entries) {
    removeExact(entry.stubPath, record.stubOut, `stubPath for ${entry.id}`);
    removeExact(entry.vaultPath, record.vault, `vaultPath for ${entry.id}`);
    const parent = path.dirname(entry.stubPath);
    try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* idempotent cleanup */ }
  }
  record.rolledBackAt = new Date().toISOString();
  record.manifestHash = manifestDigest(record);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

if (require.main === module) {
  const index = process.argv.indexOf('--manifest');
  const manifest = index >= 0 ? process.argv[index + 1] : process.argv[2];
  if (!manifest) { process.stderr.write('Usage: node rollback-canary.js --manifest migration-manifest.json\n'); process.exit(2); }
  try { process.stdout.write(`${JSON.stringify(rollback(manifest), null, 2)}\n`); }
  catch (error) { process.stderr.write(`rollback-canary failed: ${error.message}\n`); process.exit(1); }
}

module.exports = { rollback, removeExact, manifestDigest };
