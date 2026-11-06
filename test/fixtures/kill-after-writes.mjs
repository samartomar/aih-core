// Test-only preload: kills this very process once Core has published its Nth file under AIH_KILL_UNDER and then the
// custody for it under AIH_KILL_STATE, so a consumer can observe an install interrupted between two target effects
// (not inside one). It changes no behaviour before that.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const under = process.env.AIH_KILL_UNDER, state = process.env.AIH_KILL_STATE;
let left = Number(process.env.AIH_KILL_AFTER);
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
if (under && state && left > 0) {
  for (const name of ['renameSync', 'linkSync']) {
    const original = fs[name];
    fs[name] = function (from, to, ...rest) {
      const result = original.call(this, from, to, ...rest);
      const destination = fold(String(to));
      if (left > 0 && destination.startsWith(fold(under))) left--;
      else if (left === 0 && destination.startsWith(fold(state))) process.kill(process.pid, 'SIGKILL');
      return result;
    };
  }
  syncBuiltinESMExports();
}
