# CHESSCHAT UI Design Guide (MVP)

Purpose: define a clear, minimal, decision-complete UI direction for CHESSCHAT game screens, lobby, and auth flow so design changes remain consistent and interview-ready.

Last updated: 2026-03-09

## 1) Design Principles
- Keep the UI simple, minimal, and clear.
- Chessboard is the primary surface; video is secondary but always visible.
- Prioritize state legibility over visual effects.
- Keep controls consistent across desktop and mobile.
- Avoid unnecessary UI complexity; every component should have gameplay or communication value.

## 2) Visual Direction (Based on Current Mockups)
- Theme:
  - Indigo/blue gradient environment with high-contrast content surfaces.
  - Soft glass-like cards and rounded corners.
- Style goals:
  - Premium but lightweight.
  - Calm and focused during gameplay.
  - Strong visual hierarchy with limited color vocabulary.

### 2.1 Color System (MVP)
- Use a constrained token set:
  - `--color-bg-start`: deep indigo
  - `--color-bg-end`: blue-indigo highlight
  - `--color-surface`: translucent panel background
  - `--color-text-primary`: near-white for dark areas
  - `--color-text-secondary`: muted light text
  - `--color-accent`: active button/highlight accent
  - `--color-danger`: resign/error/destructive action
  - `--color-success`: stable/connected confirmations
- Rules:
  - Accent only for primary actions and active gameplay indicators.
  - Danger only for destructive actions and critical failures.
  - Do not add extra semantic colors in MVP unless tied to a new state.

### 2.2 Typography (MVP)
- Single type family across app.
- Three-level scale:
  - `Display/Title`: room title, key headers
  - `Body`: default labels and content
  - `Meta`: clocks, reconnect subtitles, helper text
- Keep turn/clocks/status more prominent than secondary metadata.

## 3) Layout Baseline

### 3.1 Desktop Game Layout
- Structure: `left video tile | center board | right video tile`.
- Keep board as dominant focal area.
- Place `Return to Lobby` top-left.
- Turn indicator above board.
- Player clocks anchored near board edges.
- Mic/camera controls stay close to each player tile.

### 3.2 Mobile Game Layout
- Vertical stack:
  1. Top bar (`Return to Lobby`)
  2. Turn/status line
  3. Board (largest section)
  4. Clock row
  5. Video tiles
  6. Media controls
- Keep board full width and stable (no layout jumping between states).

### 3.3 Component Priority
- Primary: board + turn + clocks.
- Secondary: video tiles + mic/camera states.
- Tertiary: reconnect/system messaging.

## 4) Motion and Background Effects

### 4.1 Lava-Lamp Gradient Background (Approved Direction)
- A slow-moving blurry indigo/blue gradient background is allowed and preferred.
- Implementation guidance:
  - Use 2-4 blurred gradient blobs in a fixed background layer.
  - Animate only `transform` and optional `opacity`.
  - Long, subtle loops (`20s-40s`) with low amplitude movement.
  - Keep content on semi-opaque surfaces for readability.

### 4.2 Performance and Accessibility Constraints
- Respect `prefers-reduced-motion` and disable/reduce background animation.
- Use fewer/lighter blobs on mobile to reduce battery/GPU load.
- Do not animate gameplay-critical components unnecessarily.
- Avoid visual noise while user is making moves.

## 5) MVP Screen Inventory

### 5.1 Auth
- Register page (basic form).
- Login page (basic form).
- Keep forms minimal and clear.

### 5.2 Lobby
- Very basic control screen:
  - Start New Room
  - Join Room (room code)
  - Optional Resume Last Room
  - Logout
- No heavy dashboards for MVP; prioritize fast entry to game room.

### 5.3 Game Room
- Board + clocks + turn + video + media controls.
- Reconnect and game-result states handled clearly.
- Phone-call room lifecycle copy must be explicit:
  - If a game ends or reconnect grace expires, users create a new room code.

## 6) MVP Button and Control Requirements

### 6.1 Game Room Buttons
- `Return to Lobby`
- `Join Media`
- `Mute / Unmute Mic`
- `Camera On / Off`
- `Start Game`
- `Resign` (must confirm)
- `New Room` / `Create New Room`
- `Dismiss/Close` modal actions

### 6.2 Lobby Buttons
- `Start New Room`
- `Join Room`
- `Resume Last Room` (optional)
- `Logout`

### 6.3 Auth Buttons
- `Register` / `Create Account`
- `Log In`
- `Submit/Continue`
- Optional `Forgot Password`

## 7) State Visibility Requirements
- User must always be able to answer:
  - Whose turn is it?
  - What are both clocks?
  - Is media connected?
  - Is mic/camera currently on/off?
  - Is opponent connected/disconnected?
  - What action is available now?
