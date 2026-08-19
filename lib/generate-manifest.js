#!/usr/bin/env node
/**
 * Skill Manifest Generator
 * 
 * Scans skill directories and generates a compact L0 manifest for fast routing.
 * Handles front matter parsing, auto-generation for legacy skills, and atomic writes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const SCHEMA_VERSION = '1.0.0';
const GENERATOR_VERSION = '0.1.0';

/**
 * Parse YAML front matter from SKILL.md
 */
function parseFrontMatter(content) {
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontMatterMatch) {
    return null;
  }
  
  const yaml = frontMatterMatch[1];
  const metadata = {};
  
  // Simple YAML parser (handles basic key: value and key: [array])
  const lines = yaml.split('\n');
  let currentKey = null;
  
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    
    // Array item
    if (line.match(/^\s*-\s+(.+)$/)) {
      const value = line.match(/^\s*-\s+(.+)$/)[1].replace(/^["']|["']$/g, '');
      if (currentKey && Array.isArray(metadata[currentKey])) {
        metadata[currentKey].push(value);
      }
      continue;
    }
    
    // Key-value pair
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      currentKey = key;
      
      // Array start
      if (value.trim() === '[' || value.trim() === '') {
        metadata[key] = [];
      }
      // Inline array [a, b, c]
      else if (value.match(/^\[.*\]$/)) {
        metadata[key] = value
          .slice(1, -1)
          .split(',')
          .map(v => v.trim().replace(/^["']|["']$/g, ''))
          .filter(v => v);
      }
      // String value
      else {
        metadata[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
  
  return metadata;
}

/**
 * Extract first paragraph from markdown (for auto-generated summary)
 */
function extractFirstParagraph(content) {
  // Remove front matter
  const withoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  
  // Find first non-empty paragraph
  const paragraphs = withoutFrontMatter.split('\n\n');
  for (const para of paragraphs) {
    const cleaned = para.trim().replace(/^#+\s+/, '').replace(/\n/g, ' ');
    if (cleaned && !cleaned.startsWith('```') && cleaned.length > 10) {
      return cleaned.slice(0, 200);
    }
  }
  
  return 'No description available';
}

/**
 * Auto-generate metadata for legacy skills without front matter
 */
function autoGenerateMetadata(skillPath, content) {
  const dirName = path.basename(skillPath);
  
  // Extract title from first heading
  const titleMatch = content.match(/^#+\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : dirName;
  
  // Extract keywords from title
  const keywords = title
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(w => w.length > 2);
  
  return {
    id: dirName,
    namespace: 'builtin',
    title: title,
    summary: extractFirstParagraph(content),
    triggers: keywords,
    aliases: [],
    categories: [],
    priority: 50,
    schema_version: 1
  };
}

/**
 * Calculate content hash for cache invalidation
 */
function calculateHash(filePath) {
  const content = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Scan a skill directory and extract metadata
 */
function scanSkill(skillPath, sourceRoot) {
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  
  if (!fs.existsSync(skillMdPath)) {
    return null;
  }
  
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const stats = fs.statSync(skillMdPath);
  
  // Try to parse front matter
  let metadata = parseFrontMatter(content);
  
  // Auto-generate if missing
  if (!metadata) {
    metadata = autoGenerateMetadata(skillPath, content);
    console.warn(`  [WARN] Auto-generated metadata for: ${path.basename(skillPath)}`);
  }
  
  // Ensure required fields (handle both old and new formats)
  const dirName = path.basename(skillPath);
  const id = metadata.id || metadata.name || dirName;
  const namespace = metadata.namespace || 'builtin';
  const title = metadata.title || (metadata.name && metadata.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')) || dirName;
  const summary = metadata.summary || metadata.description || extractFirstParagraph(content);
  
  return {
    id,
    namespace,
    title,
    summary,
    triggers: Array.isArray(metadata.triggers) ? metadata.triggers : [],
    aliases: Array.isArray(metadata.aliases) ? metadata.aliases : [],
    categories: Array.isArray(metadata.categories) ? metadata.categories : [],
    priority: typeof metadata.priority === 'number' ? metadata.priority : 50,
    source_root: sourceRoot,
    path: path.relative(sourceRoot, skillMdPath).replace(/\\/g, '/'),
    content_hash: calculateHash(skillMdPath),
    file_size: stats.size,
    mtime_ns: stats.mtimeMs * 1000000
  };
}

/**
 * Scan all skills in a directory
 */
function scanSkillsDirectory(skillsRoot) {
  const skills = [];
  const categoryMap = new Map();
  
  if (!fs.existsSync(skillsRoot)) {
    console.warn(`[WARN] Skills directory not found: ${skillsRoot}`);
    return { skills, categories: [] };
  }
  
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    
    const skillPath = path.join(skillsRoot, entry.name);
    const metadata = scanSkill(skillPath, skillsRoot);
    
    if (metadata) {
      skills.push(metadata);
      
      // Count categories
      for (const cat of metadata.categories) {
        categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
      }
    }
  }
  
  // Build category list
  const categories = Array.from(categoryMap.entries()).map(([id, count]) => ({
    id,
    name: id,
    description: '',
    skill_count: count
  }));
  
  return { skills, categories };
}

/**
 * Validate manifest for common issues
 */
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  
  for (const skill of manifest.skills) {
    // Check duplicate IDs
    const fullId = `${skill.namespace}:${skill.id}`;
    if (seenIds.has(fullId)) {
      errors.push(`Duplicate skill ID: ${fullId}`);
    }
    seenIds.add(fullId);
    
    // Check required fields
    if (!skill.id) errors.push(`Skill missing ID: ${skill.path}`);
    if (!skill.title) warnings.push(`Skill missing title: ${skill.id}`);
    if (!skill.summary) warnings.push(`Skill missing summary: ${skill.id}`);
    
    // Check file exists
    const fullPath = path.join(skill.source_root, skill.path);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Skill file not found: ${fullPath}`);
    }
  }
  
  return { errors, warnings };
}

/**
 * Generate manifest from multiple skill roots
 */
function generateManifest(skillRoots) {
  console.log('=== Skill Manifest Generator ===\n');
  
  const skillMap = new Map(); // namespace:id -> skill (for deduplication)
  const allCategories = new Map();
  
  // Scan each root (later roots override earlier ones)
  for (const root of skillRoots) {
    console.log(`Scanning: ${root}`);
    const { skills, categories } = scanSkillsDirectory(root);
    console.log(`  Found ${skills.length} skills`);
    
    // Add or override skills
    for (const skill of skills) {
      const fullId = `${skill.namespace}:${skill.id}`;
      const existing = skillMap.get(fullId);
      
      if (existing) {
        console.log(`  [INFO] Skill '${skill.id}' in ${root} overrides ${existing.source_root}`);
      }
      
      skillMap.set(fullId, skill);
    }
    
    // Merge categories
    for (const cat of categories) {
      const existing = allCategories.get(cat.id);
      if (existing) {
        existing.skill_count += cat.skill_count;
      } else {
        allCategories.set(cat.id, cat);
      }
    }
  }
  
  const allSkills = Array.from(skillMap.values());
  console.log(`\nTotal: ${allSkills.length} unique skills, ${allCategories.size} categories\n`);
  
  const manifest = {
    schema_version: SCHEMA_VERSION,
    generator_version: GENERATOR_VERSION,
    generated_at: new Date().toISOString(),
    catalog_version: '1',
    skills: allSkills,
    categories: Array.from(allCategories.values())
  };
  
  // Validate
  console.log('Validating manifest...');
  const { errors, warnings } = validateManifest(manifest);
  
  if (warnings.length > 0) {
    console.warn('\nWarnings:');
    warnings.forEach(w => console.warn(`  [WARN] ${w}`));
  }
  
  if (errors.length > 0) {
    console.error('\nErrors:');
    errors.forEach(e => console.error(`  [ERROR] ${e}`));
    throw new Error('Manifest validation failed');
  }
  
  console.log('✓ Validation passed\n');
  
  return manifest;
}

/**
 * Write manifest with atomic replacement
 */
function writeManifestAtomic(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  
  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const tmpPath = manifestPath + '.tmp';
  const bakPath = manifestPath + '.bak';
  
  // Write to temp file
  console.log('Writing manifest...');
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  
  // Backup existing manifest
  if (fs.existsSync(manifestPath)) {
    console.log('Backing up existing manifest...');
    fs.copyFileSync(manifestPath, bakPath);
  }
  
  // Atomic replace
  console.log('Installing new manifest...');
  fs.renameSync(tmpPath, manifestPath);
  
  console.log(`✓ Manifest written to: ${manifestPath}`);
  
  // Calculate size
  const stats = fs.statSync(manifestPath);
  const sizeKB = (stats.size / 1024).toFixed(2);
  console.log(`  Size: ${sizeKB} KB`);
  console.log(`  Skills: ${manifest.skills.length}`);
  console.log(`  Categories: ${manifest.categories.length}`);
}

/**
 * Main
 */
function main() {
  const args = process.argv.slice(2);
  
  // Default skill roots
  const homeDir = os.homedir();
  const skillRoots = [
    path.join(homeDir, '.zcode', 'skills'),
    path.join(homeDir, '.agents', 'skills')
  ];
  
  // Allow override via command line
  if (args.length > 0) {
    skillRoots.length = 0;
    skillRoots.push(...args);
  }
  
  try {
    const manifest = generateManifest(skillRoots);
    
    // Write to first root's .router directory
    const manifestPath = path.join(skillRoots[0], '.router', 'manifest.json');
    writeManifestAtomic(manifestPath, manifest);
    
    console.log('\n✓ Done!\n');
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  generateManifest,
  scanSkill,
  parseFrontMatter,
  validateManifest
};
