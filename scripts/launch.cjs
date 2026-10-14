'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
let executable;
try { executable = require('electron'); } catch {
  console.error('缺少本工程 Electron 依赖，请在工程目录运行 npm ci。');
  process.exit(1);
}
if (!fs.existsSync(executable)) throw new Error('Electron 运行文件缺失，请重新安装依赖。');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root, ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
