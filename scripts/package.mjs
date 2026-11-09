// Build a self-contained release: release/homebase-<version>.tar.gz (+ .sha256).
// The tarball needs only Node.js 22.13+ on the target machine — no npm install.
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `homebase-${pkg.version}`;
const out = path.join(root, 'release');
const stage = path.join(out, name);

execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {cwd: root, stdio: 'inherit'});
rmSync(stage, {recursive: true, force: true});
mkdirSync(stage, {recursive: true});
for (const f of ['server', 'dist', 'system', 'install.sh', 'uninstall.sh', 'config.example.json', 'README.md', 'LICENSE']) {
  cpSync(path.join(root, f), path.join(stage, f), {recursive: true, filter: src => !/__pycache__|\.pyc$/.test(src)});
}
// Runtime manifest only: the server has no npm dependencies.
const {name: n, version, description, engines, type, license} = pkg;
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({name: n, version, description, engines, type, license, scripts: {start: 'node server/index.mjs'}}, null, 2) + '\n');
for (const f of ['install.sh', 'uninstall.sh', 'system/install-power.py', 'system/homebase-power', 'system/server-smart-sleep', 'system/server-night-sleep']) chmodSync(path.join(stage, f), 0o755);

const tarball = path.join(out, `${name}.tar.gz`);
execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-czf', tarball, '-C', out, name]);
const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(`${tarball}.sha256`, `${sum}  ${name}.tar.gz\n`);
rmSync(stage, {recursive: true});
console.log(`\n${path.relative(root, tarball)}\nsha256 ${sum}`);
