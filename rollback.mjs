#!/usr/bin/env node
/**
 * skill-router rollback — restore scan roots from a setup snapshot (byte-exact per location).
 *
 * Usage: node rollback.mjs --snapshot <dir> [--roots pathA,pathB] [--dry-run]
 *
 * The snapshot tars hold each physical copy's original bytes, so root-local
 * duplicates that differed before setup are restored exactly. Managed vault
 * and stubs are left in place; only scan roots are rewritten. Foreign files
 * created after setup in the roots are removed with the roots' restore.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
const HOME = args.home ? path.resolve(args.home) : os.homedir();

// Map tar archive label -> restore destination parent (archive contains "skills/..." member root)
const ROOT_PARENTS = {
  zcode: path.join(HOME, '.zcode'),
  agents: path.join(HOME, '.agents'),
};

// MSYS/GNU tar on Windows cannot take C:\... args; convert to /c/... form. Identity on POSIX.
const posix = p => process.platform === 'win32'
  ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):\/?/, (m, d) => `/${d.toLowerCase()}/`)
  : p;

function run() {
  if (!args.snapshot) { console.error('Usage: node rollback.mjs --snapshot <dir> [--roots a,b] [--dry-run]'); process.exit(2); }
  const snap = path.resolve(String(args.snapshot).replace(/^~(?=$|\/|\\)/, HOME));
  if (!fs.existsSync(snap)) { console.error(`ABORT: snapshot dir not found: ${snap}`); process.exit(2); }

  const tars = fs.readdirSync(snap).filter(f => f.startsWith('skills-') && f.endsWith('.tar.gz'));
  if (!tars.length) { console.error(`ABORT: no skills-*.tar.gz in ${snap}`); process.exit(2); }

  for (const t of tars) {
    // label = between "skills-" and ".tar.gz"; parents keyed by common conventions
    const label = t.slice('skills-'.length, -'.tar.gz'.length);
    const parent = ROOT_PARENTS[label] || path.join(HOME, '.' + label);
    console.log(`[rollback] ${t} -> ${parent}${DRY ? ' (dry-run)' : ''}`);
    if (DRY) { console.log(`  would: rm -rf ${path.join(parent, 'skills')} && tar -xzf into parent`); continue; }
    // Pre-create symlink targets that dangle (bsdtar refuses otherwise); bounded to HOME
    let listing = '';
    try { listing = execFileSync('tar', ['-tvzf', posix(path.join(snap, t))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* listing best-effort */ }
    for (const line of listing.split(/\r?\n/)) {
      if (!line.startsWith('l')) continue;
      const m = line.match(/-> (.+)$/);
      if (!m) continue;
      const target = m[1].trim();
      if (target.startsWith('/') || target.startsWith(HOME) || /^[A-Za-z]:[\\/]/.test(target)) {
        try { fs.mkdirSync(target, { recursive: true }); } catch { /* best-effort */ }
      }
    }
    fs.rmSync(path.join(parent, 'skills'), { recursive: true, force: true });
    execFileSync('tar', ['-xzf', posix(path.join(snap, t)), '-C', posix(parent)], { stdio: 'pipe' });
  }

  console.log('[rollback] restore complete. Restart your agents to get native skill loading back.');
  console.log('[rollback] vault and MCP registrations were left in place; remove them manually if you are uninstalling.');
}

run();
