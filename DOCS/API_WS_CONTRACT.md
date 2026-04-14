# CHESSCHAT API + WebSocket Contract

Last updated: 2026-03-28  
Status: Active

## HTTP Contract

### `GET /healthz` (Public)
- Auth: none
- Success `200`
```json
{ "status": "ok", "ts": 1700000000000 }
```

### `GET /api/me` (Authenticated)
- Auth: Cognito access token bearer
- Success `200`
```json
{
  "user": {
    "user_id": "cognito-sub",
    "username": "tim",
    "display_name": "tim",
    "wins": 3,
    "losses": 1,
    "draws": 2
  },
  "needs_username": false
}
```

### `POST /api/profile` (Authenticated)
- Auth: Cognito access token bearer
- Payload
```json
{ "username": "tim.player" }
```
- Username regex: `^[a-z0-9._-]{3,24}$`

### `GET /api/history` (Authenticated)
- Auth: Cognito access token bearer
- Success `200`
```json
{ "games": [] }
```

### `GET /api/friends` (Authenticated)
- Returns accepted friendships for current user.

### `GET /api/friends/requests` (Authenticated)
- Returns pending received/sent friend requests.

### `POST /api/friends/requests` (Authenticated)
- Payload: `{ "username": "friend_name" }`

### `POST /api/friends/requests/:requestId/respond` (Authenticated)
- Payload: `{ "action": "accept" }` or `{ "action": "decline" }`

### `GET /api/challenges` (Authenticated)
- Returns pending/active challenge records for current user.

### `POST /api/challenges` (Authenticated)
- Payload:
```json
{
  "username": "friend_name",
  "settings": {
    "timeWhiteSeconds": 300,
    "timeBlackSeconds": 300,
    "allowTakebacks": true,
    "takebacksWhite": 2,
    "takebacksBlack": 2
  }
}
```

### `POST /api/challenges/:challengeId/accept` (Authenticated)
- Accepts incoming challenge and keeps pre-created room code.

### `GET /api/notifications` (Authenticated)
- Returns in-app notifications.

### `POST /api/notifications/:notificationId/read` (Authenticated)
- Marks one notification as read.

### `GET /api/chesscom/link` (Authenticated)
- Returns Chess.com linked status from user record.

### `POST /api/chesscom/link` (Authenticated)
- Payload: `{ "username": "your_chesscom_name", "access_token": "optional" }`

### `DELETE /api/chesscom/link` (Authenticated)
- Unlinks Chess.com metadata from user record.

## WebSocket Contract

## Connection
- Endpoint: `GET /ws?token=<cognito_access_token>`
- Auth failure: close code `4001` with reason `Unauthorized`
- Token must be present for connect and reconnect attempts.

## Inbound Events

### `join_room`
```json
{ "type": "join_room", "roomCode": "AB12CD34" }
```

### `leave_room`
```json
{ "type": "leave_room", "roomCode": "AB12CD34" }
```

### `start_game`
```json
{
  "type": "start_game",
  "roomCode": "AB12CD34",
  "settings": {
    "timeWhiteSeconds": 300,
    "timeBlackSeconds": 300,
    "allowTakebacks": true,
    "takebacksWhite": 2,
    "takebacksBlack": 2
  }
}
```

### `make_move`
```json
{ "type": "make_move", "roomCode": "AB12CD34", "move": "e2e4" }
```

### `resign`
```json
{ "type": "resign", "roomCode": "AB12CD34" }
```

### `request_takeback`
```json
{ "type": "request_takeback", "roomCode": "AB12CD34" }
```

### `offer_draw`
```json
{ "type": "offer_draw", "roomCode": "AB12CD34" }
```

### `accept_draw`
```json
{ "type": "accept_draw", "roomCode": "AB12CD34" }
```

### `heartbeat`
```json
{ "type": "heartbeat" }
```

## Outbound Events

### `room_joined`
```json
{
  "type": "room_joined",
  "roomCode": "AB12CD34",
  "participants": [{ "userId": "user-a", "connected": true }],
  "expiresAt": 1700003600000,
  "activeGame": null
}
```

### `participant_joined` / `participant_left`
```json
{
  "type": "participant_left",
  "roomCode": "AB12CD34",
  "userId": "user-b",
  "participants": [
    { "userId": "user-a", "connected": true },
    { "userId": "user-b", "connected": false }
  ]
}
```

### `reconnect_state`
```json
{
  "type": "reconnect_state",
  "roomCode": "AB12CD34",
  "status": "paused",
  "disconnectedUserId": "user-b",
  "graceEndsAt": 1700000012000,
  "reconnectVersion": 3
}
```

### `game_started`
- Payload includes game IDs, player IDs, board state, settings, and clocks.

### `move_made`
```json
{
  "type": "move_made",
  "roomCode": "AB12CD34",
  "move": "e2e4",
  "moveSan": "e4",
  "moveType": "move",
  "isCheck": false,
  "moves": ["e2e4"],
  "moveSans": ["e4"],
  "moveFens": ["start", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"],
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "turn": "black",
  "timeWhite": 299.8,
  "timeBlack": 300,
  "drawOffer": null,
  "takebacksWhiteUsed": 0,
  "takebacksBlackUsed": 0,
  "serverTimestampMs": 1700000001000
}
```
- `moveType` enum: `"move" | "capture" | "castle" | "promotion"`.
- `isCheck`: boolean indicator used by frontend sound/status UX.

### `game_ended`
- Payload includes winner, result reason, PGN, and reconnect version.

### `takeback_applied`
- Broadcast after server-validated unilateral takeback.

### `draw_offer_pending`
- Broadcast when one player offers draw.

### `draw_offer_state`
- Current draw offer state for room/game sync.

### `draw_accepted`
- Broadcast before game ends as agreed draw.

### `video_ready`
```json
{
  "type": "video_ready",
  "meetingData": { "MeetingId": "..." },
  "attendeeData": { "AttendeeId": "..." }
}
```

### `heartbeat_ack`
```json
{ "type": "heartbeat_ack" }
```

### `error`
```json
{
  "type": "error",
  "code": "ROOM_CODE_CONSUMED",
  "message": "Room code has already been used.",
  "retryable": false,
  "context": null
}
```

## Validation Rules
- Room-bound events (`join_room`, `start_game`, `make_move`, `resign`, `request_takeback`, `offer_draw`, `accept_draw`) require 8-char alphanumeric room code.
- Reconnect is accepted only for the same authenticated user and only within active grace window.
- Takeback is unilateral and immediate if legal (requester must be last mover and opponent has not moved yet).
- Draw offer is single-pending; no re-offer while pending. Pending persists until accepted or game end.
- Room codes are single-use after final teardown.
