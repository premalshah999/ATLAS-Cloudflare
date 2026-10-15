// Windows: set up (or remove) the ATLAS sandbox accounts from the command line (ADR 0020). The same operation as
// Settings → Execution isolation → Set up sandbox accounts; needs administrator rights (CI runners have them).
//   pnpm exec vite-node scripts/win-sandbox.ts setup | remove | status
import { detectSandbox, removeWindowsAccounts, setupWindowsAccounts, windowsAccounts } from '../packages/terminal/src';

const cmd = process.argv[2] ?? 'status';
if (process.platform !== 'win32') { console.log('Not Windows: nothing to do.'); process.exit(0); }
if (cmd === 'setup') {
  const a = setupWindowsAccounts();
  console.log(`accounts: ${a.offline.name} ${a.offline.sid}, ${a.network.name} ${a.network.sid}; firewall rule: ${a.firewall ? 'ok' : 'FAILED'}`);
} else if (cmd === 'remove') {
  removeWindowsAccounts();
  console.log('removed');
} else {
  console.log(JSON.stringify(windowsAccounts()));
}
const sb = detectSandbox(true);
console.log(`sandbox: ${sb.kind} · ${sb.detail}`);
if (cmd === 'setup' && sb.kind !== 'windows-account') process.exit(1);
