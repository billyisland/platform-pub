# Step 4 — New Pages and Dashboard Extensions

The navigation shell (steps 1–3) is complete. The top bar, avatar dropdown, layout registers, and v2 design tokens are all in place. This step builds the four independent feature surfaces that the shell was designed to hold.

Each workstream below can be built independently. They share no components with each other, and all existing routes continue to work. The only shared touchpoint is the avatar dropdown in `Nav.tsx` and the notification routing in `NotificationBell.tsx`, which need small additions once each page exists.

---

## Workstream A: Messages (`/messages`)

**What:** A two-panel DM inbox consuming the 6 existing message endpoints.

**Backend endpoints (all exist, zero frontend):**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/conversations` | Create conversation |
| POST | `/conversations/:id/members` | Add members |
| GET | `/messages` | Inbox listing (conversations with last message + unread count) |
| GET | `/messages/:conversationId` | Load messages in a conversation (paginated) |
| POST | `/messages/:conversationId` | Send a DM |
| POST | `/messages/:messageId/read` | Mark message as read |

**Files to create:**

| File | Purpose |
|------|---------|
| `web/src/app/messages/page.tsx` | Inbox page — conversation list, or list + active thread on desktop |
| `web/src/app/messages/[conversationId]/page.tsx` | Direct link into a specific conversation (for notification routing) |
| `web/src/components/messages/ConversationList.tsx` | Left panel: conversations sorted by recency, unread dot, last message preview |
| `web/src/components/messages/MessageThread.tsx` | Right panel: paginated messages, send box, auto mark-read on view |

**Layout:**
- Two-panel on desktop (conversation list 280px + thread), single-panel on mobile (list → tap → thread, with back button).
- Platform register (not canvas).
- Typography: Instrument Sans for all message text. Plex Mono for timestamps and metadata.

**Key behaviours:**
1. `GET /messages` returns conversations. Each has `lastMessage`, `unreadCount`, `members`. Render as a scrollable list.
2. Clicking a conversation loads `GET /messages/:conversationId` with paginated messages. Render newest at bottom, older messages load on scroll-up.
3. On opening a conversation, auto-call `POST /messages/:messageId/read` for all unread messages in the visible batch.
4. "New message" button opens a user search (reuse the existing writer search endpoint `GET /search?type=writers`), then `POST /conversations` to create, then navigate to the new conversation.
5. DM pricing: the send-message endpoint returns 402 if the recipient has DM pricing set. The UI should catch this and show the price with a confirm/cancel before retrying.

**API client additions** (`web/src/lib/api.ts`):
```typescript
export const messages = {
  listConversations: () => request<{ conversations: Conversation[] }>('/messages'),
  getMessages: (conversationId: string, cursor?: string) =>
    request<{ messages: Message[]; nextCursor: string | null }>(
      `/messages/${conversationId}${cursor ? `?cursor=${cursor}` : ''}`
    ),
  send: (conversationId: string, content: string) =>
    request<{ messageId: string }>(`/messages/${conversationId}`, {
      method: 'POST', body: JSON.stringify({ content }),
    }),
  markRead: (messageId: string) =>
    request<void>(`/messages/${messageId}/read`, { method: 'POST' }),
  createConversation: (memberIds: string[]) =>
    request<{ conversationId: string }>('/conversations', {
      method: 'POST', body: JSON.stringify({ memberIds }),
    }),
}
```

**Nav integration:**
- Add `Messages` link to the avatar dropdown in `Nav.tsx`, between Profile and Notifications.
- Fetch unread message count (new lightweight endpoint or piggyback on `/messages` response) and show badge count `(3)` next to the link.
- In the mobile sheet, promote Messages above the divider alongside Notifications.

**Notification routing fix** (`NotificationBell.tsx`):
```typescript
case 'new_message':
  // Requires adding conversationId to the Notification interface
  return n.conversationId ? `/messages/${n.conversationId}` : '/messages'
