# Run ATLAS on a Mac

Requirements: macOS 14+, Xcode Command Line Tools (`xcode-select --install`), Node.js 22.19+, pnpm 10.28 (`corepack enable`), git.

```sh
git clone https://github.com/premalshah999/ATLAS-Cloudflare && cd ATLAS-Cloudflare
pnpm install --frozen-lockfile
node node_modules/electron/install.js
pnpm exec playwright install chromium
pnpm build && pnpm start          # or package: CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --projectDir apps/desktop
```

## First mission

1. **Open a repository** from Home or Projects (any git project). To try ATLAS on a small project with a real bug and real tests: `pnpm seed:sample ~/atlas-example`.
2. **Settings → Model providers:** paste a key (DeepSeek, Anthropic, OpenAI, Google, Mistral, xAI, Groq, OpenRouter, …) and press **Test** — ATLAS checks it at the provider's own API. Pick a model per tier.
3. **New mission:** describe the outcome and any constraints, optionally a staging target. The orchestrator model proposes a plan; approve it.
4. **Mission Control:** agents run concurrently in isolated worktrees inside the macOS sandbox. Approve risky steps when asked; open any agent to read its thread or direct it.
5. **Decide:** review the patch and the evidence, then accept (keeps the integration branch) and **Publish** to GitHub, or reject.

## Optional

- **GitHub:** `gh auth login` — ATLAS uses the GitHub CLI sign-in to push branches, open pull requests and read CI.
- **Cloudflare Artifacts:** see [CLOUDFLARE.md](CLOUDFLARE.md).
- **Verification config:** add `atlas.config.json` to your repository (checks, app start, API and browser flows, staging deploy) — see the README.

## Troubleshooting

- `pnpm run doctor` checks Node, git, Electron, the sandbox and the browser without printing secrets.
- Keys are stored in the macOS keychain; Settings shows where each key comes from.
- The packaged app is unsigned: open it once with right-click → Open.
