#!/usr/bin/env node
/**
 * dev:electron 前置：等待 vite dev server 就绪。
 * 端口跟随 NUWAX_PORT_OFFSET（与 vite.config server.port 同式）：
 * 社区 dev（offset=0）等 60173；商业 dev（nuwa-work in-base 注入 1000）等 61173。
 */
const waitOn = require('wait-on');

const offset =
  Math.max(0, Number.parseInt(process.env.NUWAX_PORT_OFFSET?.trim() ?? '0', 10) || 0);
const port = 60173 + offset;
const url = `http://localhost:${port}/`;

waitOn({ resources: [url], timeout: 180_000 }, (err) => {
  if (err) {
    console.error(`[wait-vite] timeout waiting ${url}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[wait-vite] vite ready at ${url}`);
});
