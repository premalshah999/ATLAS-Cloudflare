# ADR 0028 — Graphite: a calmer, roomier interface

Status: accepted · 2026-10-14

## Context
The operator found the interface cluttered and its colors too bright, while keeping the dark theme and every feature.
- **Color:**
  - a saturated periwinkle accent on primary buttons, toggles, selected chips and links;
  - a bright green banner and green sentences for every passing check;
  - yellow outlines for sample markers.
- **Type:** 13 px body text, and 10.5 px uppercase, letter-spaced labels on every section.
- **Space:** tight padding throughout.
- **Structure:** the mission view stacked a header, an outcome band, a pipeline box, tabs and filters with little
  separation.

## Alternatives
- **A light theme or a new color identity:** rejected. The operator likes the dark theme.
- **Removing panels to reduce density:** rejected. The operator asked for no feature reduction.
- **Chosen:** keep every screen and control, and change the system underneath. Tokens, component styles and two
  small structural changes in the mission header.

## Decision
- **Palette (tokens.css):** near-neutral graphite surfaces.
  - Color is reserved for meaning, and every meaning is muted:
    - sage for success (`#8ab59d`);
    - ochre for warning (`#c9a86a`);
    - clay for danger (`#d08a7f`);
    - slate for focus and selection (`#8fa3bf`).
  - Primary actions are light neutral buttons with dark text (`--primary`), not colored ones. Toggles and checkboxes
    use the same neutral.
  - All hard-coded copies of the old colors were mapped to the new ones.
- **Type:** body 13.5 px with 21 px lines. Labels in sentence case at 12 px. Section titles 14 px semibold. Mono
  11.5 px.
- **Space and shape:**
  - controls 32 px (small 26 px);
  - radii 6, 10 and 14 px;
  - badges, chips and filters are pills;
  - more padding in panels, cards, tables (42 px rows), the timeline and settings;
  - hairlines are softer.
- **Mission view:**
  - The outcome and the pipeline share one calm status band: an icon in the result's color, text in ink.
  - Timeline entries keep readable ink text, with meaning shown as a small dot; failures stay red.
  - The mission ID moved to the meta line.
  - The sample-runtime tag is a neutral outline.
- **Active states:** selected tabs underline in ink; selected chips and segments are raised neutral surfaces.

## Consequences
- Every screen changes. No control, panel, test id or behaviour was removed; all 19 Electron e2e tests pass.
- README screenshots were recaptured from the built app.
