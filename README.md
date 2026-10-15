# ATLAS

## Cloudflare challenge edition — October 14, 2026

This edition adds, on top of ATLAS's governed multi-agent missions:

- **Cloudflare Workers + Artifacts.** A completed mission's base, every agent's branch and the integrated result are published to a per-mission Artifacts repository; the Worker reads each commit back and ATLAS records the publication only when every hash matches.
- **Concurrent agents you can watch.** Independent writers run at the same time in separate worktrees; their work is integrated, re-tested and reviewed before you decide.
- **A dashboard for all of it.** Home (what needs you, what is running, what is ready for review, setup), Activity across missions, Agents (each role's tools, permissions, model tier and limits) and a per-mission Report — the design preview's screens, now built from real data.
- **Every key-based model provider, checked live.** Settings → Test verifies a key at the provider's own API for free; DeepSeek is used only through api.deepseek.com, and its balance is checked too.
- **macOS support**: the sandbox, terminal and packaged app are tested on a Mac.

**Deployment status:** local Mac missions are tested. The Cloudflare Worker is deployed with an Artifacts binding, and a live concurrent mission was published to a per-mission Artifacts repository with every commit hash independently verified (`pnpm test:cloud-live`, see [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)).

- [Run on your Mac and configure model keys](docs/MAC-SETUP.md)
- [Cloudflare integration and deployment](docs/CLOUDFLARE.md)
- [Submission draft and remaining requirement](docs/SUBMISSION.md)
- [Validation report](docs/VALIDATION-2026-10-14.md)

For the concurrent sample, use the objective `[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.` Select the scripted runtime; decisions are scripted, while worktrees, scheduling, edits, integration and checks are real.

**ATLAS is a desktop app where AI agents work on your code, and nothing changes in your project until you've seen
proof that the work is right.**

You tell ATLAS what you want done, in plain words. It plans the work, lets agents do it in a safe copy of your
project, checks the result itself, and shows you the evidence. You decide whether to keep it. Your own files are never
touched along the way.

![A mission waiting for your approval](docs/screenshots/05-approval.png)

## Why ATLAS

- **Your project stays untouched.** Agents work in a separate copy, inside a locked-down sandbox. They cannot see your
  personal files, your passwords or other projects, and they cannot reach the internet unless you allow it.
- **Nothing is taken on trust.** An agent saying "done" counts for nothing. ATLAS runs the tests, the checks and the
  app itself, and only calls the work *verified* when those really pass.
- **You stay in charge.** Anything risky waits for your yes: installing software, using the network, deleting files,
  deploying. You see exactly what will happen and why before it does.
- **Everything is on the record.** Every step, by every agent, is logged with who did it and when. You can replay
  it, export it and hand it to someone else.
- **It works the way teams work.** Share missions, review each other's changes, run a shared board, and let agents
  pick up work, without a server or sign-up.

## How it works

1. **Open a project.** Any folder with git in it.
2. **Describe the outcome.** For example: "Fix the URL slugs for blog post titles so the tests pass."
3. **Approve the plan.** ATLAS shows the tasks, which agents do them, what each may touch, and how the result will be
   checked. Nothing runs before you approve.
4. **Watch the work.** A coder makes the change, a reviewer and a security engineer check it, and ATLAS asks you
   before anything risky.
5. **See the proof.** Tests, review, security scan, browser checks, and optionally a test deployment, all run by ATLAS
   on the final result.
6. **Keep it or throw it away.** Keep the change on its own branch, or open a pull request with one click. Rejecting
   removes it without a trace in your project.

## A tour of the app

Every picture below is the real app, captured while it worked on a small blog project called `northwind-blog`. The
agents in these pictures are ATLAS's built-in demo agents, which follow a script. Everything else is real: the commands,
tests, checks, approvals and records. Run `pnpm screenshots` to capture them again yourself.

### Projects
Open a folder and ATLAS shows its branch, its latest commit, whether it has unsaved changes, and every mission run on
it.

| Before you open a project | With a project |
| --- | --- |
| ![Projects, empty](docs/screenshots/01-projects-empty.png) | ![Projects](docs/screenshots/02-projects.png) |

### Describe what you want
- **What:** write the outcome and any constraints ("don't change the function's name").
- **How careful:** choose whether ATLAS should ask before risky actions, before every change, or only read.
- **Which AI:** pick a model, or use the demo agents, which need no account.
- **Live checks:** ATLAS checks the project as you type: is it a git repository, are there tests, is a sandbox
  available.

![New mission](docs/screenshots/03-new-mission.png)

### Approve the plan
Before anything runs, you see each task, the agent role doing it, what it must achieve, which tools it may use, what
will ask you first, and how ATLAS will check the result.

![Plan review](docs/screenshots/04-plan-review.png)

### Approve risky steps, as they happen
When an agent wants to do something risky, a card shows:
- who is asking;
- exactly what it wants to run or change, and where;
- what it touches, and why it asked.

You approve it once or deny it. Anything waiting for you shows in the title bar, the sidebar, the status bar and the
window title, so you never miss it.

### See exactly what happened
The **Activity** timeline lists every step in order:
- the plan, each command and file change;
- every policy decision and approval;
- each check, and your decisions.

Filter it to what you care about. Agent summaries are labelled as claims, not proof.

| Full timeline | Only approvals and policy decisions |
| --- | --- |
| ![Activity](docs/screenshots/06-activity.png) | ![Filtered](docs/screenshots/06b-activity-filtered.png) |

### The change, and the proof
**Changes** shows the exact edits, file by file. **Evidence** shows the verdict in words, and every check with its
command, result, time and full log. It also says plainly what was *not* checked.

| Changes | Evidence |
| --- | --- |
| ![Changes](docs/screenshots/07-changes.png) | ![Evidence](docs/screenshots/08-evidence.png) |

### Teams of agents, checked by other agents
- **Splitting the work.** Big jobs split into tasks that run side by side, each in its own copy, and are merged at
  the end. If two edits clash, ATLAS stops and tells you rather than guessing.
- **Review.** A reviewer reads every change. A problem only counts as *confirmed* when the reviewer reproduced it
  with a command ATLAS ran.
- **Budgets.** Every mission has limits on time, money spent on the model, and the number of agents.

| Tasks and how they connect | Choosing a test server and a budget |
| --- | --- |
| ![Task graph](docs/screenshots/15-task-graph.png) | ![Composer](docs/screenshots/13-composer-target-budget.png) |

### A security engineer on every change
Every change gets two kinds of security check:
- **The automatic scan** looks for:
  - leaked passwords and keys;
  - code that lets outside input run commands or database queries;
  - switched-off security checks;
  - suspicious new packages, including look-alike names and install scripts;
  - risky changes to CI workflows.
  Serious problems block the change until they're fixed or you dismiss them.
- **A security engineer agent** reads each change the way an attacker would.

![Pipeline and security check](docs/screenshots/25-pipeline-and-security.png)

### Testing in a real browser
If your project is a web app, ATLAS starts it from the finished change in the sandbox. It calls its API, and clicks
through it in a real browser that can only reach your app. A screenshot is saved at every step, and console errors
count as failures.

![Browser QA](docs/screenshots/16-browser-qa.png)

Agents use the same browser the way a careful person would. They read the page as a list of its buttons, fields,
links and text, act on exactly the element they mean, and check the console and network for errors behind what
they see.

### See what changed on screen
When a mission touches a web app, ATLAS shows you the difference instead of describing it. It opens your app's pages
twice, as they were before the mission and as they are now, and compares them pixel by pixel. Under **Visual** you
can:
- drag a slider across the before and after views;
- see every changed pixel highlighted in red;
- read how much of each page changed.

A page that stops loading is flagged. All of this runs on your machine.

![Before and after, compared with a slider](docs/screenshots/36-visual-compare.png)

![Every changed pixel in red](docs/screenshots/37-visual-diff.png)

### Test deployments that are checked, not trusted
You can deploy to a test (staging) server you've allowed, and only after you approve. ATLAS then checks the
deployment independently:
- that the server is really running this exact change;
- that it responds, and how fast;
- that the browser checks pass against it;
- that its logs are clean.

If anything is off, it rolls back to the last good version. ATLAS never deploys to production.

| Your approval to deploy | Deployment history |
| --- | --- |
| ![Deploy approval](docs/screenshots/14-deploy-approval.png) | ![Staging deploy](docs/screenshots/17-staging-deploy.png) |

### From "accepted" to "ready to merge", automatically
Each mission shows where it is: plan, build, verify, accept, pull request, CI, ready to merge. If you allow it, ATLAS
can:
- open the pull request as soon as you accept;
- watch your CI;
- when CI fails, run a fix and push it to the same pull request, up to a limit you set.

It never merges for you, and anything risky inside a fix still waits for a person.

![Automation settings](docs/screenshots/30-team-automation.png)

### Working as a team
Start a team space for a project and invite people with a one-time code. There's no server and no account: the team's
shared record lives in the project's own git repository. In it you can:
- **Share a board.** Add work for a person, for anyone, or for a team's agents. Starting a mission from a card takes
  it, and the card moves to review and then done as the mission progresses.
- **Follow each other's missions.** See their plan, checks and exact change. Comment, approve, or ask for changes.
- **Set up teams that own parts of the code.** A change to the Web team's files can't be published until someone on
  Web approves it.
- **Hand work to agents.** A teammate's machine can pick up cards assigned to agents and run them there, after a
  person approves the plan.

| Start a team space | The shared board |
| --- | --- |
| ![Team start](docs/screenshots/23-team-start.png) | ![Team board](docs/screenshots/24-team-board.png) |

| Review a teammate's change | Waiting for the owning team's approval |
| --- | --- |
| ![Team missions](docs/screenshots/27-team-missions.png) | ![Owner approval](docs/screenshots/26-owner-approval-needed.png) |

| People, teams and invitations | Team activity |
| --- | --- |
| ![People](docs/screenshots/28-team-people.png) | ![Activity](docs/screenshots/29-team-activity.png) |

### Agents that don't lose track
Long jobs fill up a model's memory. ATLAS handles that in three ways:
- **Summaries.** It summarizes older conversation automatically, and the timeline shows when it does.
- **Exact records.** It keeps a precise record the agent can look up at any time: what it was asked to do, the files
  it changed, the commands it ran and their results, and what was refused. Agents don't depend on a summary.
- **A map of the code.** It builds a map of your code in the background: what each file defines, what uses what,
  and which tests cover which file. Agents look things up instead of re-reading everything.

### A desktop the agent can use, and you can take over
For work that needs a real desktop app, an agent gets its own empty virtual screen, never yours. It needs your
permission each time. You can take over, pause or stop it at any moment, and every click is recorded with a screenshot.

| The agent at work | You took over |
| --- | --- |
| ![Desktop, agent](docs/screenshots/21a-desktop-agent.png) | ![Desktop takeover](docs/screenshots/21-desktop-takeover.png) |

### A terminal, exports and imports
- **Terminal.** Open a terminal in any task's copy, inside the same sandbox the agents use.
- **Export.** Export a mission's full record, signed so anyone can check it wasn't altered.
- **Import.** Open someone else's export to read it.

![Terminal](docs/screenshots/19-operator-terminal.png)

### Any AI model, your tools, your procedures
- **Models.** Use any model provider supported by the Pi agent toolkit that ATLAS is built on: Anthropic, OpenAI,
  Google, Mistral, Groq, OpenRouter and many more. Pick a default, a faster and a stronger model, or choose per
  mission. Keys are kept in your system's password store.
- **MCP servers.** Connect tools agents can use, such as documentation search or your issue tracker. Each call can ask
  you first.
- **Web access.** When you turn it on, agents search the web through your Tavily, Brave or Google accounts, read pages
  and browse in a read-only browser. Add several accounts per provider: ATLAS moves to the next one when an account is
  rate limited or out of searches. Sites agents did not find by searching need your approval, and your local network is
  never reachable.
- **Skills.** Reviewed, versioned procedures agents can follow. Write your own, or bring them in from other tools.
- **Sync with Claude Code, Codex and OpenCode.** Keep the same skills and MCP servers in those tools, with a preview
  before anything is written and no secrets copied.

| Models | MCP servers |
| --- | --- |
| ![Models](docs/screenshots/31-settings-models.png) | ![MCP](docs/screenshots/32-settings-mcp.png) |

| Skills | Sync with other tools |
| --- | --- |
| ![Skills](docs/screenshots/33-settings-skills.png) | ![Sync](docs/screenshots/34-settings-sync.png) |

### Settings that keep things tidy and safe
- **Security.** Choose whether security findings block a change or only warn, and whether a security engineer joins
  every plan.
- **Storage.** See what ATLAS keeps on disk, and clear old logs and caches with one click, or let ATLAS do it
  automatically. Your records are never deleted here; you choose how long to keep them.
- **Sandbox, desktop control and test servers.** Choose how commands are isolated, whether agents may use a desktop,
  and which test servers they may deploy to.
- **Agent roles.** See each role's tools and limits.

| Security and storage | Desktop control and test servers |
| --- | --- |
| ![Security and storage](docs/screenshots/35-settings-security-storage.png) | ![Settings](docs/screenshots/11-settings-desktop-deploy.png) |

| Agent roles | Models and runtimes |
| --- | --- |
| ![Roles](docs/screenshots/12-agent-roles.png) | ![Settings](docs/screenshots/09-settings.png) |

### Keyboard first
Press ⌘K (Ctrl+K on Windows and Linux) to jump to any mission or screen. Other shortcuts:

| Shortcut | Opens |
| --- | --- |
| ⌘O | Open a project |
| ⌘N | New mission |
| ⌘1 | Projects |
| ⌘2 | Team |
| ⌘, | Settings |

![Command palette](docs/screenshots/09a-command-palette.png)

## Get started

You need [Node.js](https://nodejs.org) 22.19 or newer, and git.

```bash
corepack enable
pnpm install
pnpm doctor          # checks that everything ATLAS needs is installed (never prints secrets)
pnpm seed:sample     # creates a small example project with a real bug and real tests
pnpm dev             # opens ATLAS
```

Then, in ATLAS:
1. Choose **Open repository**, then the example project.
2. Choose **New mission** and describe the fix.
3. Choose **Plan mission**, then approve the plan.

Watch the agents fix it, then review the evidence and accept or reject the change. The demo agents need no account or
API key. To use a real model, add a provider key in **Settings** and choose **Pi** when you create a mission.

To build an installer: `pnpm package`. It creates an AppImage on Linux, a .dmg on macOS, and an installer on Windows.
The builds are not code-signed yet.

## Where it runs

ATLAS runs on Linux, macOS and Windows, and its full test suite, including the desktop app itself, runs on all three
in CI.

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Sandbox | bubblewrap | Seatbelt | Separate, limited Windows accounts. Set them up once from Settings; Windows asks for your permission |
| Desktop control | Yes | Yes (with XQuartz) | Not available |
| Extra requirements | Chromium for browser checks; Xvfb, xdotool and ImageMagick for desktop control | XQuartz for desktop control | None |

`pnpm doctor` tells you what's missing.

## Privacy and safety

- **Your computer.** ATLAS runs on your computer. Your code goes nowhere except to the AI provider you choose,
  and only for the missions you start.
- **Secrets.** Keys and secrets live in your system's password store. They are blanked out of every log, record and
  export.
- **Contained agents.** Agents only get tools ATLAS controls, never a free shell. Every command runs in the sandbox,
  with no network unless you approve it.
- **What's always refused:** reading your credentials, escaping the project folder, rewriting git history and
  deploying to production.
- **No silent network traffic.** When ATLAS is idle it makes no network requests, and a test checks this.

## For developers

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the app with live reload |
| `pnpm typecheck`, `pnpm lint` | Type checks, linting and dependency rules |
| `pnpm test` | Unit tests (no network, no keys) |
| `pnpm test:integration` | Complete missions against real git repositories |
| `pnpm eval` | A set of standard missions with hidden checks, scored in [docs/eval/latest.md](docs/eval/latest.md) |
| `pnpm test:e2e` | Drives the built desktop app (Linux: `xvfb-run -a pnpm test:e2e`) |
| `pnpm screenshots` | Recaptures the pictures in this README |
| `pnpm package` | Builds installers |

How it fits together: a React interface with no system access talks to a background service through a narrow,
checked channel. The service does all the work: storage, planning, agents, policy, sandboxing, checks and
deployments. The AI runtime is the open-source [Pi agent toolkit](https://github.com/earendil-works/pi) (MIT), kept
behind its own adapter.

Further reading:
- [AGENTS.md](AGENTS.md): a map of the code.
- [docs/adr](docs/adr): the design decisions.
- [docs/spec/status.md](docs/spec/status.md): what is tested, with the evidence for each item.
- [docs/design/DESIGN.md](docs/design/DESIGN.md): the visual design.