```
This requires a backend change: the notification payload for `new_message` needs to include `conversationId`. Check `gateway/src/routes/messages.ts` — the notification is created in the send-message handler. Add `conversation_id` to the notification metadata, and extend the `GET /notifications` response serialiser to include it.

The `Notification` interface in `web/src/lib/api.ts` needs a new optional field:
```typescript
conversationId?: string
```

---

## Workstream B: Account (`/account`)

**What:** A unified financial ledger replacing the scattered credits/accounts/tab views.

**Backend endpoints:**

| Method | Endpoint | Purpose | Exists? |
|--------|----------|---------|---------|
| GET | `/my/tab` | Tab balance, free allowance, recent reads | Yes |
| GET | `/earnings/:userId` | Writer earnings totals | Yes |
| GET | `/earnings/:userId/articles` | Per-article earnings breakdown | Yes |
| GET | `/subscriptions/mine` | Reader's active subscriptions | Yes |
| GET | `/subscribers` | Writer's subscribers | Yes |
| GET | `/my/pledges` | Drives I've backed | Yes |
| GET | `/receipts/export` | Portable receipt tokens (download) | Yes |
| GET | `/account/export` | Full writer migration bundle (download) | Yes |
| GET | `/platform-pubkey` | Platform Nostr service pubkey (for receipt verification) | Yes |

All endpoints exist. No backend work needed.

**Files to create:**

| File | Purpose |
|------|---------|
| `web/src/app/account/page.tsx` | Account page shell — balance header, tabbed ledger, sections |
| `web/src/components/account/BalanceHeader.tsx` | Net position display + free allowance meter |
| `web/src/components/account/AccountLedger.tsx` | Chronological transaction list with All/Income/Spending filters |
| `web/src/components/account/SubscriptionsSection.tsx` | Active subscriptions with cancel controls |
| `web/src/components/account/PledgesSection.tsx` | Drives I've backed |
| `web/src/components/account/PaymentSection.tsx` | Card on file + Stripe Connect status |

**Data assembly:**
There is no single "ledger" endpoint. The page must fan out to multiple endpoints and merge the results into a unified chronological stream:
- `GET /my/tab` → reading charges (debit entries)
- `GET /earnings/:userId/articles` → per-article income (credit entries)
- `GET /subscriptions/mine` → subscription outgoings (recurring debits)
- `GET /subscribers` → subscription income (recurring credits)
- `GET /my/pledges` → pledge commitments (debits or credits depending on role)

Each response has timestamps. Merge into one array, sort by date descending, render as the ledger. Tag each entry as income or spending for the filter tabs.

**Layout:**
- Platform register. Max-width `content` (960px), centred.
- Balance header: large net position in Literata, free allowance progress bar below.
- Ledger: Plex Mono dates and amounts, Instrument Sans descriptions. Crimson for income amounts, black for spending.
- Sections below the ledger: Subscriptions, Pledges, Payment & Payouts.
- Typography follows the same patterns as the feed: Plex Mono for tabular/financial data, Instrument Sans for labels and descriptions.

**Nav integration:**
- Add `Account` link to the avatar dropdown, replacing the current static balance display. Show the net balance inline: `Account          £4.20`.
- In the mobile sheet, add Account in the same group as Reading history.

**Dashboard integration:**
- Remove the `credits` and `accounts` tabs from the dashboard. The dashboard tabs become: `articles`, `drafts`, `drives`, `settings`.
- Add a prominent "View account →" link at the top of the dashboard page.
- The `DashboardTab` type in `dashboard/page.tsx` (line 13) must be updated. The `CreditsTab` and `AccountsTab` components can be deleted — their functionality moves to `/account`.

**Settings migration:**
- Move the payment method (CardSetup) and Stripe Connect sections from `/settings` to the Account page's Payment & Payouts section. `/settings` becomes a lighter page: display name, username, email, and display preferences only.

**Data export:**
- The "Export my data" action in the avatar dropdown triggers a confirmation modal, then calls `GET /receipts/export` and/or `GET /account/export` (writer only) and downloads the response as a file.
- Create `web/src/components/ExportModal.tsx` for this.

---

## Workstream C: Dashboard Drives Tab

**What:** A new tab in the existing dashboard for managing pledge drives and commissions, consuming 11 existing endpoints.

**Backend endpoints (all exist, zero frontend):**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/drives` | Create drive (crowdfund or commission) |
| GET | `/drives/:id` | View drive + progress |
| PUT | `/drives/:id` | Update drive |
| DELETE | `/drives/:id` | Cancel drive |
| POST | `/drives/:id/pledge` | Pledge money |
| DELETE | `/drives/:id/pledge` | Withdraw pledge |
| POST | `/drives/:id/accept` | Accept commission |
| POST | `/drives/:id/decline` | Decline commission |
| POST | `/drives/:id/pin` | Pin/unpin on profile |
| GET | `/drives/by-user/:userId` | User's drives |
| GET | `/my/pledges` | My active pledges |

