#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SkillRouterV2, expandHome, hashBuffer, within, isSafeRelative, DEFAULT_MANIFEST } = require('../lib/router-core.js');
const { stubFromContent } = require('../probes/make-stub.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw new Error(`Destination contains a symlink or junction: ${to}`);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    else throw new Error(`Unsupported directory entry: ${from}`);
  }
}

function assertRootNotLink(root, label) {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error(`${label} may not be a symlink or junction`);
}

function safeDestination(root, relative) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relative);
  if (!within(absoluteRoot, target)) throw new Error(`Destination escapes root: ${target}`);
  return target;
}

function manifestDigest(record) {
  const copy = { ...record };
  delete copy.manifestHash;
  return hashBuffer(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function assertDestinationSafe(root, target, label) {
  const absoluteRoot = path.resolve(root);
  let probe = path.dirname(target);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  if (!fs.existsSync(probe)) throw new Error(`${label} parent is unavailable`);
  const realRoot = fs.realpathSync.native(absoluteRoot);
  const realProbe = fs.realpathSync.native(probe);
  if (!within(realRoot, realProbe)) throw new Error(`${label} escapes its root through a junction or symlink`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} may not be a symlink or junction`);
}

function migrate({ ids = [], vault = '~/.zcode/skill-store', stubOut = './stubs', manifestOut = 'migration-manifest.json', manifestPath } = {}) {
  if (!ids.length) throw new Error('--skills requires at least one id');
  // Migration always reads the original roots; an ambient vault flag must not redirect its source.
  const router = new SkillRouterV2({ manifestPath: manifestPath || DEFAULT_MANIFEST, storePath: '' });
  if (!router.ensureManifest()) throw new Error('Manifest not loaded');
  const vaultRoot = path.resolve(expandHome(vault));
  const stubRoot = path.resolve(expandHome(stubOut));
  if (within(vaultRoot, stubRoot) || within(stubRoot, vaultRoot)) throw new Error('Vault and stub output roots must be separate');
  assertRootNotLink(vaultRoot, 'Vault root');
  assertRootNotLink(stubRoot, 'Stub root');
  const seenIds = new Set();
  const resolvedById = new Map();
  for (const id of ids) {
    if (!isSafeRelative(id) || id.includes('/') || id.includes('\\') || /^[a-zA-Z]:[\\/]/.test(id)) throw new Error(`Invalid skill id: ${id}`);
    if (seenIds.has(id)) throw new Error(`Duplicate skill id: ${id}`);
    seenIds.add(id);
    const resolved = router.getEntryForMigration(id);
    if (within(resolved.root, vaultRoot) || within(vaultRoot, resolved.root) || within(resolved.root, stubRoot) || within(stubRoot, resolved.root)) {
      throw new Error(`Migration root overlaps original source root: ${id}`);
    }
    resolvedById.set(id, resolved);
  }
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(stubRoot, { recursive: true });
  const vaultRealRoot = fs.realpathSync.native(vaultRoot);
  const stubRealRoot = fs.realpathSync.native(stubRoot);
  const rollbackToken = crypto.randomBytes(16).toString('hex');
  const entries = [];
  for (const id of ids) {
    const resolved = resolvedById.get(id);
    const originalDir = resolved.skillDir;
    if (within(resolved.root, vaultRealRoot) || within(vaultRealRoot, resolved.root) || within(resolved.root, stubRealRoot) || within(stubRealRoot, resolved.root)) {
      throw new Error(`Migration root overlaps original source root: ${id}`);
    }
    const vaultDir = safeDestination(vaultRoot, id);
    const stubDir = safeDestination(stubRoot, id);
    if (within(originalDir, vaultDir) || within(vaultDir, originalDir) || within(originalDir, stubDir) || within(stubDir, originalDir)) {
      throw new Error(`Migration destination overlaps original skill directory: ${id}`);
    }
    assertDestinationSafe(vaultRoot, vaultDir, `vault destination for ${id}`);
    assertDestinationSafe(stubRoot, stubDir, `stub destination for ${id}`);
    copyTree(originalDir, vaultDir);
    const originalSkillFile = path.join(originalDir, 'SKILL.md');
    const content = fs.readFileSync(originalSkillFile, 'utf8');
    const stubFile = path.join(stubDir, 'SKILL.md');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(stubFile, stubFromContent(content, id, { forceId: true }), 'utf8');
    entries.push({
      id,
      originalPath: originalDir,
      originalSkillPath: originalSkillFile,
      vaultPath: vaultDir,
      vaultSkillPath: path.join(vaultDir, 'SKILL.md'),
      stubPath: stubFile,
      hash: hashBuffer(fs.readFileSync(originalSkillFile)),
      rollbackToken,
      copiedAt: new Date().toISOString()
    });
  }
  const output = path.resolve(expandHome(String(manifestOut)));
  const record = { schemaVersion: 1, createdAt: new Date().toISOString(), vault: vaultRoot, stubOut: stubRoot, rollbackToken, entries };
  record.manifestHash = manifestDigest(record);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { output, ...record };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = migrate({ ids: String(args.skills || '').split(',').map(s => s.trim()).filter(Boolean), vault: args.vault || '~/.zcode/skill-store', stubOut: args['stub-out'] || './stubs', manifestOut: args['manifest-out'], manifestPath: args.manifest });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`migrate-canary failed: ${error.message}\n`); process.exit(1); }
}

module.exports = { migrate, parseArgs, copyTree, manifestDigest };
