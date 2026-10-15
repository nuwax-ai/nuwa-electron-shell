#!/usr/bin/env node
/**
 * 从 node_modules 复制 pi-acp（ACP adapter）与 @earendil-works/pi-coding-agent
 * （pi agent，运行时由 pi-acp spawn）到 resources/。
 *
 * pi-acp 的 dist/index.js 是 **ESM 且不内联** `@agentclientprotocol/sdk` / `cross-spawn`
 * / `zod`（node: 内置除外），运行时按包根 node_modules 解析。因此产物按 npm 布局扁平拷贝：
 *
 * 产物（resources/pi-acp/）：
 *   ├── dist/index.js                       pi-acp 入口（ESM）
 *   ├── package.json                        精简（name/version/bin/main/type）
 *   ├── node_modules/pi-acp/                ESM 自引用（其内 import 依赖从这里解析）
 *   ├── node_modules/@agentclientprotocol/sdk/
 *   ├── node_modules/cross-spawn/ (+ cross-spawn 依赖亦扁平带入)
 *   ├── node_modules/zod/
 *   ├── node_modules/pi/                    pi coding agent（自包含 bundle，~9MB）
 *   │   ├── bin/pi.js
 *   │   └── dist/bundle/**
 *   └── node_modules/<其余运行时依赖>/
 *
 * 运行时 spawn 链：spawn(node, [<resources>/pi-acp/node_modules/pi-acp/dist/index.js])
 *   → pi-acp spawn(process.env.PI_ACP_PI_COMMAND, ["--mode","rpc","--no-themes"])
 *   = <resources>/pi-acp/node_modules/pi/bin/pi.js
 *
 * 前提：pnpm install 已执行（dependencies 含 pi-acp / @earendil-works/pi-coding-agent）。
 * 打包时 electron-builder extraResources 打包到 .app/Contents/Resources/pi-acp/。
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { getProjectRoot } = require('../utils/project-paths');

const ACP_PKG_NAME = 'pi-acp';
const PI_PKG_NAME = '@earendil-works/pi-coding-agent';
const BUNDLED_DIR_NAME = 'pi-acp';

const projectRoot = getProjectRoot();

function resolvePkgDir(pkgName) {
  // 依赖不 declare CJS main / package.json export（pi 的 exports 只有 dist 子路径），
  // require.resolve 不可靠；pnpm/npm 都把包放在 <root>/node_modules/<name>（symlink）。
  const nmDir = path.join(projectRoot, 'node_modules', ...pkgName.split('/'));
  const pkgFile = path.join(nmDir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (pkg.name === pkgName) return fs.realpathSync(nmDir);
  }
  console.error(`[prepare-pi-acp] node_modules 中未找到 ${pkgName}`);
  console.error('[prepare-pi-acp] 请先执行 pnpm install');
  process.exit(1);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // 跳过符号链接（prepare-all Phase 3 有兜底清洗）
  }
}

const COPY_FILTERS = [
  /(^|[\\/])\.bin([\\/]|$)/,
  /\.ts$/,
  /\.map$/,
  /(^|[\\/])test(s)?([\\/]|$)/,
  /(^|[\\/])docs?([\\/]|$)/,
  /(^|[\\/])examples?([\\/]|$)/,
  /(^|[\\\/])prebuilds?([\\/]|$)/,
  /(^|[\\\/])native([\\/]|$)/,
];

function shouldCopy(relPath) {
  return !COPY_FILTERS.some((re) => re.test(relPath));
}

/** 递归拷贝依赖包（带过滤），返回字节数 */
function copyPkgFiltered(srcDir, destDir, prefix = '') {
  let bytes = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!shouldCopy(rel)) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) bytes += copyPkgFiltered(s, d, rel);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      bytes += fs.statSync(d).size;
    }
  }
  return bytes;
}

/**
 * 扁平拷贝 npm 依赖树到 destRoot/node_modules/（name → 真实包目录去重）。
 * pnpm 布局下依赖在虚拟 store 的兄弟目录，逐包从源包 package.json 依赖闭包解析。
 */
