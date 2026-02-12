# AutoNote Chrome Web Store Submission Pack

## 1) Upload package (prepared)
- ZIP: `releases/autonote-store-v0.1.1-permission-tightened.zip`
- SHA256: `0cf1cfefad9cd865706b8b544992c9560cd46daf50b7b56efabd057a22750ced`

## 2) Listing copy (ready to use)

### Name
AutoNote: AI Smart Bookmark Organizer

### Short description
One-key save, AI classify, semantic search, and cloud sync for your heavy bookmark workflow.

### Detailed description
AutoNote helps you capture and organize massive links with minimal friction.

Key features:
- One-key save current page into AutoNote inbox
- AI-assisted summary and classification (1 category + tags)
- Semantic search to recall links even when keywords are forgotten
- Board + compact home views for fast navigation
- Trash/restore/permanent delete lifecycle management
- Optional cloud sync (Google sign-in + magic link)

Designed for researchers, builders, and heavy information workers.

## 3) Store listing assets requirements (official)
- Store icon: 128x128
- Screenshots: at least 1, 1280x800, up to 5
- Small promo tile: 440x280
- Marquee promo tile: 1400x560 (optional)

## 4) Privacy practices (recommended answers for current code)

### Single purpose
"Capture and organize web bookmarks efficiently with AI-assisted categorization, search, and management."

### Permissions justification
- `storage`: save settings and auth/session metadata locally
- `scripting`: inject content script into active tab when user triggers save
- `activeTab`: capture current page content only on user action
- `commands`: keyboard shortcut for one-key save
- `notifications`: show fallback/error notifications when page injection is unavailable
- `alarms`: schedule background jobs for sync/cleanup/backfill
- `identity`: Google OAuth login via Chrome identity flow
- `permissions`: request optional site access at runtime per configured API origin
- `optional_host_permissions: https://*/*`: only used for runtime origin grants (for user-configured AI/Supabase domains)

Security behavior:
- No broad host access is granted by default.
- Extension asks permission only for specific domains configured by user (e.g. `https://api.openai.com/*`, `https://<project>.supabase.co/*`).

### Remote code declaration
- Select: No remote code execution.
- Reason: extension fetches remote APIs only; it does not download and execute remote scripts.

### Data usage declaration (suggested)
Collects and processes:
- Website content selected/captured by user action
- Bookmark metadata (url/title/domain/tags/category/notes)
- Account identifier for sync

Not sold to third parties.
Not used for ads, credit, or lending.
Used only for core bookmark and sync functionality.

### Privacy policy URL
Use your deployed policy page URL (must be public), for example:
- `https://auto-note.vercel.app/privacy.html`

## 5) Reviewer test instructions (paste into dashboard)
1. Install extension and open any HTTPS page.
2. Press `Cmd/Ctrl+Shift+S` to save page.
3. Open manager page from extension icon.
4. Verify bookmark appears in Inbox/Library.
5. Open details drawer, edit category/tags/note, then save.
6. Move item to Trash and restore it.
7. Optional auth test:
   - click Sign In -> Continue with Google
   - verify account status appears in top-right

## 6) Distribution recommendation for first release
- Visibility: Unlisted first (or Private trusted testers)
- After review passes and smoke test is done, switch to Public

## 7) Manual steps still required from publisher
1. Register developer account and pay one-time registration fee.
2. Enable 2-step verification on your Google account.
3. Complete developer account setup in dashboard (publisher name + verified contact email).
4. Upload ZIP and fill Listing + Privacy + Distribution tabs.
5. Submit for review.
