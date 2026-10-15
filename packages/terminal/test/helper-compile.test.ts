// The Windows sandbox helper is C# compiled on the user's machine. A compile error there disables the sandbox
// (CI run 38159937268: CS0165 turned every Windows sandbox test red), so compile it wherever a compiler exists:
// Mono's mcs on Linux CI, csc on Windows. P/Invoke declarations compile on any platform.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SOURCE } from '../src/win/helper';
import { tmpDir } from '../../../tests/helpers';

const mcs = (() => { try { execFileSync('mcs', ['--version'], { stdio: 'pipe' }); return 'mcs'; } catch { return null; } })();

describe.skipIf(!mcs)('Windows sandbox helper source', () => {
  it('compiles without errors', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'helper.cs');
    writeFileSync(src, HELPER_SOURCE);
    let out = '';
    try { out = execFileSync(mcs!, ['-nologo', `-out:${path.join(dir, 'helper.exe')}`, src], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { out = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? ''); throw new Error(`helper does not compile:\n${out}`); }
    expect(out).not.toMatch(/error CS/);
  });
});
