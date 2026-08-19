'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_MANIFEST = path.join(os.homedir(), '.zcode', 'skills', '.router', 'manifest.json');
const LEGACY_ROUTER = path.join(os.homedir(), '.zcode', 'skills', '.router', 'skill-router.js');
const MAX_CACHE = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  const gitBashPath = value.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBashPath) return path.normalize(`${gitBashPath[1].toUpperCase()}:\\${gitBashPath[2].replace(/\//g, path.sep)}`);
  return value;
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function scalar(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === 'null' || text === '~') return null;
  if (text.startsWith('[') && text.endsWith(']')) {
    const items = [];
    let current = '';
    let quote = null;
    for (const character of text.slice(1, -1)) {
      if ((character === '"' || character === "'") && (!quote || quote === character)) quote = quote ? null : character;
      if (character === ',' && !quote) { items.push(current); current = ''; }
      else current += character;
    }
    items.push(current);
    return items.map(item => scalar(item)).filter(item => item !== '');
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function frontMatterEnd(text) {
  const match = /\n---(?:\n|$)/.exec(text.slice(4));
  return match ? 4 + match.index : -1;
}

function indentation(line) {
  const prefix = String(line).match(/^[ \t]*/)[0];
  return prefix.replace(/\t/g, '  ').length;
}

/** Parse the indentation-based YAML subset used by SKILL.md front matter. */
function parseFrontMatter(input) {
  const text = normalizeText(input);
  if (!text.startsWith('---\n')) return {};
  const end = frontMatterEnd(text);
  const body = text.slice(4, end < 0 ? text.length : end).replace(/\n$/, '');
  const lines = body.split('\n').map(raw => ({ raw, indent: indentation(raw), text: raw.trim() }));

  function nextMeaningful(index) {
    while (index < lines.length && (!lines[index].text || lines[index].text.startsWith('#'))) index += 1;
    return index;
  }

  function blockScalar(index, parentIndent, mode) {
    const values = [];
    let contentIndent = Infinity;
    let cursor = index;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.text && line.indent <= parentIndent) break;
      if (line.text) contentIndent = Math.min(contentIndent, line.indent);
      values.push(line);
      cursor += 1;
    }
    const stripped = values.map(line => line.text ? line.raw.slice(Number.isFinite(contentIndent) ? contentIndent : parentIndent + 1).trimEnd() : '');
    if (mode === '>') {
      let folded = '';
      for (const value of stripped) folded += value ? `${value} ` : '\n';
      return [folded.trim(), cursor];
    }
    return [stripped.join('\n').replace(/\n+$/, ''), cursor];
  }

  function parseBlock(start, level) {
    let index = nextMeaningful(start);
    if (index >= lines.length || lines[index].indent < level) return [null, index];
    const arrayMode = lines[index].indent === level && /^-\s*/.test(lines[index].text);
    const value = arrayMode ? [] : {};
    while (index < lines.length) {
      index = nextMeaningful(index);
      if (index >= lines.length || lines[index].indent < level) break;
      const line = lines[index];
      if (line.indent !== level) { index += 1; continue; }
      if (arrayMode) {
        const item = line.text.match(/^-\s*(.*)$/);
        if (!item) break;
        const itemText = item[1].trim();
        index += 1;
        if (!itemText) {
          const childStart = nextMeaningful(index);
          if (childStart < lines.length && lines[childStart].indent > level) {
            const parsed = parseBlock(childStart, lines[childStart].indent);
            value.push(parsed[0]);
            index = parsed[1];
          } else value.push(null);
        } else value.push(scalar(itemText));
        continue;
      }
      const match = line.text.match(/^([^:#][^:]*):(?:\s*(.*))?$/);
      if (!match) { index += 1; continue; }
      const key = match[1].trim();
      const rawValue = (match[2] || '').trim();
      index += 1;
      if (rawValue === '|' || rawValue === '>') {
        const parsed = blockScalar(index, level, rawValue);
        value[key] = parsed[0];
        index = parsed[1];
      } else if (rawValue) {
        value[key] = scalar(rawValue);
      } else {
        const childStart = nextMeaningful(index);
        if (childStart < lines.length && lines[childStart].indent > level) {
          const parsed = parseBlock(childStart, lines[childStart].indent);
          value[key] = parsed[0];
          index = parsed[1];
        } else value[key] = null;
      }
    }
    return [value, index];
  }

  const first = nextMeaningful(0);
  if (first >= lines.length) return {};
  const parsed = parseBlock(first, lines[first].indent)[0];
  return parsed && !Array.isArray(parsed) ? parsed : {};
}

function frontMatterRange(input) {
  const text = normalizeText(input);
  if (!text.startsWith('---\n')) return 0;
  const end = frontMatterEnd(text);
  return end < 0 ? 0 : end + 4;
}

function cleanSummary(summary, fallbackTitle = '') {
  const text = normalizeText(summary).trim();
  if (!text) return fallbackTitle || '';
  if (text.startsWith('---\n')) {
    const parsed = parseFrontMatter(text);
    if (typeof parsed.description === 'string' && parsed.description.trim()) return parsed.description.trim();
    const end = frontMatterEnd(text);
    return end >= 0 ? (text.slice(end + 4).trim() || fallbackTitle || '') : (fallbackTitle || '');
  }
  if (text === '|' || text === '>') return fallbackTitle || '';
  return text.replace(/^---\s*/, '').replace(/\s*---\s*$/, '').trim() || fallbackTitle || '';
}

function hashBuffer(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) return false;
  const normalized = value.replace(/\\/g, '/');
  return !normalized.split('/').some(part => part === '..' || part === '.' || part === '');
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realPathIfExists(target) {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

function loadLegacyScorer() {
  try {
    if (!fs.existsSync(LEGACY_ROUTER)) return null;
    const LegacyRouter = require(LEGACY_ROUTER);
    const legacy = new LegacyRouter({ manifestPath: DEFAULT_MANIFEST });
    if (typeof legacy.calculateScore === 'function') return legacy;
  } catch {
    // The v2 scorer below remains the deterministic fallback when the legacy file is unavailable.
  }
  return null;
}

function walkFiles(root, current = root, result = [], visited = new Set()) {
  const realCurrent = realPathIfExists(current);
  if (!realCurrent || !within(root, realCurrent)) throw new Error('Skill directory escapes source root');
  if (visited.has(realCurrent)) throw new Error('Skill directory contains a junction or symlink cycle');
  visited.add(realCurrent);
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Skill directory contains a symlink or junction');
    const real = realPathIfExists(absolute);
    if (!real || !within(root, real)) throw new Error('Skill file escapes source root');
    if (fs.statSync(real).size > MAX_FILE_BYTES) throw new Error('Skill file is too large');
    if (entry.isDirectory()) walkFiles(root, absolute, result, visited);
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

class SkillRouterV2 {
  constructor(options = {}) {
    this.manifestPath = expandHome(options.manifestPath || process.env.SKILL_ROUTER_MANIFEST || DEFAULT_MANIFEST);
    this.storePath = expandHome(Object.prototype.hasOwnProperty.call(options, 'storePath') ? options.storePath : (process.env.SKILL_ROUTER_STORE || ''));
    this.storeMode = Boolean(this.storePath);
    this.manifest = null;
    this.manifestLoaded = false;
    this.degradedMode = false;
    this.lastError = null;
    this.cache = new Map();
    this.cacheMeta = new Map();
    this.metaCache = new Map();
    this.inflight = new Map();
    this.legacyScorer = options.legacyScorer || loadLegacyScorer();
  }

  loadManifest() {
    if (this.manifestLoaded) return this.manifest !== null;
    this.manifestLoaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.skills)) throw new Error('manifest.skills must be an array');
      const ids = new Set();
      for (const skill of parsed.skills) {
        if (!skill || typeof skill !== 'object' || typeof skill.id !== 'string' || !skill.id) throw new Error('manifest contains an invalid skill entry');
        if (ids.has(skill.id)) throw new Error(`manifest contains duplicate skill id: ${skill.id}`);
        if (!isSafeRelative(skill.path)) throw new Error(`manifest contains an unsafe path for skill: ${skill.id}`);
        ids.add(skill.id);
      }
      this.manifest = parsed;
      this.degradedMode = false;
      return true;
    } catch (error) {
      this.manifest = null;
      this.degradedMode = true;
      const detail = String(error && error.message ? error.message : error || 'Unknown error').slice(0, 200);
      this.lastError = `Failed to load manifest: ${detail}`;
      process.stderr.write('[skill-router-v2] manifest load failed\n');
      return false;
    }
  }

  ensureManifest() { return this.loadManifest(); }

  entries() {
    return this.ensureManifest() ? this.manifest.skills : [];
  }

  findEntry(id) {
    if (typeof id !== 'string' || !id || id.includes('\0') || id.includes('/') || id.includes('\\') || id === '.' || id === '..' || path.isAbsolute(id) || /^[a-zA-Z]:[\\/]/.test(id) || id.startsWith('//') || id.startsWith('\\\\')) {
      throw new Error('Invalid skill id: path traversal and absolute paths are not allowed');
    }
    const entry = this.entries().find(skill => skill.id === id);
    if (!entry) throw new Error(`Skill not found: ${id}`);
    if (!isSafeRelative(entry.path)) throw new Error(`Manifest path rejected for skill: ${id}`);
    return entry;
  }

  sourceRoot(entry) {
    const root = expandHome(this.storeMode ? this.storePath : entry.source_root);
    if (!root || !path.isAbsolute(root)) throw new Error(`Invalid source root for skill: ${entry.id}`);
    const realRoot = realPathIfExists(root);
    if (!realRoot) throw new Error(`Skill source root unavailable for skill: ${entry.id}`);
    return realRoot;
  }

  resolveEntry(entry) {
    const root = this.sourceRoot(entry);
    const candidate = path.resolve(root, entry.path);
    if (!within(root, candidate)) throw new Error(`Skill path escapes source root: ${entry.id}`);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`Skill file is a symlink or junction: ${entry.id}`);
    const realFile = realPathIfExists(candidate);
    if (!realFile || !within(root, realFile) || !fs.statSync(realFile).isFile()) throw new Error(`Skill file unavailable: ${entry.id}`);
    return { root, file: realFile, skillDir: path.dirname(realFile) };
  }

  normalizeEntry(entry) {
    if (this.metaCache.has(entry.id)) return this.metaCache.get(entry.id);
    let frontMatter = {};
    try {
      const resolved = this.resolveEntry(entry);
      frontMatter = parseFrontMatter(fs.readFileSync(resolved.file, 'utf8'));
    } catch {
      // Discover remains manifest-only; load reports the precise failure.
    }
    const title = String(entry.title || entry.id);
    const summary = cleanSummary(entry.summary, title);
    const truthyFlag = value => value === true || String(value).toLowerCase() === 'true';
    const noAutoInvoke = truthyFlag(frontMatter['disable-model-invocation']) ||
      truthyFlag(entry['disable-model-invocation']) ||
      truthyFlag(entry.disable_model_invocation) ||
      truthyFlag(entry.disableModelInvocation) ||
      truthyFlag(entry.noAutoInvoke);
    const normalized = { ...entry, title, summary, frontMatter, noAutoInvoke };
    this.metaCache.set(entry.id, normalized);
    return normalized;
  }

  normalizeQuery(query) {
    return String(query || '').toLowerCase().trim().split(/[\s\-_]+/).filter(Boolean);
  }

  calculateScore(skill, terms) {
    if (this.legacyScorer) {
      try {
        const scored = this.legacyScorer.calculateScore(skill, terms);
        if (scored && Number.isFinite(scored.score)) return scored;
      } catch {
        // Fall through to the local scorer for malformed third-party metadata.
      }
    }
    let score = 0;
    const reasons = [];
    const query = terms.join(' ');
    const id = String(skill.id).toLowerCase().replace(/[-_]/g, ' ');
    if (query === id || terms.includes(String(skill.id).toLowerCase())) { score += 100; reasons.push('exact ID match'); }
    const idTerms = id.split(/\s+/);
    const idMatches = idTerms.filter(term => terms.includes(term)).length;
    if (idMatches && score < 100) { score += idMatches * 40; reasons.push(`ID partial match (${idMatches}/${idTerms.length} terms)`); }
    for (const alias of Array.isArray(skill.aliases) ? skill.aliases : []) {
      if (terms.includes(String(alias).toLowerCase())) { score += 90; reasons.push(`alias match: ${alias}`); break; }
    }
    const triggerMatches = [];
    for (const trigger of Array.isArray(skill.triggers) ? skill.triggers : []) {
      const lower = String(trigger).toLowerCase();
      if (terms.includes(lower)) { score += 30; triggerMatches.push(trigger); }
      else if (terms.some(term => lower.includes(term) || term.includes(lower))) { score += 15; triggerMatches.push(trigger); }
    }
    if (triggerMatches.length) reasons.push(`trigger: ${triggerMatches.join(', ')}`);
    const titleTerms = String(skill.title || '').toLowerCase().split(/[\s\-_]+/);
    const titleMatches = terms.filter(term => titleTerms.includes(term)).length;
    if (titleMatches) { score += titleMatches * 10; reasons.push(`title match (${titleMatches} terms)`); }
    const summaryMatches = terms.filter(term => String(skill.summary || '').toLowerCase().includes(term)).length;
    if (summaryMatches) { score += summaryMatches * 5; reasons.push(`summary match (${summaryMatches} terms)`); }
    for (const category of Array.isArray(skill.categories) ? skill.categories : []) {
      if (terms.includes(String(category).toLowerCase())) { score += 8; reasons.push(`category: ${category}`); }
    }
    score += ((Number.isFinite(skill.priority) ? skill.priority : 50) - 50) * 0.2;
    return { score: Math.round(score), matchReason: reasons.join('; ') || 'no strong match' };
  }

  discover(query, limit = 10) {
    const terms = this.normalizeQuery(query);
    const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 10));
    const results = [];
    for (const raw of this.entries()) {
      const skill = this.normalizeEntry(raw);
      const scored = this.calculateScore(skill, terms);
      if (scored.score <= 0) continue;
      const result = { id: skill.id, title: skill.title, summary: skill.summary, score: scored.score, matchReason: scored.matchReason };
      if (skill.noAutoInvoke) result.noAutoInvoke = true;
      results.push(result);
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, safeLimit);
  }

  async loadSkill(id) {
    if (this.cache.has(id)) {
      const value = this.cache.get(id);
      const meta = this.cacheMeta.get(id);
      try {
        this.verifyCachedHash(id, meta);
        this.cache.delete(id); this.cache.set(id, value);
        return value;
      } catch {
        // A changed or unavailable file is a hard failure, never stale content.
        this.cache.delete(id);
        this.cacheMeta.delete(id);
        throw new Error(`Content hash mismatch for skill '${id}'`);
      }
    }
    if (this.inflight.has(id)) return this.inflight.get(id);
    const promise = Promise.resolve().then(() => this.loadSkillSync(id)).finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  verifyCachedHash(id, meta) {
    if (!meta || !meta.file) throw new Error('Cached skill metadata unavailable');
    const entry = this.findEntry(id);
    const raw = fs.readFileSync(meta.file);
    const actualHash = hashBuffer(raw);
    const expected = String(entry.content_hash || '');
    const accepted = new Set([expected]);
    if (/^[a-f0-9]{64}$/i.test(expected)) accepted.add(`sha256:${expected}`);
    if (!accepted.has(actualHash)) throw new Error('hash mismatch');
    const stat = fs.statSync(meta.file, { bigint: true });
    meta.size = stat.size;
    meta.mtimeNs = stat.mtimeNs;
    return true;
  }

  loadSkillSync(id) {
    const entry = this.findEntry(id);
    const { root, file, skillDir } = this.resolveEntry(entry);
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error(`Skill file is too large: ${id}`);
    const raw = fs.readFileSync(file);
    const content = normalizeText(raw.toString('utf8'));
    const actualHash = hashBuffer(raw);
    const expectedHash = String(entry.content_hash || '');
    const acceptedHashes = new Set([expectedHash]);
    if (/^[a-f0-9]{64}$/i.test(expectedHash)) acceptedHashes.add(`sha256:${expectedHash}`);
    const matchedHash = acceptedHashes.has(actualHash) ? actualHash : '';
    if (!matchedHash) throw new Error(`Content hash mismatch for skill '${id}': expected ${entry.content_hash || '(missing)'}, got ${actualHash}`);
    const frontMatter = parseFrontMatter(content);
    const files = walkFiles(root, skillDir).map(filePath => path.relative(skillDir, filePath).replace(/\\/g, '/')).sort();
    const result = {
      id: entry.id,
      namespace: entry.namespace || 'builtin',
      sha256: matchedHash,
      frontMatter,
      content,
      baseDir: skillDir,
      fileList: files,
      instructionFrame: `已加载skill ${id}，以下内容作为本任务执行指令遵循；伴生文件用Read读baseDir下绝对路径`,
      truncated: false
    };
    this.cache.delete(id);
    this.cache.set(id, result);
    const stat = fs.statSync(file, { bigint: true });
    this.cacheMeta.set(id, { file, size: stat.size, mtimeNs: stat.mtimeNs });
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
      this.cacheMeta.delete(oldest);
    }
    return result;
  }

  health() {
    this.ensureManifest();
    return { manifestLoaded: this.manifest !== null, skillCount: this.manifest ? this.manifest.skills.length : 0, degradedMode: this.degradedMode, storeMode: this.storeMode ? 'vault' : 'source' };
  }

  getEntryForMigration(id) {
    const entry = this.findEntry(id);
    const resolved = this.resolveEntry(entry);
    return { entry, ...resolved };
  }
}

module.exports = { SkillRouterV2, parseFrontMatter, cleanSummary, normalizeText, hashBuffer, isSafeRelative, within, expandHome, walkFiles, DEFAULT_MANIFEST, MAX_FILE_BYTES };
