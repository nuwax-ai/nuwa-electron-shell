#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 守卫：src/main 内不得硬编码应用数据目录名（.nuwax / .nuwaclaw）字面量。
 *
 * 背景：数据目录必须随构建期产品标识派生（APP_DATA_DIR_NAME / getAppDataDir()），
 * 否则商业版（identifier=nuwax）会把数据写进社区版目录 ~/.nuwaclaw，破坏两者隔离。
 * 2026-09 实际发生过：sandbox/serviceBootstrap.ts 的沙箱工作区根目录硬编码
 * ".nuwaclaw"，导致商业版沙箱工作区落进社区版数据目录。
 *
 * 允许清单只应包含「同时带 identifier 守卫」的文件（如 migrate.ts 的迁移来源），
 * 清单内的文件若丢掉了守卫片段，同样判失败。
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.NUWAX_APPDIR_PROJECT_ROOT
  ? path.resolve(process.env.NUWAX_APPDIR_PROJECT_ROOT)
  : path.resolve(__dirname, '..', '..');
const MAIN_ROOT = path.join(PROJECT_ROOT, 'src', 'main');

/**
 * 允许清单：relPath → 必须同时出现的守卫片段。
 * migrate.ts 有意保留 ".nuwaclaw" 作为「仅社区版启用」的迁移来源与路径改写前缀。
 */
const ALLOWED = [
  {
    relPath: 'src/main/bootstrap/migrate.ts',
    requiredGuard: 'APP_NAME_IDENTIFIER === "nuwaclaw"',
  },
];

/**
 * 匹配字符串字面量里完整的目录名 ".nuwax" 或 ".nuwaclaw"。
 * 注意二者不是前缀关系（nuwaclaw = nuwa + claw，不含 nuwax），必须写成两个分支。
 * 尾随负向前瞻排除同前缀但不同用途的名字：.nuwaxcode（nuwaxcode 工具的配置目录，
 * 位于 isolatedHome 下、产品中立）与 .nuwax-agent（远古遗留目录，两产品共用）。
 */
const DIR_LITERAL = /['"`][^'"`]*\.nuwa(x|claw)(?![A-Za-z0-9_-])/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释：用 (^|[^:]) 避开 https:// 里的 //
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const violations = [];

  for (const file of walk(MAIN_ROOT)) {
    const relPath = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    if (!DIR_LITERAL.test(code)) continue;

    const allowed = ALLOWED.find((entry) => entry.relPath === relPath);
    if (allowed) {
      if (!code.includes(allowed.requiredGuard)) {
        violations.push(
          `${relPath}: 在允许清单内，但缺少必需守卫 \`${allowed.requiredGuard}\`——` +
            `失去守卫后等同于硬编码目录`,
        );
      }
      continue;
    }

    for (const [index, line] of code.split('\n').entries()) {
      if (DIR_LITERAL.test(line)) {
        violations.push(`${relPath}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('[app-dir-literal] 发现硬编码的应用数据目录字面量：');
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error(
      '请改用 getAppDataDir()（src/main/services/system/appPaths.ts）或 APP_DATA_DIR_NAME 派生；' +
        '确需字面量时走 identifier 守卫并加入本脚本的 ALLOWED 清单。',
    );
    process.exit(1);
  }

  console.log('App data dir literal check passed.');
}

main();
