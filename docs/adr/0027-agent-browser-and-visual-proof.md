# ADR 0027 — An agent browser that reads the page, and visual proof of every UI change

Status: accepted · 2026-10-14

## Context
Two gaps kept ATLAS's browser work behind its evidence-first standard.

1. **Agents drove the browser blind.**
   - `browser_action` took CSS selectors or visible text, so an agent had to guess the DOM.
   - It saw console errors only as a count, and network requests not at all.
   - It could not hover, select, check, reload, go back or change the viewport.
2. **A UI change came with no picture of the change.**
   - Browser flows prove that steps pass. They do not show what the page looks like now, or what moved.
   - A reviewer approving a change to a web app had to run it themselves to see it.

## Alternatives
- **For reading the page:**
  - Playwright's ARIA snapshot (`locator.ariaSnapshot()`) gives YAML without stable handles. Its ref mode is an
    internal API, which ATLAS does not rely on.
  - Screenshots plus coordinates repeat the desktop-control approach, which suits apps without a DOM.
  - **Chosen:** a small DOM walker that lists interactive elements, headings, landmarks and text, in document order,
    each with a ref. Refs are kept in a page-side map, never written into the DOM.
- **For visual comparison:**
  - Image-diff libraries (pixelmatch, pngjs, sharp) are new dependencies, needing a license and supply-chain review.
  - Hosted visual-testing services send screenshots off the machine; ATLAS is local-first.
  - **Chosen:** compare pixels in Chromium's canvas, which ATLAS already drives. No new dependency, and nothing
    leaves the machine.

## Decision
- **Agent browser** (`browser_action`):
  - `snapshot {selector?}`: the page as lines such as `- button "Place order" [ref=e9]` or
    `- textbox "Customer" value="" [ref=e5]`. Each line carries its state: values, checked, the selected option and
    choices, disabled, required, and link targets. Landmarks indent their contents, and hidden or `aria-hidden`
    content is left out. At most 400 lines; a selector narrows the snapshot to part of the page.
  - `click`, `fill`, `hover`, `select`, `check` take a `ref` (or a selector). After a navigation or a change, an old
    ref is refused, and the agent is told to take a new snapshot. It is never resolved to a guess.
  - `reload`, `back`, `viewport {width,height}`.
  - `console` and `network` return what the page logged and requested since the last read (newest 500 of each kept).
    Each network entry has method, path, status or failure, timing and resource type.
  - Page text comes back inside `<page-…>` tags as data from the app, never instructions.
  - The `browser_qa` role (v3) works snapshot first.
- **Visual proof** (release stage `visual`, after the application checks):
  - Runs for every mission whose project has an `app` section, when a Chromium is available, and the result differs
    from the base. Settings key `visual.enabled` or the project's `visual.enabled` turns it off.
  - **Pages:** `visual.pages` in `atlas.config.json`, else `/` and every page the browser flows open (at most 5).
  - **Before and after:**
    - The base commit's tree is written as plain files (git `read-tree` and `checkout-index` into a temporary index)
      under `.atlas-visual/base` inside the integration worktree, so the same sandbox root covers it.
    - Installed dependencies are linked, not reinstalled.
    - The "before" app runs from that tree and the "after" app from the result, one after the other, both in the
      sandbox.
    - Each page is captured full-page (up to 6,000 px), with animations stopped and the caret hidden, at
      `visual.viewport` (default 1280×800).
  - **Diff:** both PNGs are compared in a blank Chromium page. A pixel counts as changed when its channel differences
    sum to more than 10. Both sides render in the same browser, so unchanged pixels are identical. A first version
    used 48 and missed a pale card background (a difference of 30).
    - The diff image shows changed pixels in red over a faded copy of the result.
    - A page is changed when more than `thresholdPercent` (default 0.1%) of its pixels differ.
  - **Evidence:** before, after and diff (screenshot artifacts), a `visual.page` event per page, a JSON report, and an
    optional check `visual`. It passes unless a page that rendered before no longer renders, which fails the
    (optional) check.
    - A visual change is not a defect, since it may be the point of the mission, so the check never blocks.
- **UI:** a **Visual** tab per mission, with the changed-page count, and per page:
  - the share of pixels changed;
  - Compare (a slider over before and after), Diff, Before and After.

## Consequences
- Content that changes by itself (clocks, random data, live feeds) shows as changed; list such pages in
  `visual.pages` only if they are stable.
- Pixel comparison measures what changed, not whether the change is right. Judging that stays with the review and
  the operator.
- The stage starts the app twice. On the sample app, it adds about 3 s on Linux.
- A project whose app needs a build step not covered by `app.start` may not render "before" from a plain tree. It is
  reported as `new` (no baseline), never as unchanged.
- **Tests:**
  - `tests/integration/agent-browser.test.ts`: a real Chromium on a small app.
    - the snapshot's lines, states and indentation;
    - hidden content left out, and the DOM unchanged by a snapshot;
    - fill, select, check, hover and click by ref;
    - console and network reads;
    - a stale ref refused after a reload;
    - back, viewport, and argument validation.
  - `tests/integration/visual.test.ts`: real missions on the sample app in the sandbox.
    - a page change measured, with before, after and diff, and the base tree removed afterwards;
    - an unchanged change showing no visual change and storing no diff;
    - a page that stops rendering flagged.
  - `tests/e2e-electron/visual.spec.ts`: the Visual tab in the built app, with summary, diff and slider.
  - README screenshots 36 and 37 are captured from it.
