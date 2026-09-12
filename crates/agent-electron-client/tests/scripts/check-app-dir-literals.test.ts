import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testFileDir, '..', '..');
const checkerScript = path.join(projectRoot, 'scripts', 'tools', 'check-app-dir-literals.js');
const serviceBootstrapPath = 'src/main/services/sandbox/serviceBootstrap.ts';
const migratePath = 'src/main/bootstrap/migrate.ts';

function writeFile(root: string, relPath: string, content: string) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function runChecker(tempProjectRoot: string) {
  return spawnSync('node', [checkerScript], {
    cwd: tempProjectRoot,
    env: {
      ...process.env,
      NUWAX_APPDIR_PROJECT_ROOT: tempProjectRoot,
    },
    encoding: 'utf8',
  });
}

function withTempProject(assertion: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-appdir-'));
  try {
    assertion(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('check-app-dir-literals script', () => {
  it('passes when the data dir is derived via getAppDataDir()', () => {
    withTempProject((root) => {
      writeFile(
        root,
        serviceBootstrapPath,
        'export function getWorkspaceRoot(): string {\n' +
          '  return path.join(getAppDataDir(), "sandboxes");\n' +
          '}\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('App data dir literal check passed.');
    });
  });

  it('fails on the .nuwaclaw regression in serviceBootstrap', () => {
    withTempProject((root) => {
      writeFile(
        root,
        serviceBootstrapPath,
        'export function getWorkspaceRoot(): string {\n' +
          '  const homeDir = app.getPath("home");\n' +
          '  return path.join(homeDir, ".nuwaclaw", "sandboxes");\n' +
          '}\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[app-dir-literal]');
      expect(result.stderr).toContain(serviceBootstrapPath);
    });
  });

  it('fails on a hardcoded .nuwax literal too', () => {
    withTempProject((root) => {
      writeFile(
        root,
        'src/main/services/logs.ts',
        'export const logDir = "~/.nuwax/logs";\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[app-dir-literal]');
    });
  });

  it('ignores comments and the unrelated .nuwaxcode dir', () => {
    withTempProject((root) => {
      writeFile(
        root,
        'src/main/services/engines/acp.ts',
        '// 说明：默认落在 ~/.nuwaclaw/workspace\n' +
          '/** 文档里也提到 .nuwaclaw */\n' +
          'export const configDir = path.join(isolatedHome, ".nuwaxcode");\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('App data dir literal check passed.');
    });
  });

  it('allows a guarded .nuwaclaw literal in migrate.ts', () => {
    withTempProject((root) => {
      writeFile(
        root,
        migratePath,
        'const LEGACY = [...(APP_NAME_IDENTIFIER === "nuwaclaw" ? [] : [".nuwaclaw"])];\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(0);
    });
  });

  it('fails when the allowlisted file loses its identifier guard', () => {
    withTempProject((root) => {
      writeFile(root, migratePath, 'const LEGACY = [".nuwaclaw"];\n');

      const result = runChecker(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('缺少必需守卫');
    });
  });

  it('skips test files', () => {
    withTempProject((root) => {
      writeFile(
        root,
        'src/main/services/sandbox/serviceBootstrap.test.ts',
        'const expected = ".nuwaclaw";\n',
      );

      const result = runChecker(root);
      expect(result.status).toBe(0);
    });
  });
});