- Reconnect states:
  - Paused
  - Restored
  - Timeout/forfeit outcome
- Error hierarchy:
  - Blocking errors: banners/modals
  - Transient errors: toast/status line

## 8) Interaction and Safety Rules
- Destructive actions (`Resign`, `Leave`) require confirmation.
- Keep actionable buttons disabled when invalid for current state.
- Keep button labels explicit (avoid icon-only critical actions in MVP).
- Maintain stable button position to build user muscle memory.

## 9) Accessibility and Usability Baseline
- Minimum touch target ~44px.
- Strong color contrast on gradient background.
- Do not rely on color alone for mic/cam or reconnect state (include text/icon).
- Keep keyboard focus visible for desktop.

## 10) Human Playtest Focus
- Validate:
  - Time to join room and start game
  - Mic/camera control clarity
  - Reconnect state understanding
  - Rematch flow clarity
- Capture for each session:
  - Confusing moments
  - Misclicks/wrong-button presses
  - Missing state information
  - Suggested copy/label changes

## 11) Design Decision Log Process (Required)
- For each substantial design/UI decision:
  1. Update this file (`DOCS/UI_DESIGN_GUIDE.md`) with the decision and rationale.
  2. Update `DOCS/PORTFOLIO_BUILD_PLAYBOOK.md` with strategy-level impact.
  3. Add a dated portfolio diary entry in `portfolio diary/YYYY-MM-DD.md`.
- Decision template:
  - `Decision`
  - `Alternatives considered`
  - `Why chosen`
  - `Tradeoffs / risks`
  - `Validation plan (manual + automated)`

## 12) UI Implementation Log (2026-03-07)

### Decision
- Implemented a desktop-first visual overhaul across room/lobby/landing with a tokenized design system and a room-first gameplay layout that mirrors the approved mockup composition.

### What changed
- Layout:
  - Room page restructured to `Return to Lobby` command bar, status strip, and desktop 3-column gameplay stage (`left player tile | board center | right player tile`).
  - Mobile/tablet fallback uses vertical stacking while preserving action reachability.
- Controls:
  - Media controls now live with the local player tile through `MediaControlRow`.
  - Game actions (`Start Game`, `Resign`, `Request/Accept/Decline Rematch`) grouped in a stable action row below board clocks.
- Visual system:
  - Added global CSS tokens for color, spacing, radii, shadows, typography, and motion.
  - Added slow animated indigo gradient blobs with `prefers-reduced-motion` support.
  - Added reusable surface/button/status primitives (`surface-glass`, `button-*`, status dots).
- Component behavior:
  - `VideoPanel` rebuilt into composable pieces (`PlayerVideoCard`, `MediaControlRow`) while preserving existing room/media logic in `RoomPage`.
  - `ChessBoardPanel` behavior preserved (orientation, draggability, legal move highlighting).

### Why chosen
- Prioritizes the board as the gameplay focal point while keeping media visibly present.
- Keeps the first high-polish pass focused on desktop where current validation priority is highest.
- Improves consistency and maintainability by moving from one-off styles to reusable design tokens and primitives.

### Tradeoffs / risks
- Remote mic/camera state is not yet represented as independent real-time indicators; the current pass focuses on local media control clarity and overall layout hierarchy.
- Bundle size warning remains from existing dependency footprint (`amazon-chime-sdk-js` path), unchanged by this UI pass.

### Validation method
- Automated:
  - `npm --prefix app/frontend run test` passed.
  - `npm --prefix app/frontend run build` passed.
- Manual playtest target for next loop:
  - Desktop hierarchy clarity (turn + clocks + board), media-control discoverability, reconnect/rematch state comprehension, and mobile smoke usability.

## 13) Hotfix Update (2026-03-08)

### What changed
- Stabilized interactive visual behavior to prevent Safari color/contrast flashing during hover interactions.
- Reduced room-board presentation scale for better fit on 15-inch laptop screens.
- Updated room media behavior to auto-attempt media join when valid `video_ready` credentials arrive.

### Why
- Manual testing found occasional visual inversion/flicker on hover and oversized board composition on common laptop displays.
- Reducing friction for media setup improves first-time room experience when two participants are present.

### Validation
- `npm --prefix app/frontend run test` (pass)
- `npm --prefix app/frontend run build` (pass)

### Notes
- Solo room media preview is still gated by backend meeting creation flow (`video_ready` is emitted only when both participants are connected).

## 14) Troubleshooting UI Update (2026-03-09)

### What changed
- Added a temporary room-status diagnostic line in the game header metadata showing:
  - connected player count
  - whether game state is active
  - local assigned color
  - whether it is currently local player's turn

### Why
- Current troubleshooting required faster cross-device verification of move gating and event ordering (`game_started` before first legal move expectation).
- This reduces ambiguity when validating two-user room state transitions during Safari/mobile repro.

