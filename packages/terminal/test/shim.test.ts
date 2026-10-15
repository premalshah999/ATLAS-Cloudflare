// Windows .cmd shims are run as `node <script>` so cmd.exe never runs inside the AppContainer (CI bisection:
// cmd needs to list every ancestor directory). Pure parsing, tested on every platform.
import { describe, expect, it } from 'vitest';
import { shimTarget } from '../src/win/appcontainer';

const NPM_CMD = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;
const CMD_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\pnpm\\bin\\pnpm.cjs" %*
`;

describe('shimTarget', () => {
  it("npm's own npm.cmd runs npm-cli.js (not the prefix helper)", () => {
    expect(shimTarget(NPM_CMD, 'C:\\node\\npm.cmd')).toBe('C:\\node\\node_modules\\npm\\bin\\npm-cli.js');
  });
  it('cmd-shim shims run their target script', () => {
    expect(shimTarget(CMD_SHIM, 'C:\\tools\\.bin\\pnpm.cmd')).toBe('C:\\tools\\pnpm\\bin\\pnpm.cjs');
  });
  it('a batch file that does not wrap a script stays a batch file', () => {
    expect(shimTarget('@echo off\r\necho hello %*\r\n', 'C:\\x\\hello.cmd')).toBeNull();
  });
});
