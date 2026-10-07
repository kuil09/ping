# Nickname first; profile editing on demand

This replaces the former permanently visible, optional nickname field.

1. A browser participant without a confirmed channel nickname sees the compact nickname form. Availability is initially unavailable; its control is hidden and disabled. The send button is disabled until the profile is confirmed. Incoming SSE, ping clocks, tab attention and local history continue to work during entry/editing.
2. Apply a nonblank nickname (existing NFC normalization and 20-code-point limit). A server-confirmed result collapses the input to a small own-profile button and reveals the availability switch, still unavailable. Saving a name never implies availability.
3. Clicking the own-profile summary or the participant's own ring opens the same editor. Other participants are not editable. Apply closes the editor after confirmation; Cancel or Escape discards the draft and returns focus to the own-profile button. Editing preserves the existing availability value and temporarily disables send/toggle to avoid accidental actions.

No modal, separate page, account or extra storage is introduced. A retained server profile on reload/sibling tabs starts collapsed. Existing deployment resets also reset the confirmed nickname; no previous nickname is silently uploaded from local history. Local history is not reset.

Pending/failed saves retain the draft and do not fake a saved profile. Whitespace-only names cannot dismiss the entry step or erase an existing name. IME composition is not treated as an Enter submit or Escape cancel. Incoming pings/heartbeats do not overwrite dirty drafts. A newer conflicting confirmed name is not overwritten by a stale response. This is a UI sequence, not an authentication boundary; anonymous live readers and legacy API payloads remain compatible.

Verification: existing state, nickname, history and tab unit tests remain. Chromium/WebKit browser tests use the real nickname HTTP endpoint and SSE, and now cover first entry, pending/failure states, compact profile, both edit entry points, keyboard cancel, peer ping during editing, nickname/availability preservation, reload, sibling-tab synchronization, history persistence and mobile light/dark screenshots. Production smoke continues to verify exact committed assets before fresh-channel tests.

Accessibility reference: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
