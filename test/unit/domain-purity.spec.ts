import * as fs from 'fs';
import * as path from 'path';

// NFR-17: domain layers must not import I/O / framework deps.
const FORBIDDEN = ['typeorm', 'axios', '@nestjs', 'better-sqlite3'];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

describe('domain purity (NFR-17)', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const domainFiles = [...walk(root)].filter((p) => p.replace(/\\/g, '/').includes('/domain/'));

  it('finds at least one domain file', () => {
    expect(domainFiles.length).toBeGreaterThan(0);
  });

  for (const f of domainFiles) {
    it(`is pure: ${path.relative(root, f)}`, () => {
      const src = fs.readFileSync(f, 'utf8');
      for (const dep of FORBIDDEN) {
        expect(src.includes(`from '${dep}`)).toBe(false);
        expect(src.includes(`from "${dep}`)).toBe(false);
      }
    });
  }
});

describe('schema portability (NFR-15)', () => {
  it('no JSON1 / SQLite-only types in entities', () => {
    const root = path.join(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const banned = ['JSON_EXTRACT', 'JSON_OBJECT', 'json_each', 'json_group_array'];
    for (const f of walk(root)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const b of banned) if (src.includes(b)) offenders.push(`${f}: ${b}`);
    }
    expect(offenders).toEqual([]);
  });
});