### Validation
- `npm --prefix app/frontend run test` (pass)
- `npm --prefix app/frontend run build` (pass)

### Notes
- This is a temporary diagnostics aid and should be removed or hidden behind a debug flag after incident validation is complete.

## 15) Identity + Feedback UX Update (2026-03-09)

### What changed

## 16) Friends-First + Game Controls Update (2026-03-28)

### What changed
- Room/game contract hardened to 8-character room codes across frontend/backend/static-auth.
- App-wide authenticated websocket session introduced (single persistent connection while authenticated).
- Start-game flow now opens a host-controlled settings modal from inside the game room:
  - per-player time controls
  - allow/deny takebacks
  - takebacks per player
- Draw + takeback controls added to real game room:
  - `Offer Draw`, `Accept Draw`, `Takeback`.
- History page now supports replay navigation:
  - `View Board + Moves`, `Back`, `Forward`.
- Friends hub now uses live API-backed data for:
  - friend list
  - pending friend requests
  - invite by username

### Why
- Align real app behavior with the validated preview UX direction.
- Keep social/challenge flow consistent with "play your friends" as the primary product path.

### Notes
- Notification delivery is currently in-app/online-only.
- Realtime remains single-task constrained pending distributed WS routing.
- Lobby now enforces app-level username setup before room join when account username is missing or opaque.
- Username entry is constrained to a clean gamer-tag format (`a-z`, `0-9`, `_`, 3-20 chars) and validated with backend uniqueness checks.
- Room participant tiles and game-result winner text now prefer participant display names/usernames instead of raw Cognito subject IDs.
- Added move sound cue on each `move_made` event for better turn feedback.

### Why
- Raw Cognito subject identifiers in UI are poor UX and reduce social clarity in head-to-head play.
- Unique app usernames create stable, shareable identities independent of Cognito internals.
- Move sound improves board interaction feedback, especially while attention is split between board and video.

### Validation
- `npm --prefix app/frontend run test` (pass)
- `npm --prefix app/frontend run build` (pass)

### Notes
- Username enforcement currently blocks room join until setup is completed.
- Existing accounts with opaque legacy usernames are prompted to set a new app username.

## 16) Apex + Room Layout Simplification Update (2026-03-09)

### What changed
- Landing page copy simplified to logo/wordmark and two explicit actions only: `Sign Up` and `Sign In`.
- Added separate signup initiation path (`screen_hint=signup`) while keeping current Hosted UI flow.
- Removed temporary room diagnostics status line from game header.
- Removed in-room move history panel from the main game screen to reduce visual clutter.
- Rebalanced room layout:
  - Desktop: smaller board footprint and tighter panel padding.
  - Desktop/tablet/mobile: larger/more legible video tiles relative to board container space.
- Implemented compact mobile composition so board + both player tiles stay visible in the same screen flow.
- Added tiny-viewport fallback message: desktop recommended / mobile app coming soon.

### Why
- Prioritized clarity and speed-to-action in auth entry.
- Reduced non-essential information density in the room to preserve board/video focus.
- Addressed usability issue where mobile users could not keep board and both video surfaces visible.

### Tradeoffs / risks
- Compact mobile constraints require aggressive text-density reduction (some secondary metadata is hidden on smaller screens).
- Very small devices are intentionally gated to a fallback message to avoid a broken gameplay surface.

### Validation
- `npm --prefix app/frontend run test` (pass, 15/15)
- `npm --prefix app/frontend run build` (pass)

## 17) Username Flow Copy Clarification (2026-03-09)

### What changed
- Added a landing-page helper line: users choose their in-game username after authentication in Lobby.

### Why
- Cognito Hosted UI sign-up does not collect the app-level username.
- Explicit copy reduces false expectations and supports the existing post-auth username setup flow.

### Validation
- `npm --prefix app/frontend run test`
- `npm --prefix app/frontend run build`

## 18) Split-Host Program Stage 1 Update (2026-03-09)

### What changed
- Stage 1 completed infrastructure-only host split:
  - `https://chess-chat.com` now serves from CloudFront static edge.
  - `https://app.chess-chat.com` remains ALB/ECS gameplay host.
- No gameplay UI component/layout changes were introduced in this stage.

### Why
- Stage 1 is a prerequisite for Stage 2 static-auth UI delivery.
- Keeping Stage 1 infra-only avoids coupling visual/auth UI work to unresolved edge provisioning risks.

### Validation
- Terraform apply completed with apex->CloudFront and app->ALB split verified.
- GitHub Actions variables for static deploy path were provisioned.

### Stage dependencies
- Stage order is strict: `1 -> 2 -> 3 -> 4`; Stage 5 can run in parallel with Stage 4 after Stage 3 merge.

## 19) Stage 5 Username Policy Closure (2026-03-10)

