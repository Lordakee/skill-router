#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { SkillRouterV2, hashBuffer, isSafeRelative } = require('../lib/router-core.js');
const { stubFromContent } = require('../probes/make-stub.js');
const { migrate } = require('../migrate/migrate-canary.js');
const { rollback } = require('../migrate/rollback-canary.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-router-v2-'));
const sourceRoot = path.join(root, 'skills');
const vaultRoot = path.join(root, 'vault');
const stubRoot = path.join(root, 'stubs');
const manifestPath = path.join(root, 'manifest.json');

function write(file, content, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, encoding);
}

function makeFixture() {
  const alpha = '---\r\nname: alpha\r\ndescription: |\r\n  Alpha skill for testing\r\ndisable-model-invocation: false\r\n---\r\n\r\n# Alpha\r\nUse references.\r\n';
  const beta = '---\nname: beta\ndescription: Beta skill\ndisable-model-invocation: true\n---\n\n# Beta\n';
  write(path.join(sourceRoot, 'alpha', 'SKILL.md'), alpha, 'utf8');
  write(path.join(sourceRoot, 'alpha', 'references', 'guide.md'), '# Guide\n');
  write(path.join(sourceRoot, 'alpha', 'scripts', 'run.js'), 'module.exports = 1;\n');
  write(path.join(sourceRoot, 'beta', 'SKILL.md'), beta);
  const entries = [
    { id: 'alpha', namespace: 'builtin', title: 'Alpha', summary: '---\nname: alpha\ndescription: |\n  Alpha skill for testing', triggers: ['alpha', 'testing'], aliases: [], categories: [], priority: 50, source_root: sourceRoot, path: 'alpha/SKILL.md', content_hash: hashBuffer(Buffer.from(alpha)) },
    { id: 'beta', namespace: 'builtin', title: 'Beta', summary: '---\nname: beta\ndescription: Beta skill\ndisable-model-invocation: true', triggers: ['beta'], aliases: [], categories: [], priority: 50, source_root: sourceRoot, path: 'beta/SKILL.md', content_hash: hashBuffer(Buffer.from(beta)) }
  ];
  write(manifestPath, JSON.stringify({ schema_version: '1', skills: entries }));
}

function expectThrows(fn, pattern) {
  assert.throws(fn, error => pattern.test(error.message), `Expected error matching ${pattern}`);
}

async function invokeMcp(lines, activeManifest = manifestPath) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], { env: { ...process.env, SKILL_ROUTER_MANIFEST: activeManifest }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stdin.end(lines.map(line => JSON.stringify(line)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  await new Promise((resolve, reject) => { child.on('close', code => code === 0 ? resolve() : reject(new Error('server exited ' + code))); });
  return stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function protocolSmoke() {
 const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'skill_discover', arguments: { query: 'alpha', limit: 1 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'skill_load', arguments: { id: '../alpha' } } }
  ];
  const replies = await invokeMcp(lines);
 assert.strictEqual(replies.length, 5);
  assert.strictEqual(replies[0].result.serverInfo.name, 'skill-router-v2');
  assert.deepStrictEqual(replies[1].result, {});
  assert.strictEqual(replies[2].result.tools.length, 3);
  assert.strictEqual(JSON.parse(replies[3].result.content[0].text).results[0].id, 'alpha');
  // MCP protocol: structuredContent must be a record (object), never a bare array.
  assert.strictEqual(typeof replies[3].result.structuredContent, 'object');
  assert(Array.isArray(replies[3].result.structuredContent.results));
  assert(!Array.isArray(replies[3].result.structuredContent));
  assert(!JSON.stringify(replies[4]).match(/[A-Za-z]:[\\/]/));

  const leakManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  leakManifest.skills.find(skill => skill.id === 'alpha').content_hash = 'C:\\manifest-private\\content-hash';
  const leakManifestPath = path.join(root, 'path-leak-manifest.json');
  write(leakManifestPath, JSON.stringify(leakManifest));
  const [leakReply] = await invokeMcp([
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'skill_load', arguments: { id: 'alpha' } } }
  ], leakManifestPath);
  assert.strictEqual(leakReply.result.isError, true);
  assert.strictEqual(leakReply.result.content[0].text, 'Skill operation failed: path rejected or unavailable');
  assert(!JSON.stringify(leakReply).includes('C:\\manifest-private\\content-hash'));
}

