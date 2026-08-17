import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicDir = join(root, 'public');
const assetsDir = join(root, 'assets');

function run(command: string, args: string[]) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

mkdirSync(publicDir, { recursive: true });
rmSync(assetsDir, { recursive: true, force: true });

// based on https://github.com/supertone-inc/supertonic#getting-started

run('git', ['lfs', 'install']);
run('git', ['clone', 'https://huggingface.co/Supertone/supertonic-3', 'assets']);

try {
  rmSync(join(publicDir, 'onnx'), { recursive: true, force: true });
  rmSync(join(publicDir, 'voice_styles'), { recursive: true, force: true });
  renameSync(join(assetsDir, 'onnx'), join(publicDir, 'onnx'));
  renameSync(join(assetsDir, 'voice_styles'), join(publicDir, 'voice_styles'));
} finally {
  rmSync(assetsDir, { recursive: true, force: true });
}