### What changed
- Closed Stage 5 policy alignment for username onboarding:
  - Canonical username regex is `^[a-z0-9._-]{3,24}$`.
  - Existing auth/lobby copy remains aligned to this policy and keeps username setup as a post-auth lobby action.

### Why
- Stage 5 required a final consistency pass to ensure user-facing onboarding language matches backend/frontend validation behavior.
- Keeping one explicit regex policy avoids drift across static-auth, app lobby, and API validation.

### Validation
- Source-of-truth policy confirmed in:
  - backend username validation flow
  - frontend lobby username form validation
  - static-auth signup username validation
- No UI layout/component behavior changes in this stage.

## 20) Template-Driven UI Rebuild + Stub Routes (2026-03-22)

### Decision
- Rebuilt frontend visuals using `screen_templates` HTML + PNG screens as the north-star reference, while preserving existing backend/API/WS behavior.
- Added UI-only stub routes for future features:
  - `/friends`
  - `/history`

### What changed
- Introduced a shared Obsidian-Slate-inspired design layer in frontend CSS:
  - typography, color tokens, glass surfaces, status chips, button variants, app shell patterns.
- Added shared authenticated app shell (`AppChrome`) with top bar + side nav for app routes.
- Reworked existing app routes to align with template styling while retaining current logic:
  - `/` landing/auth entry
  - `/lobby` room challenge + username setup
  - `/profile` profile stats + delete-account workflow
  - `/room/:code` kept functional behavior, updated visual system via shared styles.
- Added UI-to-feature backlog map tags in-app (`UI_READY`, `API_MISSING`) to mark elements awaiting implementation.

### Split-host alignment
- Confirmed host boundaries for UI delivery:
  - `chess-chat.com` static edge landing only.
  - `app.chess-chat.com` containerized app routes and authenticated product surfaces.
- Auth callback/logout remain app-host aligned to avoid cross-origin session ambiguity.

### Validation
- `npm --prefix app/frontend run build` passed.
- `npm --prefix app/frontend run test` reported all suites passing; process did not terminate cleanly in this environment after result output.

### Notes
- Friends/history controls are intentionally non-functional in this pass and are tagged as API-dependent in UI.

## 21) No-Auth UI Preview Mode (2026-03-22)

### Decision
- Added dedicated UI preview routes for rapid UX iteration without requiring Cognito auth or live game backend services.

### What changed
- Introduced preview route set under `/ui-preview/*`:
  - `/ui-preview/landing`
  - `/ui-preview/lobby`
  - `/ui-preview/profile`
  - `/ui-preview/friends`
  - `/ui-preview/history`
  - `/ui-preview/room`
- Preview routes render mock data and click-through navigation for design feedback.
- Production routes and auth-protected behavior remain unchanged.

### Why
- Improves design iteration speed by removing auth/session/setup friction during UI reviews.
- Enables focused visual/usability feedback before feature/API wiring is complete.

### Validation
- `npm --prefix app/frontend run build` (pass)
- `npm --prefix app/frontend run test -- src/pages/LandingPage.test.jsx src/pages/LobbyPage.test.jsx` (pass)

### Notes
- Preview mode is not a substitute for end-to-end validation against real auth, WS, and game services.

## 22) CC0 Chess Event Sound System (2026-03-28)

### Decision
- Replaced the synthetic move beep with curated CC0 sound assets mapped to chess event types.
- Added user-controlled sound preference in the real room UI with persistence.

### What changed
- Sound asset pack:
  - Added curated `.ogg` files under `app/frontend/public/sounds/chesschat/`.
  - Added license/source record in `app/frontend/public/sounds/chesschat/LICENSES.md`.
- Mapping behavior:
  - `move_made` now plays event-specific cues (`move`, `capture`, `castle`, `promotion`) with `check` priority when `isCheck=true`.
  - `game_ended` now plays `win` or `draw` sound.
  - Blocking gameplay errors (for example `ILLEGAL_MOVE`) play `error` sound.
- Control surface:
  - Added `Sound On/Off` toggle in room action controls.
  - Preference persisted via `localStorage` key `chesschat_sound_enabled` (default `true`).

### Why
- Improves gameplay state legibility and perceived polish without adding UI clutter.
- Keeps licensing risk low and commercial-safe by using CC0 assets.
- Supports accessibility/usability by allowing immediate user mute at the application layer.

### Tradeoffs / risks
- Sound personalization is currently binary (on/off); no per-event or volume controls in v1.
- Browser autoplay policies can still suppress playback before user interaction; implementation safely no-ops in this case.

### Validation
- Backend unit tests expanded for move classification (`move/capture/castle/promotion`) and `isCheck`.
- Frontend unit/integration coverage expanded for sound mapping and disabled-preference suppression.
