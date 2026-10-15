# Run ATLAS on macOS

## This Mac

Source: `~/Desktop/ATLAS-Cloudflare`. Sample repository: `~/Desktop/ATLAS-Demo`.

The built Intel Mac app is installed at `~/Applications/ATLAS.app`. Open it from Finder or run `open ~/Applications/ATLAS.app`. The source-based launcher below also works.

```sh
cd ~/Desktop/ATLAS-Cloudflare
pnpm start
```

## A fresh Mac / fresh clone

Install Node.js 22.19+ (Node 24 recommended) and Git. Then:

```sh
git clone https://github.com/premalshah999/ATLAS-Cloudflare.git
cd ATLAS-Cloudflare
corepack enable
corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
node node_modules/electron/install.js
pnpm exec playwright install chromium
pnpm run doctor
pnpm build
pnpm seed:sample ~/ATLAS-Demo
pnpm start
```

Use **`pnpm run doctor`**, not `pnpm doctor`: newer pnpm versions have their own unrelated doctor command.

## Run the concurrent demo

1. Open ATLAS, choose **Open repository**, and select `ATLAS-Demo`.
2. Choose **New mission**. Title: `Parallel implementation and regression coverage`.
3. Objective: `[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.`
4. Keep **Scripted (no model)** and **Ask for risky actions**. Keep the concurrency budget at 2 or higher. Leave the deployment target blank.
5. Review the plan. It must contain independent implementation and regression tasks plus a dependent reviewer. Approve the plan.
6. Open **Tasks** immediately to see the concurrent writers. Inspect **Activity**, **Changes**, **Review**, **Evidence**, and **Browser** after it finishes.
7. In **Cloudflare**, choose **Publish to Cloudflare** after configuring the Worker. This uploads committed source and history. Inspect the returned commit matches.
8. **Accept changes** preserves the integration branch. The original checkout is unchanged. Acceptance does not merge it into `main`.

The scripted runtime makes deterministic decisions. The isolated worktrees, concurrent scheduling, edits, merge, tests and browser checks are real. Remote publication to Cloudflare Artifacts is live-verified; see [Cloudflare setup](CLOUDFLARE.md). For a fresh demonstration, seed a new sample path; do not reset a repository containing work you want to retain.

## Add model keys

Open **Settings → Model provider keys**. Key-entry support is available for Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Groq, Mistral and Cerebras. Save whichever providers you use; you do not need all nine. Keys are encrypted through Electron safeStorage / macOS Keychain and never committed to source.

In **Model selection**, choose a `provider/model` from the available-model suggestions or leave it blank for automatic selection. Then create a mission with **Pi** selected. Provider availability in Settings means the SDK has credentials, not that billing, key permissions or a live request have been tested. Live provider calls incur the provider's normal usage charges.

For shell-based setup, the corresponding variables are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, and `CEREBRAS_API_KEY`. `ATLAS_MODEL=provider/model` is also supported when no model is saved in Settings. Do not put keys in tracked files or command history.

## App bundle

```sh
pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --projectDir apps/desktop
```

The bundle is `apps/desktop/release/mac/ATLAS.app` on Intel Macs (the arm64 output directory differs). This development build is unsigned and not notarized. Node and Git still need to be installed for agent commands. Finder launches include common Node locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`); for an nvm-only installation, launch from its configured Terminal.

Desktop automation through Xvfb is Linux-only. macOS supports the mission workflow and Seatbelt sandbox; it does not provide Linux's private process namespace. The Terminal panel uses Python 3 from Apple Command Line Tools (`/usr/bin/python3`). The staging, terminal, audit export and import flow has also been exercised on this Mac.

## Troubleshooting

- Electron says `bad option: --remote-debugging-port`: use `pnpm start`, which clears an IDE-inherited `ELECTRON_RUN_AS_NODE` variable.
- No browser available: `pnpm exec playwright install chromium`, then relaunch.
- No sandbox: inspect `pnpm run doctor`. Do not enable unsandboxed execution to conceal a failure.
- Artifacts access denied / error 10403: Workers Paid is required. See [Cloudflare setup](CLOUDFLARE.md).
- Failed mission: open **Evidence** and inspect the actual command logs. Do not accept an agent's summary as a passing check.