**Files to create:**

| File | Purpose |
|------|---------|
| `web/src/components/dashboard/DrivesTab.tsx` | Main drives management surface |
| `web/src/components/dashboard/DriveCreateForm.tsx` | Creation form (crowdfund vs commission, target amount, description) |
| `web/src/components/dashboard/DriveCard.tsx` | Single drive card with progress bar and actions |

**Files to modify:**

| File | Change |
|------|--------|
| `web/src/app/dashboard/page.tsx` | Add `'drives'` to `DashboardTab` type. Add Drives tab button and render `<DrivesTab />`. Remove `credits` and `accounts` tabs (moved to `/account`). Accept `?tab=drives` query param for notification deep-linking. |
| `web/src/lib/api.ts` | Add `drives` API client with all 11 endpoints. |

**DrivesTab layout:**
1. "New drive" button at top right.
2. Three sections, collapsible:
   - **Active drives** — progress bar (pledged / target), pledge count, pin toggle, edit/cancel actions.
   - **Incoming commissions** — commission requests from other users with accept/decline buttons. Only shown if any exist.
   - **Completed / cancelled** — historical drives, read-only.
3. "New drive" form: radio choice (crowdfund / commission), target amount in £, description textarea, optional target writer (commission only, user search), submit button.

**Free passes (inline in Articles tab):**
Each article row in the existing Articles tab gets a "⋯" overflow menu. One of the options is "Manage free passes", which expands an inline panel below the row.

| File | Purpose |
|------|---------|
| `web/src/components/dashboard/FreePassManager.tsx` | Inline panel: list of existing grants (from `GET /articles/:articleId/free-passes`), "Grant access" form (username input → `POST /articles/:articleId/free-pass`), revoke button per grant (`DELETE /articles/:articleId/free-pass/:userId`). |

Modify `ArticlesTab` in `dashboard/page.tsx` to add the overflow menu and render `FreePassManager` when expanded.

**Dashboard Settings tab additions:**
- Add subscription price field: current price display + edit form calling `PATCH /settings/subscription-price`.
- Add Stripe Connect status display with re-onboarding link (data already available on the `MeResponse`).
- DM pricing: placeholder "coming soon" or omit until the endpoint exists.

**Notification routing fixes** (`NotificationBell.tsx`):
```typescript
case 'commission_request':
case 'drive_funded':
case 'pledge_fulfilled':
  return '/dashboard?tab=drives'
case 'free_pass_granted':
  return n.article?.slug ? `/article/${n.article.slug}` : '#'
```

---

## Workstream D: Admin (`/admin`)

**What:** A moderation dashboard consuming the 3 existing admin endpoints. Separate route tree, separate layout, only accessible to admin users.

