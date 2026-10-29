import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (
    process.env.REX_FAULT_MARKER &&
    existsSync(process.env.REX_FAULT_MARKER) &&
    command === '/usr/bin/docker' &&
    args.includes('container') &&
    args.includes('rm')
  ) {
    return original('/usr/bin/false', [], options);
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