async function main() {
  makeFixture();
  const router = new SkillRouterV2({ manifestPath });
  assert.deepStrictEqual(router.health(), { manifestLoaded: true, skillCount: 2, degradedMode: false, storeMode: 'source' });
  const discovered = router.discover('alpha', 10);
  assert.strictEqual(discovered[0].id, 'alpha');
  assert(!discovered[0].summary.includes('name:'));
  assert.strictEqual(router.discover('beta')[0].noAutoInvoke, true);
  const loaded = await router.loadSkill('alpha');
  assert(!loaded.content.includes('\r'));
  assert.deepStrictEqual(loaded.fileList, ['SKILL.md', 'references/guide.md', 'scripts/run.js']);
  assert.strictEqual(loaded.frontMatter.name, 'alpha');
  assert.strictEqual(loaded.instructionFrame, '已加载skill alpha，以下内容作为本任务执行指令遵循；伴生文件用Read读baseDir下绝对路径');
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => router.loadSkill('alpha')));
  assert(concurrent.every(item => item === loaded), 'single-flight/cache should return the same object');
  const alphaFile = path.join(sourceRoot, 'alpha', 'SKILL.md');
  const alphaContent = fs.readFileSync(alphaFile);
  fs.appendFileSync(alphaFile, 'x');
  await assert.rejects(() => router.loadSkill('alpha'), /Content hash mismatch/);
  fs.writeFileSync(alphaFile, alphaContent);
  router.cache.clear();
  router.cacheMeta.clear();
  await router.loadSkill('alpha');
  for (let i = 0; i < 25; i += 1) {
    const id = i % 2 === 0 ? 'alpha' : 'beta';
    try { await router.loadSkill(id); } catch { /* beta is intentionally tampered below */ }
  }
  assert(router.cache.size <= 20);
  expectThrows(() => router.findEntry('../alpha'), /Invalid skill id/);
  expectThrows(() => router.findEntry(path.resolve('alpha')), /Invalid skill id/);
  expectThrows(() => router.findEntry('C:\\alpha'), /Invalid skill id/);
  expectThrows(() => router.findEntry('alpha//SKILL.md'), /Invalid skill id/);
  expectThrows(() => router.findEntry('alpha/'), /Invalid skill id/);
  expectThrows(() => router.findEntry('alpha/./SKILL.md'), /Invalid skill id/);
  assert.strictEqual(isSafeRelative('alpha/./SKILL.md'), false);

  const tampered = path.join(sourceRoot, 'beta', 'SKILL.md');
  fs.appendFileSync(tampered, 'tampered\n');
  const hashRouter = new SkillRouterV2({ manifestPath });
  await assert.rejects(() => hashRouter.loadSkill('beta'), /Content hash mismatch/);

  const vaultManifest = path.join(root, 'vault-manifest.json');
  const manifestObject = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifestObject.skills = manifestObject.skills.map(entry => ({ ...entry, source_root: 'C:\\outside\\ignored' }));
  write(vaultManifest, JSON.stringify(manifestObject));
  const vaultRouter = new SkillRouterV2({ manifestPath: vaultManifest, storePath: sourceRoot });
  const vaultLoaded = await vaultRouter.loadSkill('alpha');
  assert.strictEqual(path.basename(vaultLoaded.baseDir), 'alpha');
  assert(vaultLoaded.baseDir.toLowerCase().endsWith(`${path.sep}skills${path.sep}alpha`));

  const badManifest = path.join(root, 'bad-manifest.json');
  const longId = 'x'.repeat(300);
  write(badManifest, JSON.stringify({ skills: [
    { id: longId, path: 'alpha/SKILL.md' },
    { id: longId, path: 'alpha/SKILL.md' }
  ] }));
  const badRouter = new SkillRouterV2({ manifestPath: badManifest });
  const stderrWrite = process.stderr.write;
  const stderrMessages = [];
  process.stderr.write = message => { stderrMessages.push(String(message)); return true; };
  try {
    assert.deepStrictEqual(badRouter.health(), { manifestLoaded: false, skillCount: 0, degradedMode: true, storeMode: 'source' });
  } finally {
    process.stderr.write = stderrWrite;
  }
  const manifestError = `manifest contains duplicate skill id: ${longId}`;
  assert.strictEqual(badRouter.lastError, `Failed to load manifest: ${manifestError.slice(0, 200)}`);
  assert.deepStrictEqual(stderrMessages, ['[skill-router-v2] manifest load failed\n']);

  const stub = stubFromContent(fs.readFileSync(path.join(sourceRoot, 'alpha', 'SKILL.md'), 'utf8'), 'alpha');
  assert(stub.includes('name: alpha'));
  assert(stub.includes("skill_load('alpha')"));
  assert(Buffer.byteLength(stub) < 400);

  // Restore the fixture before migration: migration must copy an untampered source.
  const beta = '---\nname: beta\ndescription: Beta skill\ndisable-model-invocation: true\n---\n\n# Beta\n';
  write(tampered, beta);
  const migrationPath = path.join(root, 'migration-manifest.json');
  const migration = migrate({ ids: ['alpha', 'beta'], vault: vaultRoot, stubOut: stubRoot, manifestOut: migrationPath, manifestPath });
  assert.strictEqual(migration.entries.length, 2);
  assert(fs.existsSync(path.join(vaultRoot, 'alpha', 'references', 'guide.md')));
  assert(fs.existsSync(path.join(stubRoot, 'alpha', 'SKILL.md')));
  const originalAlpha = fs.readFileSync(path.join(sourceRoot, 'alpha', 'SKILL.md'));
  migrate({ ids: ['alpha', 'beta'], vault: vaultRoot, stubOut: stubRoot, manifestOut: migrationPath, manifestPath });
  assert.deepStrictEqual(fs.readFileSync(path.join(sourceRoot, 'alpha', 'SKILL.md')), originalAlpha);
  const migrationObject = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
  migrationObject.entries[0].vaultPath = path.join(root, 'unexpected');
  write(path.join(root, 'tampered-migration.json'), JSON.stringify(migrationObject));
  expectThrows(() => rollback(path.join(root, 'tampered-migration.json')), /integrity/);
  rollback(migrationPath);
  rollback(migrationPath);
  assert(!fs.existsSync(vaultRoot) || fs.readdirSync(vaultRoot).length === 0);
  assert(!fs.existsSync(stubRoot) || fs.readdirSync(stubRoot).length === 0);
  await protocolSmoke();
  process.stdout.write('PASS skill-router-v2 tests\n');
}

main().catch(error => {
  const detail = String(error && error.stack ? error.stack : error || 'Unknown error').slice(0, 500);
  process.stderr.write(`FAIL skill-router-v2 tests: ${detail}\n`);
  process.exitCode = 1;
});