function collectRuntimeDeps(entryPkgDir, destRoot) {
  const seen = new Map(); // name -> srcDir
  const queue = [entryPkgDir];
  while (queue.length) {
    const pkgDir = queue.pop();
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const name of deps) {
      if (seen.has(name)) continue;
      let depPkgJson = null;
      // 先试 require.resolve（ESM-only 包退 n_m 路径拼接）
      try {
        depPkgJson = require.resolve(`${name}/package.json`, { paths: [pkgDir] });
      } catch {
        const guess = path.join(pkgDir, 'node_modules', name, 'package.json');
        if (fs.existsSync(guess)) depPkgJson = guess;
        else {
          // pnpm 虚拟 store：源包的兄弟目录
          const sib = path.join(path.dirname(pkgDir), name, 'package.json');
          if (fs.existsSync(sib)) depPkgJson = sib;
        }
      }
      if (!depPkgJson) {
        console.warn(`[prepare-pi-acp] ⚠️ 依赖 ${name} 未解析到（包 ${pkg.name}），跳过`);
        continue;
      }
      const depDir = fs.realpathSync(path.dirname(depPkgJson));
      seen.set(name, depDir);
      queue.push(depDir);
    }
  }
  // 写入 destRoot/node_modules/（含包自身的自引用，ESM import 需要）
  for (const [name, depDir] of seen) {
    const dest = path.join(destRoot, 'node_modules', ...name.split('/'));
    const bytes = copyPkgFiltered(depDir, dest);
    console.log(`  node_modules/${name} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  }
  return seen;
}

function main() {
  // 1. pi-acp adapter
  const acpDir = resolvePkgDir(ACP_PKG_NAME);
  const acpPkg = JSON.parse(fs.readFileSync(path.join(acpDir, 'package.json'), 'utf8'));
  console.log(`[prepare-pi-acp] adapter 源: ${acpPkg.name}@${acpPkg.version}`);
  const acpEntry = path.join(acpDir, 'dist', 'index.js');
  if (!fs.existsSync(acpEntry)) {
    console.error(`[prepare-pi-acp] dist/index.js 不存在: ${acpEntry}`);
    process.exit(1);
  }

  // 2. pi coding agent（自包含 bundle）
  const piDir = resolvePkgDir(PI_PKG_NAME);
  const piPkg = JSON.parse(fs.readFileSync(path.join(piDir, 'package.json'), 'utf8'));
  console.log(`[prepare-pi-acp] pi 源: ${piPkg.name}@${piPkg.version}`);
  const piBundleDir = path.join(piDir, 'dist', 'bundle');
  if (!fs.existsSync(path.join(piBundleDir, 'cli.js'))) {
    console.error(`[prepare-pi-acp] pi dist/bundle/cli.js 不存在: ${piBundleDir}`);
    process.exit(1);
  }

  // 3. 复制到 resources/pi-acp/
  const destDir = path.join(projectRoot, 'resources', BUNDLED_DIR_NAME);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true });
  fs.mkdirSync(path.join(destDir, 'dist'), { recursive: true });

  // node_modules 扁平运行时依赖（pi-acp 自引用 + sdk/cross-spawn/zod 闭包）
  collectRuntimeDeps(acpDir, destDir);
  // pi-acp 自引用（ESM import 从自身包解析依赖时的锚点）：整包已含 dist，
  // 这里再拷精简副本到 node_modules/pi-acp/，入口统一走 node_modules/pi-acp/dist/index.js
  const destAcpSelf = path.join(destDir, 'node_modules', 'pi-acp');
  copyPkgFiltered(acpDir, destAcpSelf);

  // node_modules/pi（package.json + bin + dist/bundle，不带 provider SDK 全家桶）
  const destPiDir = path.join(destDir, 'node_modules', 'pi');
  const piBinSrc = path.join(piDir, 'bin');
  if (fs.existsSync(piBinSrc)) copyDir(piBinSrc, path.join(destPiDir, 'bin'));
  copyDir(path.join(piDir, 'dist', 'bundle'), path.join(destPiDir, 'dist', 'bundle'));
  // pi-acp spawn 时用 `pi --version` 做版本展示；package.json 必需
  fs.copyFileSync(path.join(piDir, 'package.json'), path.join(destPiDir, 'package.json'));
  const piEntryJs = path.join(destPiDir, 'bin', 'pi.js');
  if (fs.existsSync(piEntryJs)) fs.chmodSync(piEntryJs, 0o755);
  {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      }
    };
    walk(destPiDir);
    console.log(`  node_modules/pi (${piPkg.version}, ${(total / 1024 / 1024).toFixed(2)} MB)`);
  }

  // 根 dist/index.js 转发到 node_modules/pi-acp/dist/index.js（spawn 目标）
  fs.writeFileSync(
    path.join(destDir, 'dist', 'index.js'),
    "import('../node_modules/pi-acp/dist/index.js');\n",
  );

  // 精简 package.json（type:module 让 ESM 入口无警告）
  const slimPkg = {
    name: acpPkg.name,
    version: acpPkg.version,
    type: 'module',
    bin: { 'pi-acp': './dist/index.js' },
    main: './dist/index.js',
  };
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(slimPkg, null, 2) + '\n');

  console.log(`[prepare-pi-acp] ✓ resources/${BUNDLED_DIR_NAME}/ (${acpPkg.version} + pi ${piPkg.version})`);
}

module.exports = { resolvePkgDir, shouldCopy, COPY_FILTERS, collectRuntimeDeps };

if (require.main === module) main();
