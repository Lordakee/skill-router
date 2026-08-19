#!/usr/bin/env node
/**
 * Restore scan roots from a setup snapshot.
 *
 * Usage: node rollback.mjs --snapshot <dir> [--roots pathA,pathB] [--home path] [--dry-run]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { expandHome, within } = require('./lib/router-core.js');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    parsed[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
const requestedHome = args.home ? path.resolve(expandHome(String(args.home))) : os.homedir();
const HOME_DIR = fs.existsSync(requestedHome) ? fs.realpathSync.native(requestedHome) : path.resolve(requestedHome);
const HERE = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));

function userPath(value) {
  return path.resolve(expandHome(String(value), HOME_DIR));
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function samePathSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(pathKey));
  return right.every(item => expected.has(pathKey(item)));
}

function existingPathLinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const links = [];
  let current = parsed.root;
  for (const part of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) links.push(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return links;
}

function assertPathHasNoLinks(target, label) {
  const links = existingPathLinks(target);
  if (links.length) throw new Error(`${label} uses a symlink or junction: ${links.join(', ')}`);
}

function canonicalTarget(target, label) {
  const resolved = path.resolve(target);
  assertPathHasNoLinks(resolved, label);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`${label} has no accessible ancestor`);
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), path.relative(existing, resolved));
}

function detectTar() {
  let output;
  try { output = execFileSync('tar', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`Unable to execute tar --version: ${error.message}`); }
  const version = String(output).trim().split(/\r?\n/)[0];
  let implementation;
  if (/bsdtar|libarchive/i.test(output)) implementation = 'bsdtar';
  else if (/GNU tar/i.test(output)) implementation = 'gnu-tar';
  else throw new Error(`Unsupported tar implementation: ${version || 'unknown'}`);
  return { implementation, version, pathMode: process.platform === 'win32' && implementation === 'gnu-tar' ? 'msys' : 'native' };
}

function tarPath(value, tar) {
  if (process.platform !== 'win32' || tar.pathMode !== 'msys') return value;
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):\/?/, (match, drive) => `/${drive.toLowerCase()}/`);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable or invalid JSON: ${error.message}`); }
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateMemberList(archive, listing) {
  const members = listing.split(/\r?\n/).filter(Boolean);
  if (!members.length) throw new Error(`Snapshot archive is empty: ${path.basename(archive)}`);
  let rootDeclared = false;
  for (const raw of members) {
    const member = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    if (member.startsWith('/') || /^[A-Za-z]:\//.test(member) || member.startsWith('//')) throw new Error(`Archive contains an absolute member: ${path.basename(archive)}`);
    const parts = member.split('/').filter(Boolean);
    if (parts.some(part => part === '..')) throw new Error(`Archive contains a parent traversal member: ${path.basename(archive)}`);
    if (parts[0] !== 'skills') throw new Error(`Archive member is not rooted at skills/: ${path.basename(archive)}`);
    if (parts.length === 1) rootDeclared = true;
  }
  if (!rootDeclared) throw new Error(`Archive does not declare its skills/ root: ${path.basename(archive)}`);
  return members;
}

function safeDeclaredLinkTargets(verboseListing) {
  const targets = [];
  for (const line of verboseListing.split(/\r?\n/)) {
    if (!line.startsWith('l')) continue;
    const marker = line.lastIndexOf(' -> ');
    if (marker < 0) continue;
    const declared = line.slice(marker + 4).trim();
    const absolute = path.isAbsolute(declared) || /^[A-Za-z]:[\\/]/.test(declared) || /^\/[A-Za-z]\//.test(declared);
    if (!absolute) continue;
    const target = userPath(declared);
    if (samePath(target, HOME_DIR) || !within(HOME_DIR, target)) continue;
    if (existingPathLinks(target).length) continue;
    const canonical = canonicalTarget(target, 'Declared link target');
    if (within(HOME_DIR, canonical) && !samePath(canonical, HOME_DIR)) targets.push(canonical);
  }
  return [...new Set(targets.map(pathKey))].map(key => targets.find(target => pathKey(target) === key));
}

function preflightExpectedRoots(recordedRoots) {
  if (!Object.prototype.hasOwnProperty.call(args, 'roots')) return;
  const raw = String(args.roots).split(',').map(value => value.trim()).filter(Boolean);
  if (!raw.length) throw new Error('--roots override validation requires at least one directory');
  const roots = [];
  const seen = new Set();
  for (const value of raw) {
    const resolved = userPath(value);
    assertPathHasNoLinks(resolved, 'Expected root');
    if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) throw new Error(`Expected root is not an existing directory: ${resolved}`);
    const canonical = fs.realpathSync.native(resolved);
    const key = pathKey(canonical);
    if (!seen.has(key)) { seen.add(key); roots.push(canonical); }
  }
  if (!samePathSet(recordedRoots, roots)) throw new Error('--roots mismatch: expected roots must exactly match snapshot.json');
}

function buildRestorePlan() {
  if (!args.snapshot) throw new Error('Usage: node rollback.mjs --snapshot <dir> [--roots a,b] [--home path] [--dry-run]');
  const requestedSnapshot = userPath(args.snapshot);
  assertPathHasNoLinks(requestedSnapshot, 'Snapshot path');
  if (!fs.existsSync(requestedSnapshot) || !fs.lstatSync(requestedSnapshot).isDirectory()) throw new Error(`Snapshot directory not found: ${requestedSnapshot}`);
  const snapshot = fs.realpathSync.native(requestedSnapshot);
  const metadataPath = path.join(snapshot, 'snapshot.json');
  if (!fs.existsSync(metadataPath) || fs.lstatSync(metadataPath).isSymbolicLink()) throw new Error('Snapshot metadata snapshot.json is required; archive filenames are never used to infer destinations');
  const metadata = readJson(metadataPath, 'Snapshot metadata');
  if (!metadata || metadata.schemaVersion !== 1 || !Array.isArray(metadata.roots) || !metadata.roots.length) throw new Error('Snapshot metadata has no valid root records');

  const tar = detectTar();
  const rootKeys = new Set();
  const archiveNames = new Set();
  const plan = [];
  for (const item of metadata.roots) {
    if (!item || typeof item.root !== 'string' || !path.isAbsolute(item.root) || typeof item.archive !== 'string' || path.basename(item.archive) !== item.archive) {
      throw new Error('Snapshot metadata contains an invalid root or archive record');
    }
    const root = path.resolve(item.root);
    const rootKey = pathKey(root);
    if (rootKeys.has(rootKey)) throw new Error(`Snapshot metadata contains a duplicate root: ${root}`);
    if (archiveNames.has(item.archive)) throw new Error(`Snapshot metadata contains a duplicate archive: ${item.archive}`);
    rootKeys.add(rootKey);
    archiveNames.add(item.archive);
    assertPathHasNoLinks(root, `Recorded root ${root}`);
    if (!samePath(canonicalTarget(root, 'Recorded root'), root)) throw new Error(`Recorded root is no longer canonical: ${root}`);
    if (within(root, HOME_DIR) || samePath(root, path.parse(root).root)) throw new Error(`Snapshot root is protected and cannot be replaced: ${root}`);
    if (within(root, HERE) || within(HERE, root)) throw new Error(`Snapshot root overlaps the skill-router workspace: ${root}`);

    const archive = path.resolve(snapshot, item.archive);
    if (!within(snapshot, archive) || !fs.existsSync(archive)) throw new Error(`Snapshot archive not found: ${item.archive}`);
    const archiveStat = fs.lstatSync(archive);
    if (archiveStat.isSymbolicLink() || !archiveStat.isFile() || !within(snapshot, fs.realpathSync.native(archive))) throw new Error(`Snapshot archive is not a regular in-snapshot file: ${item.archive}`);
    let listing;
    let verbose;
    try {
      listing = execFileSync('tar', ['-tzf', tarPath(archive, tar)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      verbose = execFileSync('tar', ['-tvzf', tarPath(archive, tar)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new Error(`Snapshot archive cannot be fully listed: ${item.archive} (${error.message})`);
    }
    validateMemberList(archive, listing);
    plan.push({ root, archive, archiveName: item.archive, archiveHash: fileDigest(archive), linkTargets: safeDeclaredLinkTargets(verbose) });
  }
  preflightExpectedRoots(plan.map(item => item.root));
  return { snapshot, tar, plan };
}

function exclusiveDirectory(parent) {
  fs.mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(parent, `.skill-router-restore-${crypto.randomBytes(6).toString('hex')}`);
    try { fs.mkdirSync(candidate); return candidate; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error(`Unable to allocate restore staging under ${parent}`);
}

function restoreRoots(restorePlan) {
  const stages = [];
  try {
    for (const target of new Set(restorePlan.plan.flatMap(item => item.linkTargets))) {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    }
    for (const item of restorePlan.plan) {
      if (fileDigest(item.archive) !== item.archiveHash) throw new Error(`Snapshot archive changed after validation: ${item.archiveName}`);
      const parent = path.dirname(item.root);
      const stage = exclusiveDirectory(parent);
      stages.push({ item, stage });
      execFileSync('tar', ['-xzf', tarPath(item.archive, restorePlan.tar), '-C', tarPath(stage, restorePlan.tar)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const extracted = path.join(stage, 'skills');
      if (!fs.existsSync(extracted) || fs.lstatSync(extracted).isSymbolicLink() || !fs.lstatSync(extracted).isDirectory()) throw new Error(`Archive did not extract a regular skills/ root: ${item.archiveName}`);
    }

    for (const { item, stage } of stages) {
      assertPathHasNoLinks(item.root, `Restore target ${item.root}`);
      console.log(`[rollback] ${item.archiveName} -> ${item.root}`);
      fs.rmSync(item.root, { recursive: true, force: true });
      fs.renameSync(path.join(stage, 'skills'), item.root);
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    for (const { stage } of stages) {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}

function main() {
  const restorePlan = buildRestorePlan();
  for (const item of restorePlan.plan) console.log(`[rollback] validated ${item.archiveName} -> ${item.root}${DRY ? ' (dry-run)' : ''}`);
  if (DRY) {
    console.log('[rollback] dry run complete; every archive was listed and validated, no files were changed.');
    return;
  }
  restoreRoots(restorePlan);
  console.log('[rollback] restore complete. Vault and MCP registrations were left in place.');
}

try { main(); }
catch (error) {
  console.error(`ABORT: ${error.message}`);
  process.exitCode = 2;
}
