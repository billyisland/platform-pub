# Fix: Export My Data

## Status

The backend is complete and the frontend modal exists. Five issues prevent it from working properly.

## Files involved

| Layer | File | Role |
|-------|------|------|
| Frontend | `web/src/components/ExportModal.tsx` | Modal with two download buttons |
| Frontend | `web/src/components/layout/Nav.tsx` | `AvatarDropdown` triggers the modal; `MobileSheet` is missing it |
| Frontend | `web/src/app/settings/page.tsx` | Settings page — no export link yet |
| Gateway | `gateway/src/routes/export.ts` | `GET /account/export` — writer migration bundle |
| Gateway | `gateway/src/routes/receipts.ts` | `GET /receipts/export` — portable receipt tokens |
| Key service | `key-service/src/routes/keys.ts` | `GET /writers/export-keys` — vault key re-wrapping |

## Issues to fix

### 1. Modal locks after first download

`ExportModal.tsx` has a single `done` boolean. Once a writer clicks "Portable receipts", the modal flips to the done state and hides the "Full account export" button. The writer has to close and reopen the modal to access the second export.

**Fix:** Remove the `done` state entirely. Instead, after each successful download, show a brief inline confirmation next to that button (e.g. a tick and "Downloaded") while keeping both buttons visible. Or use a `Map<string, boolean>` keyed by export type.

### 2. Mobile nav has no export link

`MobileSheet` in `Nav.tsx` (around line 214) lists Settings but not "Export my data". The desktop `AvatarDropdown` has it, the mobile sheet doesn't.

**Fix:** Add an "Export my data" button to `MobileSheet`, between Settings and Log out (matching the desktop dropdown order). The mobile sheet doesn't currently have access to `showExport` state — either lift it into the parent `Nav` component or add local state to `MobileSheet` and render the `ExportModal` from there.

### 3. Settings page has no export entry point

`web/src/app/settings/page.tsx` has an Account section at the bottom showing display name, username, and public key, but no mention of data export. The export is only reachable via the nav dropdown — easy to miss.

**Fix:** Add an "Export my data" section at the bottom of the settings page, below the Account info block. It can either open the `ExportModal` inline or link to it. Keep it simple — a single button that opens the modal, with a one-line explanation like "Download your data, receipts, and content keys."

### 4. No writer guard on the account export endpoint

`gateway/src/routes/export.ts` line 67 uses `requireAuth` but doesn't check whether the user is actually a writer. A reader hitting `GET /account/export` gets an empty-but-200 response (no articles, no keys) rather than a clear rejection.

**Fix:** After fetching the account row, check whether the user has any writer status (e.g. `is_writer` flag or presence of Stripe Connect). If not a writer, return `403 { error: 'Writer account required' }`. The frontend already hides the button for non-writers (`user.isWriter` check in `ExportModal.tsx` line 58), so this is a backend safety net.

### 5. Poor error feedback in the modal

`ExportModal.tsx` line 26 catches all errors and shows `alert('Export failed.')`. The account export can fail with a 502 if the key-service is down, but the receipt export might still work. There's no way for the user to tell what went wrong.

**Fix:** Replace the generic alert with an inline error message below the relevant button. If the error response has a JSON body, parse it and show the server's error message. The 502 "Failed to retrieve content keys" from the gateway is clear enough to surface directly.

## Not broken (no changes needed)

These parts are all working correctly:

- Receipt token generation: `payment-service/src/services/accrual.ts` calls `createPortableReceipt()` and stores the signed Nostr event in `read_events.receipt_token` during accrual. Data is populating.
- Receipt export endpoint: `GET /receipts/export` reads `receipt_token` from `read_events`, parses the JSON, returns the array with the platform pubkey. Complete.
- Writer migration bundle: `GET /account/export` pulls articles, receipt whitelists (reader pubkeys per article from `read_events`), and calls the key-service for vault key re-wrapping. The key-service decrypts each vault key with the KMS key and re-wraps it via NIP-44 to the writer's own pubkey. Complete.
- Route registration: Both `receiptRoutes` and `exportRoutes` are registered in `gateway/src/index.ts` with prefix `/api/v1`. The frontend calls `/api/v1/receipts/export` and `/api/v1/account/export`. Paths match.
- Download trigger: The blob-download approach in `ExportModal.tsx` (create object URL, click hidden anchor, revoke) is standard and works.

## Suggested order

Do issues 1 and 2 together (both in the frontend, both quick). Then 3 (settings page). Then 4 (one-line backend guard). Then 5 (error handling polish).
