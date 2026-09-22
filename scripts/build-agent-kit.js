#!/usr/bin/env node
/**
 * 跨平台包装 build:agent-kit：CI=true 语义（抑制 pnpm 交互/遥测）在 Windows
 * cmd 下无法用 `CI=true cmd` 内联语法表达（'CI' is not recognized，v1.0.27
 * win 腿 Install workspace dependencies 实证 ELIFECYCLE exit 1）。
 * 顺序执行 agent-kit install + build（file: override 快照的前置）。
 */
const { spawnSync } = require('child_process');

process.env.CI = 'true';
const opts = { stdio: 'inherit', shell: true };

let r = spawnSync(
  'pnpm',
  ['-C', 'crates/agent-kit', 'install', '--ignore-workspace', '--prefer-offline'],
  opts
);
if (r.status !== 0) process.exit(r.status ?? 1);

r = spawnSync('pnpm', ['-C', 'crates/agent-kit', 'run', 'build'], opts);
process.exit(r.status ?? 1);
