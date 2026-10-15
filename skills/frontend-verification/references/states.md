# States every UI change should survive

- **Empty:** no items, first use, a cleared search.
- **Loading:** slow responses. Does the UI show progress and block double submits?
- **Error:** the server returns 4xx or 5xx, or the network fails. Is there a readable message, and can the user
  retry?
- **Validation:** required fields left empty, wrong formats, boundary lengths. Is each message next to its field?
- **Volume:** one item, many items (pagination or scrolling), very long words and names, emoji and right-to-left text.
- **Navigation:** back and forward in the middle of a flow, reload after submit, deep links to inner pages.
- **Permissions:** what a signed-out or less privileged user sees, if the app has users.
- **Responsive:** 390×844 (phone), 768×1024 (tablet), 1440×900 (desktop).
- **Accessibility:** every control has a name, headings are in order, focus is visible and follows the visual order,
  dialogs trap and restore focus, Escape closes them.
