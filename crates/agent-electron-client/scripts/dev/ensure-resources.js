#!/usr/bin/env node
/**
 * dev 启动前的 bundled 资源自检与自动补齐。
 *
 * 背景：resources/ 下各打包期资源（nuwax-file-server/nuwaxcode/ACP 适配器/node/uv…）
 * 均在 .gitignore（由 prepare:* 脚本生成），fresh clone 后缺失会导致
 * 「缺少必需依赖，无法启动服务」且文件服务 exit 1——本脚本在 dev 启动前
 * 检查缺失项并自动执行对应 prepare 脚本，杜绝裸跑出死服务。
 *
 * 用法：
 *   node scripts/dev/ensure-resources.js [--full]
 *     --full   缺失的可选资源也一并补齐（等同跑一遍 prepare:all 的缺失子集）
 *   环境变量 SKIP_PREPARE=1 跳过自动补齐（仅打印缺失警告）
 *
 * 与 src/main/services/system/dependencyChecker.ts 的 required 清单保持
 * 语义一致（脚本侧无法直接 import TS，此处为镜像表，改清单时同步改这里）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const clientRoot = path.resolve(__dirname, '..', '..');
const resourcesDir = path.join(clientRoot, 'resources');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const full = process.argv.includes('--full');
const skip = process.env.SKIP_PREPARE === '1';

/**
 * 资源清单：marker 为存在性判据（与 binaryLocator/服务启动的实际读取对齐）
 * required=true 时缺失会导致必需服务起不来（对应 UI「缺少必需依赖」告警）
 */
const RESOURCES = [
  { script: 'prepare:uv', dir: 'uv', marker: ['bin'], required: true },
  {
    script: 'prepare:nuwax-file-server',
    dir: 'nuwax-file-server',
    marker: ['package.json', path.join('dist', 'server.js')],
    required: true,
  },
  {
    script: 'prepare:nuwaxcode',
    dir: 'nuwaxcode',
    marker: ['.version'],
    required: true,
  },
  {
    script: 'prepare:claude-code-acp-ts',
    dir: 'claude-code-acp-ts',
    marker: ['package.json'],
    required: true,
  },
  {
    script: 'prepare:codex-acp-ts',
    dir: 'nuwax-codex-acp-ts',
    marker: ['package.json'],
    required: true,
  },
  { script: 'prepare:mcp-proxy', dir: 'mcp-proxy-ts', marker: ['package.json'], required: true },
  { script: 'prepare:lanproxy', dir: 'lanproxy', marker: ['binaries'], required: true },
  { script: 'prepare:ttyd', dir: 'ttyd', marker: ['binaries'], required: true },
  ...(isWin ? [{ script: 'prepare:git', dir: 'git', marker: ['bin'], required: true }] : []),
  { script: 'prepare:node', dir: 'node', marker: [], required: false },
  { script: 'prepare:ripgrep', dir: 'ripgrep', marker: ['bin'], required: false },
  { script: 'prepare:gui-server', dir: 'agent-gui-server', marker: [], required: false },
  { script: 'prepare:sandboxed-mcp', dir: 'sandboxed-bash-mcp', marker: [], required: false },
];

function isPresent(item) {
  const dir = path.join(resourcesDir, item.dir);
  if (!fs.existsSync(dir)) return false;
  if (item.marker.length === 0) return true;
  return item.marker.every((m) => fs.existsSync(path.join(dir, m)));
}

function runScript(name) {
  return new Promise((resolve) => {
    console.log(`[ensure-resources] 运行 npm run ${name} ...`);
    const child = spawn(npmCmd, ['run', name], {
      cwd: clientRoot,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      console.error(`[ensure-resources] ${name} 启动失败: ${err.message}`);
      resolve(false);
    });
  });
}

async function main() {
  const missing = RESOURCES.filter((item) => !isPresent(item));
  const requiredMissing = missing.filter((m) => m.required);
  const optionalMissing = missing.filter((m) => !m.required && full);

  if (missing.length === 0) {
    console.log('[ensure-resources] bundled 资源齐备');
    return;
  }

  const all = [...requiredMissing, ...optionalMissing];
  console.log(
    `[ensure-resources] 缺失 ${missing.length} 项（必需 ${requiredMissing.length} / 可选 ${optionalMissing.length}）：` +
      all.map((m) => m.dir).join(', '),
  );

  if (skip) {
    console.warn('[ensure-resources] SKIP_PREPARE=1，跳过自动补齐（服务可能起不来）');
    return;
  }

  let failed = [];
  for (const item of all) {
    const ok = await runScript(item.script);
    if (!ok) {
      failed.push(item);
      if (item.required) {
        console.error(
          `[ensure-resources] 必需资源 ${item.dir} 补齐失败（${item.script}），` +
            'dev 服务的对应能力将不可用；可修复后重跑，或 SKIP_PREPARE=1 跳过自检',
        );
      }
    }
  }

  const stillMissing = all.filter((item) => !isPresent(item));
  if (stillMissing.length > 0) {
    console.warn(
      `[ensure-resources] 以下资源仍未就绪: ${stillMissing.map((m) => m.dir).join(', ')}`,
    );
  }
  if (requiredMissing.some((item) => failed.includes(item))) {
    process.exitCode = 1;
  }
  console.log('[ensure-resources] 完成');
}

main().catch((err) => {
  console.error('[ensure-resources] 未捕获异常:', err);
  process.exit(1);
});