**Backend endpoints (all exist, zero frontend):**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/admin/reports` | List all content reports |
| PATCH | `/admin/reports/:reportId` | Resolve report (remove content, suspend account, dismiss) |
| POST | `/admin/suspend/:accountId` | Suspend account directly |

**Files to create:**

| File | Purpose |
|------|---------|
| `web/src/app/admin/page.tsx` | Admin dashboard — redirects to `/admin/reports` |
| `web/src/app/admin/reports/page.tsx` | Report queue with filters (pending, resolved, all) |
| `web/src/components/admin/ReportCard.tsx` | Single report: content preview, reporter info, action buttons (remove content, suspend, dismiss) |

**Access control:**
- The gateway's admin endpoints check `ADMIN_ACCOUNT_IDS`. The frontend must also gate access.
- `MeResponse` doesn't currently include an `isAdmin` field. Either add one (preferred — add `isAdmin: boolean` to the `/auth/me` response, derived from `ADMIN_ACCOUNT_IDS`), or hardcode the check client-side against a list of IDs in an env var.
- If the user is not admin, `/admin` should show a 404 or redirect to `/feed`.

**Nav integration:**
- Admin users see a small "Admin" link at the bottom of the avatar dropdown, in the meta section before "Log out".
- Check `user.isAdmin` (once the field exists) to conditionally render it.

**Report queue layout:**
- Filter bar: ALL / PENDING / RESOLVED (Plex Mono tab pills).
- Each report card shows: reported content preview (truncated), reporter username, report reason, timestamp, and action buttons.
- Actions: "Remove content" (PATCH with `action: 'remove'`), "Suspend user" (POST `/admin/suspend/:accountId`), "Dismiss" (PATCH with `action: 'dismiss'`).
- After taking action, the card updates inline (grey out + show resolution status).

---

## Shared prerequisites

Before starting any workstream, these small changes set the foundation:

### 1. Extend the Notification type

Add optional fields to `Notification` in `web/src/lib/api.ts`:

```typescript
export interface Notification {
  // ... existing fields ...
  conversationId?: string   // for new_message routing
  driveId?: string          // for drive_funded, commission_request routing
}
```

The backend notification serialiser (`gateway/src/routes/notifications.ts`) needs to join these IDs from the notification metadata.

### 2. Fix notification routing

Update `getDestUrl` in `NotificationBell.tsx`:

```typescript
function getDestUrl(n: Notification): string {
  switch (n.type) {
    case 'new_follower':
    case 'new_subscriber':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_reply':
      if (n.article?.slug) {
        return n.comment?.id
          ? `/article/${n.article.slug}#reply-${n.comment.id}`
          : `/article/${n.article.slug}`
      }
      return '#'
    case 'new_quote':
    case 'new_mention':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return '/dashboard?tab=drives'
    case 'new_message':
      return n.conversationId ? `/messages/${n.conversationId}` : '/messages'
    case 'free_pass_granted':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    default:
      return '#'
  }
}
```

### 3. Add `isAdmin` to MeResponse

In `gateway/src/routes/auth.ts`, the `/auth/me` handler should add:
```typescript
isAdmin: (process.env.ADMIN_ACCOUNT_IDS ?? '').split(',').includes(account.id)
```

And in `web/src/lib/api.ts`:
```typescript
export interface MeResponse {
  // ... existing fields ...
  isAdmin: boolean
}
```

### 4. Update avatar dropdown

Once each page exists, add links to `Nav.tsx` → `AvatarDropdown`:
- Messages (with unread badge) — group 1, after Notifications
- Account (with balance) — group 2, replacing the current static balance line
- Export my data — group 3, before Log out
- Admin (conditional on `user.isAdmin`) — group 3, before Log out

---

## Suggested build order

The workstreams are independent, but if doing them serially:

1. **Workstream C (Dashboard Drives)** — smallest scope, modifies an existing page, immediately fixes 3 broken notification routes. Good warmup.
2. **Workstream B (Account)** — medium scope, cleans up the dashboard by removing the credits/accounts tabs, and gives the avatar dropdown its most important link.
3. **Workstream A (Messages)** — largest scope, only new-page workstream with two routes and a two-panel layout. Benefits from having the notification routing fix (prerequisite 2) already in place.
4. **Workstream D (Admin)** — isolated, low urgency, requires the `isAdmin` backend change. Can be done last.

After all four are complete, the 29 orphan endpoints from FRONTEND-GAPS.md will be fully covered, and every notification type will route to a real destination.
