/** 构建 main：esbuild 打 CJS 产物到 dist/，并拷贝 SQL migrations */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // electron 运行时原生提供；better-sqlite3 是原生模块，运行时按 ABI 加载
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(dist, 'index.cjs'),
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/preload.ts')],
  outfile: path.join(dist, 'preload.cjs'),
});

// 拷贝 migrations（db/index.ts 运行时按 dist/migrations 解析）
const migrationsSrc = path.join(root, 'src/db/migrations');
const migrationsDest = path.join(dist, 'migrations');
fs.mkdirSync(migrationsDest, { recursive: true });
for (const file of fs.readdirSync(migrationsSrc)) {
  if (file.endsWith('.sql')) {
    fs.copyFileSync(path.join(migrationsSrc, file), path.join(migrationsDest, file));
  }
}

console.log('main build done →', dist);
