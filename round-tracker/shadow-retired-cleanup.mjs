import fs from 'node:fs';
import path from 'node:path';

// Only artifacts from these dedicated shadow-training directories are eligible.
// Settlement archives, live production state, audit evidence and unrelated files
// must never be considered for removal.
const ARTIFACT_NAMES = {
  'shadow-v3': /^shadow-v3-automl-\d+\.pkl$/,
  'shadow-v4': /^shadow-v4-arf-\d+\.pkl$/,
  'shadow-v5': /^shadow-v5-minirocket-\d+\.pkl$/,
  'shadow-v7': /^shadow-v7-mapie-arf-\d+\.pkl$/,
  'no-base-specialist': /^no-base-specialist-\d+\.pkl$/,
};

export function cleanupOrphanedShadowArtifacts({
  directories = [],
  protectedModelVersions = [],
  minAgeMs = 10 * 60 * 1000,
  log = () => {},
} = {}) {
  const protectedNames = new Set(protectedModelVersions.filter(Boolean).map(String));
  const result = { deleted: 0, preserved: 0, skipped: 0, errors: 0, byEngine: {} };

  for (const item of directories) {
    const name = String(item?.name || '');
    const pattern = ARTIFACT_NAMES[name];
    if (!pattern || !item?.dir) continue;
    const dir = path.resolve(String(item.dir));
    const entry = { deleted: 0, preserved: 0, skipped: false, errors: 0 };
    result.byEngine[name] = entry;

    // Fail closed: never delete artifacts unless the corresponding registry is
    // valid and authoritative. An unavailable/corrupt registry is not empty.
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
      if (registry?.schemaVersion !== 1 || !Array.isArray(registry.candidates)) {
        entry.skipped = true;
        result.skipped += 1;
        continue;
      }
    } catch {
      entry.skipped = true;
      result.skipped += 1;
      continue;
    }

    const retained = new Set(
      registry.candidates
        .filter(c => c && typeof c.modelPath === 'string' && c.modelPath)
        .map(c => path.resolve(c.modelPath))
    );

    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); }
    catch {
      entry.skipped = true;
      result.skipped += 1;
      continue;
    }

    for (const candidate of files) {
      if (!candidate.isFile() || !pattern.test(candidate.name)) continue;
      const file = path.join(dir, candidate.name);
      const modelVersion = candidate.name.slice(0, -4);
      if (retained.has(file) || protectedNames.has(modelVersion)) {
        entry.preserved += 1;
        result.preserved += 1;
        continue;
      }
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs < minAgeMs) {
          entry.preserved += 1;
          result.preserved += 1;
          continue;
        }
        fs.unlinkSync(file);
        entry.deleted += 1;
        result.deleted += 1;
      } catch {
        entry.errors += 1;
        result.errors += 1;
      }
    }
  }

  // Aggregate counters only: no list of retired model IDs or paths is persisted.
  log('shadow_orphan_artifact_cleanup', result);
  return result;
}
