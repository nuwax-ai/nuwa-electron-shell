#!/usr/bin/env node
/**
 * 构建 lanproxy 客户端：把 src/main/services/lanproxy/cli.ts 打成单文件
 *   resources/lanproxy/bin/lanproxy-client.js
 *
 * 运行时由主进程以 process.execPath + ELECTRON_RUN_AS_NODE=1 执行（见 serviceManager.startLanproxyOnce），
 * 与平台、架构无关，安装包内不再携带任何 lanproxy 原生可执行文件。
 *
 * 打包时 electron-builder 的 extraResources 会把 resources/lanproxy 拷到 Resources/lanproxy。
 */

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const { getProjectRoot } = require('../utils/project-paths');

const projectRoot = getProjectRoot();
const lanproxyRoot = path.join(projectRoot, 'resources', 'lanproxy');
const entry = path.join(projectRoot, 'src', 'main', 'services', 'lanproxy', 'cli.ts');
const outfile = path.join(lanproxyRoot, 'bin', 'lanproxy-client.js');

/** 旧版随包的原生二进制及其标记文件；本地工作树残留时清掉，避免被再次打进安装包 */
function removeLegacyBinaries() {
  fs.rmSync(path.join(lanproxyRoot, 'binaries'), { recursive: true, force: true });
  for (const name of ['nuwax-lanproxy', 'nuwax-lanproxy.exe', '.platform-key']) {
    fs.rmSync(path.join(lanproxyRoot, 'bin', name), { force: true });
  }
}

function main() {
  removeLegacyBinaries();
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const kb = (fs.statSync(outfile).size / 1024).toFixed(1);
  console.log(`[prepare-lanproxy] ✓ ${path.relative(projectRoot, outfile)} (${kb} KB)`);
}

main();
