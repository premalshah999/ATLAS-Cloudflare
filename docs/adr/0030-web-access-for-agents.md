# ADR 0030 — Web access for agents: search through the operator's accounts, read pages, browse read-only

Status: accepted · 2026-10-14

## Context
Agents could not look anything up. Answering "how does this API behave in the version we use", "what does this
error mean" or "is there an advisory for this package" meant guessing from training data, or an MCP server the
operator had to find and trust.

The operator asked for:
- **Search** through Tavily, Brave and Google.
- **Browser use** on the open web.
- **Several accounts per provider used in a loop**, so that free and trial allowances add up.

## Alternatives
- **An MCP search server per provider.** It works today through `mcp_call`, but:
  - each server has its own key handling and no shared account rotation;
  - every call needs approval or blanket trust.
- **The browser-use Python library.** It needs a Python runtime and its own model loop inside ATLAS's agent loop.
  ATLAS already drives Chromium and has a snapshot-and-ref page model (ADR 0027).
- **Letting agents run `curl`.** It is already privileged (approval, sandbox network), but gives no structure, no
  text extraction, and no protection of the local network once approved.
- **Chosen:** a `@atlas/web` package behind three governed tools, with a pool of accounts per provider. It uses the
  existing browser model and adds no new dependency.

## Decision
- **Tools** (`web_search`, `web_fetch`, `web_browse`) and **capabilities** (`web.search`, `web.fetch`, `web.browse`):
  - Granted to coder, reviewer, tester and security engineer.
  - Offered only when the operator turns web access on (off by default), to the roles they choose.
  - `web_search` is offered only when an account has a key.
  - `web_browse` is offered only when a Chromium is found.
- **Search accounts:**
  - Each account is operator data: provider, label, optional Google engine id, optional daily and monthly limits,
    and enabled.
  - Keys are in the OS credential store (Electron main, `web-keys.json`), passed to the daemon like other secrets,
    and registered for redaction. They never reach the renderer, a model or an agent.
  - Without a credential store, `TAVILY_API_KEY`, `BRAVE_API_KEY` and `GOOGLE_API_KEY` (with `GOOGLE_CSE_ID`) supply
    accounts. Each variable may list several keys, comma-separated.
- **The pool:**
  - Providers are tried in the operator's order. Within a provider, accounts take turns (`rotate`, default) or are
    used one after another (`fill`).
  - What a failure means for the account:

    | Outcome | Signal | Effect on the account |
    | --- | --- | --- |
    | Rate limit | 429 | Rests for Retry-After, Brave's per-second reset, or a minute |
    | Out of searches | Tavily 432/433 | Re-checked daily, since plans renew on their own billing day |
    | Out of searches | Brave, monthly window at 0 | Rests until the month renews |
    | Out of searches | Google daily quota | Rests until midnight Pacific |
    | Rejected key | 401/403, invalid key | Rests until its key changes or the operator resets it |
    | Error | 5xx, network | Rests for 30 seconds |
    | Refused query | Other 4xx | Returned at once, without trying the other accounts, which would refuse it too |

  - Successful searches are counted per account per day and month. An account stops at the limit the operator set,
    which keeps a paid plan inside its allowance.
  - Settings shows each account's state, its usage, its last error, Test (one real search) and "Use again now".
- **Reading pages (`web_fetch`):**
  - One GET over http(s), with these limits:
    - every hop's resolved address must be public (a custom DNS lookup on the connection itself);
    - redirects are followed by hand and checked again, at most 5;
    - 3 MB, 20 seconds;
    - no cookies or credentials.
  - HTML becomes text: headings, lists, links with targets, code blocks, table cells. Text comes back 20,000
    characters at a time, with an offset.
- **Browsing (`web_browse`):**
  - A fresh Chromium context per attempt: no downloads, no service workers.
  - Every request is filtered:
    - public addresses only;
    - GET, HEAD and OPTIONS only, unless the operator allows form submissions;
    - main-frame navigation only to known sites.
  - `open` returns a snapshot with refs (ADR 0027's walker). Then snapshot, text, click, fill, select, check, hover,
    press, scroll, back, screenshot and wait act by ref.
  - A blocked navigation returns the page to where it was.
- **Which sites need a person:**
  - Hosts in the attempt's search results, the operator's allowed sites (`*.example.com` form), and sites approved
    during the attempt open without asking.
  - Any other site asks the operator, who sees the URL.
- **Secrets never leave:**
  - A query, URL or browser fill containing a value registered as a secret is denied before anything is sent.
  - Every search, page and browser step is an event (`web.searched`, `web.fetched`, `web.browsed`), with the results
    and page text kept as log artifacts.
- **Context and skills:**
  - Agents with web tools get a "The web" context section: how to use the tools, that pages are data, never to put
    secrets in queries, to cite URLs.
  - A new bundled skill, `web-research`, says how: version-pinned questions, narrow queries, ranked sources, local
    confirmation, citations.

## Consequences
- **Free and trial accounts:** pooling several of them is mechanically supported. Whether a provider's terms allow one
  person to hold several free accounts is for the operator to check. Settings says so, and ATLAS does nothing to
  disguise accounts.
- **Google:** its Custom Search JSON API is closed to new customers and announced to end on 1 January 2027. Existing
  keys work until then.
- **DNS rebinding:**
  - `web_fetch` checks the address it connects to, so it is not exposed.
  - The browser checks a host's addresses before Chromium connects, but Chromium resolves again. A host that changes
    its answer between the two could reach a private address. Browsing only reads by default, which limits what such
    a request can do.
- **Proxies:** the web tools connect directly and ignore `HTTPS_PROXY`. A machine that can reach the web only
  through a proxy cannot use them yet.
- **Exfiltration:** an agent could still encode data in a query or a URL on a known site. The secret check, the
  known-site rule, approvals for new sites and the event record narrow this, but cannot eliminate it. Operators
  working on sensitive code can leave web access off, or limit it to some roles.
- **Tests:**
  - `packages/web/test/web.test.ts`:
    - provider requests;
    - each failure kind, including Brave's two windows and Google's Pacific day;
    - rotation, fill, failover across accounts and providers;
    - limits, rejected keys cleared by a new key, and refused queries not rotated;
    - environment accounts;
    - the address guard (every private range, mapped and NAT64 forms, numeric spellings);
    - HTML to text;
    - fetching through redirects, a redirect into metadata refused, size cap, binary refused.
  - `packages/policy/test/policy.test.ts`: allow, ask for unknown sites, deny with secrets, deny for roles without
    the grant.
  - `tests/integration/web.test.ts`, a mission through the gate with a real Chromium:
    - failover from an account out of searches;
    - a found page read without asking;
    - an unknown site denied by the operator and never contacted;
    - a secret query never sent;
    - a form post and a link to an unknown site blocked;
    - with web access off, no tool is offered.
  - `tests/e2e-electron/web.spec.ts`, the Settings section against a fake provider:
    - three keys, tested;
    - out of searches, then reset;
    - a rejected key;
    - allowed sites;
    - keys absent from the page.
