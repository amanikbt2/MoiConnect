const { spawn } = require('node:child_process');
const path = require('node:path');

const nodemonBin = require.resolve('nodemon/bin/nodemon.js');
const child = spawn(process.execPath, [nodemonBin], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, MCONNECT_SANDBOX: 'true' },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
