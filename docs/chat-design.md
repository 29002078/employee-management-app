# Technical Design Document: Real-Time Chat Feature

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Proposed Solution](#proposed-solution)
3. [System Architecture](#system-architecture)
4. [Component Breakdown](#component-breakdown)
5. [API Design](#api-design)
6. [Data Models](#data-models)
7. [Security Considerations](#security-considerations)
8. [Performance Requirements](#performance-requirements)
9. [Deployment Strategy](#deployment-strategy)
10. [Trade-offs and Alternatives Considered](#trade-offs-and-alternatives-considered)
11. [Success Metrics](#success-metrics)

---

## Problem Statement

The existing employee management application provides structured CRUD operations for workforce records but offers no built-in communication channel between employees. This gap creates the following organizational and security problems:

- **Communication fragmentation** – employees rely on external tools (Slack, email, SMS) that are disconnected from the org structure already modeled in the application, making it impossible to tie conversations to departments, roles, or reporting lines.
- **No audit trail** – workplace communications conducted through third-party platforms cannot be centrally audited, which exposes the organization to compliance and HR risk.
- **No integration with org structure** – because chat lives outside the application, it cannot leverage the department and role data already present in the `employees` table to enforce access controls or scope conversations.
- **Security risk from uncontrolled external tools** – employees sharing sensitive HR or business information through consumer-grade messaging apps introduces data-exfiltration and eavesdropping risks that the organization cannot mitigate.

The goal of this feature is to **embed a secure, auditable, real-time chat system directly into the employee management application**, leveraging the existing org structure for room membership, enforcing end-to-end encryption so that sensitive communications never appear in plaintext on the server, and providing a complete audit record of all message events.

---

## Proposed Solution

Extend the existing full-stack application with a **chat subsystem** composed of four integrated layers:

- A **React chat UI** integrated into the existing SPA, consisting of new components (`ChatPanel`, `RoomList`, `MessageFeed`, `MessageComposer`) and supporting modules (`chatApi.js`, `cryptoUtils.js`) mounted alongside the existing employee management views without disrupting them.
- A **WebSocket server** built on `socket.io` and co-located with the existing Express API in `backend/src/server.js`, exposing a `/chat` namespace that handles bidirectional real-time messaging alongside the existing `/api/*` HTTP routes.
- **Redis pub/sub** acting as a message broker between multiple Node.js worker processes, enabling horizontal scaling to 10,000 concurrent users by decoupling per-socket event handling from cross-worker message fan-out via the `@socket.io/redis-adapter`.
- **PostgreSQL** replacing SQLite as the durable store for all chat data (messages, rooms, memberships, key bundles, read receipts), while the existing SQLite `employees.db` database remains unchanged and is cross-referenced via a foreign key.
- **Signal Protocol** (X3DH key agreement + Double Ratchet algorithm) for end-to-end encryption, with all cryptographic operations performed exclusively in the browser via `cryptoUtils.js` using the WebCrypto API. The server stores only ciphertext and public key material — plaintext never leaves the client.

---

## System Architecture

### High-Level Architecture

```mermaid
graph TD
    Browser["Browser\n(React SPA)"]
    Vite["Vite Dev Server\n/ Static Host\n:5173"]
    Express["Express + Socket.io\n:3001"]
    SQLite[("SQLite\nemployees.db")]
    Postgres[("PostgreSQL\nchat.db")]
    Redis["Redis\n(pub/sub channel)"]
    Worker2["Node.js Worker 2\n(PM2 cluster)"]

    Browser -->|"HTTP Fetch /api/*"| Express
    Browser -->|"WSS /chat"| Express
    Vite -->|serves static assets| Browser
    Express -->|"Knex.js queries\n(employees)"| SQLite
    Express -->|"Knex.js queries\n(chat)"| Postgres
    Express -->|"publish / subscribe"| Redis
    Redis -->|"fan-out"| Worker2
    Worker2 -->|"Knex.js queries\n(chat)"| Postgres
    Worker2 -->|"emit chat:message\nto User B socket"| Browser
```

### Message Send / Receive Flow

```mermaid
sequenceDiagram
    participant UA as User A (Browser)
    participant FEA as React SPA
    participant SC as Socket.io Client
    participant SS as Socket.io Server
    participant RD as Redis
    participant PG as PostgreSQL
    participant SW as Socket.io Server (Worker 2)
    participant FEB as React SPA (User B)
    participant UB as User B (Browser)

    UA->>FEA: Types message and presses Enter
    FEA->>FEA: cryptoUtils.encrypt() — Double Ratchet
    FEA->>SC: chatApi.send(roomId, ciphertext, iv, ephemeralKey)
    SC->>SS: emit chat:send { roomId, ciphertext, iv, ephemeralKey, messageId }
    SS->>SS: jsonwebtoken.verify(token) — validate JWT
    SS->>SS: Verify room membership for sender
    SS->>SS: Validate & sanitise payload fields
    SS->>PG: INSERT INTO messages (ciphertext, iv, ephemeral_key, ...)
    PG-->>SS: Inserted row confirmed
    SS->>RD: publish("room:room_a1b2c3", serialised message payload)
    RD-->>SW: Subscriber callback fires on Worker 2
    SW->>FEB: emit chat:message { messageId, roomId, senderId, ciphertext, iv, ephemeralKey, sentAt }
    FEB->>FEB: cryptoUtils.decrypt() — Double Ratchet
    FEB-->>UB: Render decrypted plaintext in MessageFeed
```

### Component Interaction

```mermaid
graph LR
    subgraph Frontend ["Frontend (React)"]
        App["App.jsx\n(state & routing)"]
        ChatPanel["ChatPanel\n(room state, socket lifecycle)"]
        RoomList["RoomList\n(room list, unread badges)"]
        MessageFeed["MessageFeed\n(scrollable history, read receipts)"]
        MessageComposer["MessageComposer\n(textarea, encrypt, send)"]
        ChatApi["chatApi.js\n(socket.io-client, REST wrappers)"]
        CryptoUtils["cryptoUtils.js\n(X3DH, Double Ratchet, IndexedDB)"]
        SocketClient["Socket.io Client"]
    end

    subgraph Backend ["Backend (Node.js / Express)"]
        Server["server.js\n(middleware, socket.io init)"]
        SocketServer["Socket.io Server\n(/chat namespace)"]
        ChatHandler["chatHandler.js\n(event listeners, rate limiting)"]
        ChatDb["chatDb.js\n(Knex / PostgreSQL)"]
        RedisClient["redisClient.js\n(ioredis pub/sub)"]
        ExpressRouter["Express Router"]
        EmployeesRoute["employees.js\n(existing routes)"]
        DatabaseJs["database.js\n(Knex / SQLite)"]
    end

    PG[("PostgreSQL DB")]
    RD[("Redis")]
    SQ[("SQLite DB")]

    App --> ChatPanel
    ChatPanel --> RoomList
    ChatPanel --> MessageFeed
    ChatPanel --> MessageComposer
    MessageComposer --> ChatApi
    MessageFeed --> ChatApi
    ChatApi --> CryptoUtils
    ChatApi <-->|"WebSocket events"| SocketClient

    SocketClient <-->|"WSS /chat"| Server
    Server --> SocketServer
    Server --> ExpressRouter
    SocketServer --> ChatHandler
    ChatHandler --> ChatDb
    ChatHandler --> RedisClient
    ChatDb --> PG
    RedisClient --> RD
    ExpressRouter --> EmployeesRoute
    EmployeesRoute --> DatabaseJs
    DatabaseJs --> SQ
```

---

## Component Breakdown

### Frontend

| Component | File | Responsibility |
|---|---|---|
| **ChatPanel** | `src/components/chat/ChatPanel.jsx` | Top-level chat container. Manages active room state, socket lifecycle (connect/disconnect), and lays out `RoomList` and `MessageFeed` side-by-side. Passes the JWT to `chatApi.connect()` on mount and calls `chatApi.disconnect()` on unmount. |
| **RoomList** | `src/components/chat/RoomList.jsx` | Fetches and displays all rooms/channels the authenticated user belongs to via `GET /api/chat/rooms`. Highlights the active room and renders unread message badge counts. Triggers `chatApi.join(roomId)` when the user selects a room. |
| **MessageFeed** | `src/components/chat/MessageFeed.jsx` | Renders the scrollable message history for the active room. Decrypts each incoming ciphertext via `cryptoUtils.decrypt()` before display. Uses `IntersectionObserver` to detect when messages scroll into the viewport and emits `chat:read` receipts accordingly. |
| **MessageComposer** | `src/components/chat/MessageComposer.jsx` | Controlled textarea for composing messages. Encrypts plaintext via `cryptoUtils.encrypt()` before passing the resulting ciphertext to `chatApi.send()`. Handles Enter-to-send with Shift+Enter for newlines. Disables submission while the socket is disconnected. |
| **chatApi** | `src/api/chatApi.js` | Manages the `socket.io-client` instance. Exposes `connect(token)`, `disconnect()`, `send(roomId, ciphertext)`, `onMessage(handler)`, and `onReadReceipt(handler)`. Also wraps REST calls for room management and paginated message history (`GET /api/chat/rooms/:id/messages`). |
| **cryptoUtils** | `src/utils/cryptoUtils.js` | Implements client-side key generation (X3DH identity key, signed pre-key, one-time pre-keys), key storage in `IndexedDB` as non-exportable `CryptoKey` objects, Double Ratchet encrypt/decrypt, and key bundle publication/retrieval helpers that call the key bundle REST endpoints. |

### Backend

| Module | File | Responsibility |
|---|---|---|
| **Chat Handler** | `src/chat/chatHandler.js` | Registers all socket event listeners (`chat:join`, `chat:send`, `chat:read`, `chat:leave`). Validates the JWT on every new connection via `jsonwebtoken.verify()`. Applies per-socket rate limiting (token-bucket, 60 messages/min). Persists messages and read receipts via `chatDb.js`. Publishes outbound messages to Redis and subscribes to room channels for incoming fan-out. |
| **Chat DB** | `src/chat/chatDb.js` | Knex singleton connected to PostgreSQL. Exposes `saveMessage()`, `getMessages()`, `markRead()`, `saveKeyBundle()`, `getKeyBundle()`, and `upsertPresence()`. All queries are parameterised; no raw string interpolation is used. |
| **Redis Client** | `src/chat/redisClient.js` | Wraps `ioredis` with a dedicated publisher instance and a dedicated subscriber instance (as required by `ioredis` for pub/sub). Exposes `publish(channel, payload)` and `subscribe(channel, handler)` used by `chatHandler.js` for cross-worker message fan-out. |
| **Key Bundle Router** | `src/routes/chatKeys.js` | REST endpoints (`POST /api/chat/keys`, `GET /api/chat/keys/:userId`) for publishing and retrieving X3DH public key bundles (identity key, signed pre-key, signed pre-key signature, and one-time pre-keys). Both routes require a valid JWT. |
| **Chat History Router** | `src/routes/chatHistory.js` | REST endpoints (`GET /api/chat/rooms`, `POST /api/chat/rooms`, `GET /api/chat/rooms/:id/messages`) for room management and cursor-based paginated message history retrieval. All routes require a valid JWT and enforce room membership before returning data. |

---

## API Design

### WebSocket Events

| Direction | Event | Payload | Description |
|---|---|---|---|
| Client → Server | `chat:join` | `{ roomId: string }` | Join a room channel. The server verifies room membership and subscribes the socket to that room's Redis channel. Subsequent `chat:message` events for that room are forwarded to this socket. |
| Client → Server | `chat:send` | `{ roomId: string, ciphertext: string, iv: string, ephemeralKey: string, messageId: string (UUID) }` | Send an encrypted message to a room. The server validates the JWT, checks membership, validates the payload, persists the ciphertext to PostgreSQL, and publishes to Redis. |
| Client → Server | `chat:read` | `{ roomId: string, messageId: string }` | Acknowledge that the client has read up to `messageId`. The server writes a `read_receipts` row and broadcasts `chat:read_receipt` to all room members. |
| Client → Server | `chat:leave` | `{ roomId: string }` | Leave a room channel. The server unsubscribes the socket from that room's Redis channel so it no longer receives new messages. |
| Server → Client | `chat:message` | `{ messageId: string, roomId: string, senderId: number, ciphertext: string, iv: string, ephemeralKey: string, sentAt: string (ISO 8601) }` | Deliver an encrypted message to all connected members of the room. Clients decrypt the ciphertext locally via `cryptoUtils.decrypt()`. |
| Server → Client | `chat:read_receipt` | `{ roomId: string, messageId: string, readerId: number, readAt: string }` | Notify all room members that a specific message was acknowledged as read by `readerId`. |
| Server → Client | `chat:error` | `{ code: string, message: string }` | Notify the client of a chat-specific error (e.g., `RATE_LIMITED`, `FORBIDDEN`, `INVALID_PAYLOAD`). The socket remains open unless the error is fatal. |

### WebSocket Authentication

The JWT is passed as a query parameter on the initial WebSocket handshake:

```
wss://host/chat?token=<JWT>
```

The server validates the token in the `socket.io` `connection` middleware using `jsonwebtoken.verify()` before any event listener is registered. Connections presenting an invalid, expired, or missing token are immediately disconnected with a `chat:error` event emitted prior to teardown. The decoded JWT payload is attached to the socket as `socket.data.user` for use in subsequent event handlers.

### REST Endpoints

| Method | Path | Description | Success | Error codes |
|---|---|---|---|---|
| `GET` | `/api/chat/rooms` | List all rooms the authenticated user belongs to. | `200 OK` | `401`, `500` |
| `POST` | `/api/chat/rooms` | Create a new group room or direct-message channel. Body: `{ name, type }`. | `201 Created` | `400`, `401`, `500` |
| `GET` | `/api/chat/rooms/:id/messages` | Cursor-based paginated message history. Supports `?before=<ISO8601>&limit=<n>`. Returns ciphertext only; never plaintext. | `200 OK` | `401`, `403`, `404`, `500` |
| `POST` | `/api/chat/keys` | Publish the authenticated user's X3DH public key bundle (identity key, signed pre-key, one-time pre-keys). | `201 Created` | `400`, `401`, `500` |
| `GET` | `/api/chat/keys/:userId` | Retrieve a specific user's X3DH public key bundle for initiating a session via X3DH key agreement. | `200 OK` | `401`, `404`, `500` |

### Request / Response Examples

**`chat:send` WebSocket event payload (Client → Server)**

```json
{
  "roomId": "room_a1b2c3",
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "ciphertext": "U2FsdGVkX1+base64encodedciphertext==",
  "iv": "aGVsbG93b3JsZA==",
  "ephemeralKey": "MFkwEwYHKoZIzj0CAQY..."
}
```

**`chat:message` WebSocket event payload (Server → Client)**

```json
{
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "roomId": "room_a1b2c3",
  "senderId": 42,
  "ciphertext": "U2FsdGVkX1+base64encodedciphertext==",
  "iv": "aGVsbG93b3JsZA==",
  "ephemeralKey": "MFkwEwYHKoZIzj0CAQY...",
  "sentAt": "2024-06-01T14:32:00.000Z"
}
```

**`GET /api/chat/rooms/:id/messages` response (`200 OK`)**

```json
{
  "messages": [
    {
      "messageId": "550e8400-e29b-41d4-a716-446655440000",
      "senderId": 42,
      "ciphertext": "U2FsdGVkX1+...",
      "iv": "aGVsbG93b3JsZA==",
      "ephemeralKey": "MFkwEwYHKoZIzj0CAQY...",
      "sentAt": "2024-06-01T14:32:00.000Z",
      "readBy": [{ "userId": 7, "readAt": "2024-06-01T14:32:05.000Z" }]
    }
  ],
  "nextCursor": "2024-06-01T14:31:00.000Z"
}
```

**WebSocket rate limit error (`chat:error` event)**

```json
{ "code": "RATE_LIMITED", "message": "Message rate limit exceeded. Please slow down." }
```

---

## Data Models

### Entity Relationship Diagram

```mermaid
erDiagram
    USERS {
        integer id PK "Auto-increment primary key"
        integer employee_id "Logical ref to employees(id) in SQLite — enforced at app layer"
        text public_identity_key "Curve25519 identity public key (NOT NULL)"
        timestamptz created_at "Row creation timestamp (NOT NULL)"
    }

    ROOMS {
        integer id PK "Auto-increment primary key"
        text name "Room display name (NOT NULL)"
        text type "direct or group (NOT NULL, CHECK)"
        timestamptz created_at "Row creation timestamp (NOT NULL)"
    }

    ROOM_MEMBERS {
        integer id PK "Auto-increment primary key"
        integer room_id FK "References rooms(id)"
        integer user_id FK "References users(id)"
        timestamptz joined_at "Membership timestamp (NOT NULL)"
    }

    MESSAGES {
        integer id PK "Auto-increment primary key"
        uuid message_id "Client-generated UUID (NOT NULL, UNIQUE)"
        integer room_id FK "References rooms(id)"
        integer sender_id FK "References users(id)"
        text ciphertext "Encrypted message body (NOT NULL)"
        text iv "AES-GCM initialisation vector, base64 (NOT NULL)"
        text ephemeral_key "Sender ephemeral public key, base64 (NOT NULL)"
        timestamptz sent_at "Message timestamp (NOT NULL)"
        timestamptz deleted_at "Soft-delete timestamp (nullable)"
    }

    READ_RECEIPTS {
        integer id PK "Auto-increment primary key"
        uuid message_id FK "References messages(message_id)"
        integer reader_id FK "References users(id)"
        timestamptz read_at "Read acknowledgement timestamp (NOT NULL)"
    }

    KEY_BUNDLES {
        integer id PK "Auto-increment primary key"
        integer user_id FK "References users(id)"
        text identity_key "X3DH identity public key (NOT NULL)"
        text signed_prekey "X3DH signed pre-key (NOT NULL)"
        text signed_prekey_signature "Signature over signed_prekey (NOT NULL)"
        integer prekey_id "One-time pre-key identifier (NOT NULL)"
        text one_time_prekey "X3DH one-time pre-key (nullable)"
        timestamptz created_at "Bundle creation timestamp (NOT NULL)"
    }

    USERS ||--o{ ROOM_MEMBERS : "belongs to"
    ROOMS ||--o{ ROOM_MEMBERS : "has"
    USERS ||--o{ MESSAGES : "sends"
    ROOMS ||--o{ MESSAGES : "contains"
    MESSAGES ||--o{ READ_RECEIPTS : "acknowledged by"
    USERS ||--o{ READ_RECEIPTS : "reads"
    USERS ||--o{ KEY_BUNDLES : "owns"
```

### Schema Definition (PostgreSQL DDL)

```sql
-- NOTE: employee_id logically references employees(id) in the separate SQLite
-- database. Because PostgreSQL and SQLite are distinct database engines, this
-- foreign key CANNOT be enforced at the database level. Referential integrity
-- is maintained at the application layer in chatDb.js (see Schema Notes below).
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL,
  public_identity_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rooms (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE room_members (
  id        SERIAL PRIMARY KEY,
  room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE messages (
  id            SERIAL PRIMARY KEY,
  message_id    UUID NOT NULL UNIQUE,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(id),
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  ephemeral_key TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_messages_room_sent ON messages (room_id, sent_at DESC);
CREATE INDEX idx_messages_sender    ON messages (sender_id);

CREATE TABLE read_receipts (
  id         SERIAL PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  reader_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reader_id)
);

CREATE TABLE key_bundles (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_key            TEXT NOT NULL,
  signed_prekey           TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  prekey_id               INTEGER NOT NULL,
  one_time_prekey         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_key_bundles_user ON key_bundles (user_id);
```

### Notes

- The `messages` table stores only ciphertext; plaintext never touches the server or is written to any log.
- `ephemeral_key` carries the sender's ephemeral Curve25519 public key, which the recipient uses in the Double Ratchet to derive the per-message symmetric decryption key.
- `deleted_at` implements soft-delete; rows are retained for compliance audit purposes and are excluded from active queries via `WHERE deleted_at IS NULL`.
- `idx_messages_room_sent` is the critical index for cursor-based paginated history queries of the form `WHERE room_id = $1 AND sent_at < $2 ORDER BY sent_at DESC LIMIT $3`, turning what would be a full table scan into a fast index range scan.
- The existing SQLite `employees` table is cross-referenced via `users.employee_id` but resides in a separate database file; no cross-database foreign key constraint is enforced at the database level — referential integrity is maintained at the application layer in `chatDb.js`.

---

## Security Considerations

### Implemented Controls

| Control | Implementation |
|---|---|
| **End-to-end encryption** | X3DH key agreement for initial session establishment + Double Ratchet algorithm for per-message symmetric key derivation. All encryption and decryption is performed exclusively in the browser via `cryptoUtils.js` using the WebCrypto API (hardware-accelerated AES-GCM). The server stores and forwards only ciphertext; plaintext is never present outside the client. |
| **Key storage** | Private keys are stored exclusively in the client's `IndexedDB` as non-exportable `CryptoKey` objects (where the browser supports the `extractable: false` flag). They are never serialised, logged, or transmitted to the server under any code path. |
| **JWT authentication** | Every WebSocket connection is validated against the JWT passed in the handshake query parameter using `jsonwebtoken.verify()` before any event listener is registered. Connections with invalid, expired, or missing tokens are immediately disconnected. All REST endpoints in `chatKeys.js` and `chatHistory.js` also require a valid JWT via Express middleware. |
| **WebSocket rate limiting** | Per-socket rate limiting is enforced in `chatHandler.js` using a token-bucket algorithm: a maximum of **60 messages per minute** per connection. Exceeding the limit results in a `chat:error` event with code `RATE_LIMITED`; the offending message is not persisted. Repeated violations increment a strike counter and trigger a configurable temporary ban (default: 5 minutes). |
| **Room membership enforcement** | The server verifies room membership from the `room_members` table on every `chat:send` and `chat:join` event. Non-members receive `chat:error` with code `FORBIDDEN` and the event is discarded without any database write or Redis publish. |
| **Input validation** | `roomId` and `messageId` are validated as non-empty strings matching expected formats (UUID v4 for `messageId`). `ciphertext`, `iv`, and `ephemeralKey` are validated as base64-encoded strings with minimum and maximum length bounds before any persistence. Payloads failing validation receive `chat:error` with code `INVALID_PAYLOAD`. |
| **Soft-delete audit trail** | Messages are never hard-deleted. A `deleted_at` timestamp is set instead, preserving the full encrypted audit record. Deletion can only be requested by the original sender and is enforced at the application layer. |
| **Transport security** | All WebSocket connections are upgraded to WSS (TLS 1.2+) in production via Nginx TLS termination. HTTP upgrade headers (`Upgrade: websocket`, `Connection: upgrade`) are validated by socket.io before the handshake is accepted. |

### E2E Encryption Scheme

The **Signal Protocol** (X3DH + Double Ratchet) is used for end-to-end encryption. The flow proceeds as follows:

1. **Key registration** — on first login, the client generates an identity key pair (Curve25519), a signed pre-key pair (Curve25519), and a batch of one-time pre-key pairs (Curve25519). The public halves of all keys are published to `POST /api/chat/keys`. Private keys are stored in `IndexedDB` as non-exportable `CryptoKey` objects (using `extractable: false` in the WebCrypto API — see the **Key storage** row in Implemented Controls above for browser compatibility notes) and never leave the device.

2. **Session initiation (X3DH)** — to send a message to User B for the first time, User A fetches User B's key bundle from `GET /api/chat/keys/:userId`. User A performs the X3DH key agreement protocol — computing four Diffie-Hellman operations over the identity, signed pre-key, and one-time pre-key pairs — to derive a shared 32-byte master secret. This shared secret seeds the initial Double Ratchet root key. User A's ephemeral public key is included in the first message so User B can independently reproduce the X3DH computation and arrive at the same root key without any further interaction.

3. **Message encryption (Double Ratchet)** — each subsequent message is encrypted with a unique 256-bit AES-GCM message key derived by advancing the Double Ratchet state. The ratchet advances both a symmetric-key ratchet (for each message within a sending chain) and a Diffie-Hellman ratchet (on each reply), providing **forward secrecy** (past messages cannot be decrypted if a current key is compromised) and **break-in recovery** (future messages are protected even after a past session state compromise).

4. **Key bundle in message payload** — the `ephemeralKey` field in each `chat:send` and `chat:message` event carries the sender's ephemeral Curve25519 public key so the recipient can advance its own ratchet state and derive the correct per-message decryption key without requiring a separate round-trip.

### Recommendations for Production

| Risk | Recommendation |
|---|---|
| **One-time pre-key exhaustion** | Implement server-side monitoring of the `key_bundles` table; alert the client and prompt a replenishment upload when fewer than 5 one-time pre-keys remain for a given user. Fall back gracefully to the signed pre-key when the one-time pre-key pool is empty. |
| **JWT secret management** | Store the JWT signing secret in a dedicated secrets manager (AWS Secrets Manager or HashiCorp Vault). Rotate the secret quarterly. Use RS256 (RSA asymmetric signing) rather than HS256 to allow signature verification without distributing the private signing key. |
| **Redis security** | Enable Redis `AUTH` password authentication and TLS for the pub/sub channel (`rediss://` URI). Restrict Redis network access to the internal VPC subnet; never expose the Redis port publicly. |
| **PostgreSQL credentials** | Use a dedicated least-privilege PostgreSQL role with `SELECT`, `INSERT`, `UPDATE` on chat tables only — no DDL permissions in production. Rotate credentials via the secrets manager and use a connection pooler (PgBouncer) to cap database connections. |
| **Key bundle freshness** | Implement signed pre-key rotation on a 30-day schedule. When a new signed pre-key is uploaded, existing sessions are allowed to drain before the old key is invalidated. Notify clients holding stale sessions to re-initiate X3DH. |
| **Side-channel metadata** | Even with E2E encryption, server logs expose sender IDs, room IDs, message timestamps, and payload sizes. Apply structured log redaction policies to strip these fields in compliance-sensitive environments. Consult legal counsel for GDPR/HIPAA requirements. |
| **WebSocket origin validation** | Configure `socket.io` `allowedOrigins` to the exact frontend origin (e.g., `https://app.example.com`) to prevent cross-site WebSocket hijacking (CSWSH). Reject connections from unlisted origins at the handshake stage. |
| **CORS** | Restrict the `cors()` middleware on all `/api/chat/*` routes to the exact frontend origin. Do not use a wildcard (`*`) in production as it would allow arbitrary cross-origin requests to the key bundle and history endpoints. |

---

## Performance Requirements

### Targets

| Metric | Target |
|---|---|
| Message delivery latency (p95) | < 100 ms end-to-end under 10,000 concurrent connections |
| Message delivery latency (p99) | < 300 ms |
| WebSocket connection establishment | < 500 ms including JWT validation and Redis subscription |
| Message history REST response time (p95) | < 150 ms for 50-message pages served via index scan |
| PostgreSQL write throughput | ≥ 5,000 `INSERT` operations/s on the `messages` table (benchmark target) |
| Redis pub/sub fan-out overhead | < 5 ms per publish within the same datacenter network |
| Frontend E2E encrypt / decrypt | < 10 ms per message using WebCrypto API hardware-accelerated AES-GCM |
| Concurrent users | 10,000 simultaneous WebSocket connections across a horizontally scaled PM2 cluster |

### Bottlenecks and Mitigations

```mermaid
graph LR
    A["10k WebSocket connections\non single Node.js process"] -->|"Event loop saturation\nunder connection spike"| B["Event loop saturation"]
    B --> C["Horizontal scale:\nN worker processes\n+ Redis pub/sub fan-out\nvia @socket.io/redis-adapter"]

    D["PostgreSQL message writes\n(high-frequency inserts)"] -->|"Write I/O bottleneck\nat peak throughput"| E["Write I/O bottleneck"]
    E --> F["Connection pooling\n(pg-pool, max 20)\n+ PostgreSQL WAL tuning\n(synchronous_commit = off)"]

    G["X3DH key bundle fetches\non session init"] -->|"REST API spike\non login burst"| H["REST API spike\non login burst"]
    H --> I["Cache key bundles\nin Redis (TTL 1 h)\nto absorb login-burst reads"]

    J["Message history pagination\nwithout index"] -->|"Sequential table scan\non large rooms"| K["Sequential table scan"]
    K --> L["idx_messages_room_sent\ncomposite index\n(room_id, sent_at DESC)"]
```

### Scalability Notes

- Each Node.js worker handles approximately 2,500 concurrent WebSocket connections at comfortable event-loop utilisation (socket.io default connection overhead). Four PM2 workers therefore support 10,000 concurrent users.
- **Redis pub/sub** decouples workers: when User A (connected to Worker 1) sends a message to a room that User B (connected to Worker 2) has joined, Worker 1 publishes to the `room:<roomId>` Redis channel, and Worker 2's subscriber callback delivers the event to User B's socket without any inter-process communication outside Redis.
- **PostgreSQL read replicas** can serve `GET /api/chat/rooms/:id/messages` history queries to reduce read pressure on the primary, since historical messages are immutable once written.
- The `idx_messages_room_sent` composite index is critical: it makes the cursor-based pagination query (`WHERE room_id = $1 AND sent_at < $2 ORDER BY sent_at DESC LIMIT $3`) an index range scan with a cost proportional to the page size, not the total table size.
- The `UNIQUE (message_id)` index on `messages` also acts as an idempotency guard: if a client retransmits a `chat:send` after a network timeout, the duplicate `INSERT` will fail with a unique constraint violation that is caught and silently ignored by `chatHandler.js`, preventing double-delivery.

---

## Deployment Strategy

### Development Environment

```mermaid
graph LR
    Dev["Developer Machine"]
    FE["Vite Dev Server\nlocalhost:5173"]
    BE["Nodemon\nlocalhost:3001"]
    RD[("Redis\nDocker :6379")]
    PG[("PostgreSQL\nDocker :5432")]
    SQ[("employees.db\nlocal SQLite file")]

    Dev --> FE
    Dev --> BE
    BE --> RD
    BE --> PG
    BE --> SQ
    FE -->|"proxy /api/ and /chat →\nlocalhost:3001"| BE
```

Steps:

```bash
# Terminal 1 – infrastructure (Redis + PostgreSQL via Docker Compose)
docker compose -f docker-compose.dev.yml up -d

# Terminal 2 – backend
cd backend && npm install && npm run dev

# Terminal 3 – frontend
cd frontend && npm install && npm run dev
```

### Production Deployment

```mermaid
graph TD
    Client["Client Browser"]
    Nginx["Nginx (reverse proxy)\nTLS termination :443"]
    Static["Static Files\n(Vite build output)"]
    Worker1["Node.js Worker 1\n(PM2 cluster :3001)"]
    Worker2["Node.js Worker 2\n(PM2 cluster :3001)"]
    PG[("PostgreSQL\nprimary + read replica")]
    RD["Redis Cluster\n(pub/sub)"]

    Client -->|"HTTPS :443"| Nginx
    Nginx -->|"/ → serve"| Static
    Nginx -->|"/api/* and /chat\nWebSocket upgrade"| Worker1
    Nginx -->|"/api/* and /chat\nWebSocket upgrade"| Worker2
    Worker1 --> PG
    Worker2 --> PG
    Worker1 --> RD
    Worker2 --> RD
    RD -->|"pub/sub fan-out"| Worker1
    RD -->|"pub/sub fan-out"| Worker2
```

#### Steps

1. **Build the frontend:**
   ```bash
   cd frontend && npm run build
   # Output: frontend/dist/
   ```

2. **Configure Nginx** to serve `frontend/dist` for `/`, proxy `/api/` to the backend cluster, and forward WebSocket upgrade requests at `/chat` to the backend cluster with the required headers:
   ```
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```

3. **Run the backend with PM2:**
   ```bash
   npm install -g pm2
   cd backend && pm2 start src/server.js --name chat-api -i 4
   pm2 save && pm2 startup
   ```

4. **Environment variables** (set in PM2 ecosystem config or OS environment):
   ```
   PORT=3001
   DATABASE_URL=postgresql://chat:${POSTGRES_PASSWORD}@postgres:5432/chatdb
   REDIS_URL=redis://redis:6379
   JWT_SECRET=${JWT_SECRET}
   NODE_ENV=production
   ```

5. **TLS:** Provision a certificate via Let's Encrypt (`certbot`) and configure Nginx to redirect HTTP → HTTPS on port 443.

### Container-Based Deployment (Docker Compose)

```mermaid
graph LR
    subgraph Docker Compose
        FEContainer["frontend\nnginx:alpine\n:80 / :443"]
        BEContainer["backend\nnode:20-alpine\n:3001"]
        PGContainer[("postgres\npostgres:16-alpine")]
        RDContainer[("redis\nredis:7-alpine")]
        PGVolume[("postgres-data\nDocker volume")]
    end

    Internet["Internet"] -->|":80 / :443"| FEContainer
    FEContainer -->|"/api/* and /chat proxy"| BEContainer
    BEContainer --> PGContainer
    BEContainer --> RDContainer
    PGContainer --> PGVolume
```

```yaml
# docker-compose.yml (illustrative)
services:
  backend:
    build: ./backend
    environment:
      - PORT=3001
      - DATABASE_URL=postgresql://chat:${POSTGRES_PASSWORD}@postgres:5432/chatdb
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
      - NODE_ENV=production
    depends_on:
      - postgres
      - redis

  frontend:
    build: ./frontend
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - backend

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=chatdb
      - POSTGRES_USER=chat
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}

volumes:
  postgres-data:
```

---

## Trade-offs and Alternatives Considered

### Real-Time Transport: WebSocket (socket.io) vs. SSE vs. Long-Polling

| Factor | WebSocket / socket.io (chosen) | Server-Sent Events (SSE) | Long-Polling |
|---|---|---|---|
| Bidirectional | Yes — client and server can both initiate messages | No — server→client push only; client writes require separate HTTP requests | Simulated via repeated request/response cycles |
| Protocol overhead | Low — single persistent TCP connection per client after upgrade | Low — standard HTTP/1.1 persistent connection | High — a new HTTP connection is established for every poll cycle |
| Proxy / firewall compatibility | Good — socket.io falls back to HTTP long-polling automatically when WebSocket is blocked | Excellent — plain HTTP; universally compatible | Excellent — plain HTTP; universally compatible |
| Horizontal scaling | Requires sticky sessions or a pub/sub adapter (Redis) to fan-out across workers | Requires pub/sub for cross-worker delivery | Stateless — any worker can handle any poll request |
| Library maturity | socket.io is battle-tested at scale; includes reconnection logic, rooms, and the `@socket.io/redis-adapter` | Native browser `EventSource` API; no library needed | Simple `fetch` loop; no library needed |
| Suitable when | Bidirectional real-time messaging at scale with read receipts | One-way notification streams (e.g., live feed, progress updates) | Legacy environments or where WebSocket is unavailable |

**Decision:** WebSocket via socket.io was chosen for its native bidirectionality (required for read receipts and typing indicators), built-in automatic reconnection and transport fallback, and the first-class `@socket.io/redis-adapter` for horizontal scaling across PM2 workers without requiring application-level pub/sub code.

### Message Persistence: PostgreSQL vs. MongoDB

| Factor | PostgreSQL (chosen) | MongoDB |
|---|---|---|
| Schema enforcement | Strong — foreign keys, `NOT NULL` constraints, `CHECK` constraints, `UNIQUE` constraints enforced by the database engine | Flexible — schema-less; validation is optional and must be configured separately |
| Relational queries | Native SQL joins across rooms, members, and messages with query planner optimisation | Requires `$lookup` aggregation pipeline stages; less ergonomic for relational data |
| Full-text search | Native `tsvector` / `pg_trgm` extensions available (relevant for future message search) | Atlas Search (hosted only) or self-managed Lucene via MongoDB Atlas |
| Horizontal write scaling | Requires Citus extension or application-level sharding for planet-scale writes | Built-in horizontal sharding via replica sets and config servers |
| Existing team tooling | Knex.js is already used for the SQLite database — switching to PostgreSQL requires only a `client: 'pg'` config change | Requires Mongoose or the native MongoDB driver; significant dependency and query API change |
| Suitable when | Structured relational data with strong consistency requirements and an existing Knex workflow | Flexible document structures, write-heavy at planet scale, or when MongoDB is the team's primary datastore |

**Decision:** PostgreSQL was chosen because the chat data model is inherently relational (users ↔ room memberships ↔ rooms ↔ messages ↔ read receipts), the team already uses Knex.js (making the migration a trivial `client` swap), and PostgreSQL provides the strong consistency and foreign-key integrity appropriate for an auditable workplace communication tool.

### E2E Encryption: Signal Protocol vs. PGP vs. TLS-only

| Factor | Signal Protocol / X3DH + Double Ratchet (chosen) | PGP / OpenPGP | TLS-only (no E2E) |
|---|---|---|---|
| Forward secrecy | Yes — per-message key derivation means past sessions cannot be decrypted if a current key is compromised | No — all messages encrypted with the same long-lived key pair until manual rotation | No — TLS protects the wire; the server sees and could log plaintext |
| Break-in recovery | Yes — the DH ratchet ensures future messages are protected even after a session state compromise | No — past and future messages share the same key compromise blast radius | No |
| Key management complexity | High — ratchet state must be maintained per session per device; key bundle replenishment required | Medium — one key pair per user; key distribution via a keyserver is well-understood | None — no client-side key management required |
| Server sees plaintext | Never — the server stores and forwards only ciphertext and public key material | Never (if correctly implemented) | Yes — the server decrypts TLS and has access to plaintext |
| Library support | `@signalapp/libsignal-client` (WASM build for browsers); production-grade and audited | `OpenPGP.js` — mature, browser-compatible, widely used | N/A |
| Suitable when | Modern secure workplace messaging requiring compliance-grade forward secrecy and break-in recovery | Asynchronous email-style encryption where forward secrecy is not required | Internal tooling with no strict data privacy requirements and full trust in the server operator |

**Decision:** Signal Protocol was chosen because it provides both forward secrecy and break-in recovery (the two properties most critical for a workplace chat tool where past and future message confidentiality must both be preserved), is the industry standard for modern secure messaging (adopted by WhatsApp, Signal, and partially by Slack), and the `@signalapp/libsignal-client` WASM library provides a production-ready, audited browser implementation that avoids the need to implement the cryptographic primitives from scratch.

---

## Success Metrics

### Functional

- [ ] Authenticated users can create and join group rooms and direct-message channels.
- [ ] Messages sent in a room are received in real time by all connected room members within 100 ms (p95).
- [ ] Messages are persisted to PostgreSQL and are retrievable via paginated REST history after reconnection.
- [ ] Read receipts are delivered to all connected room members when a message is acknowledged by a recipient.
- [ ] Messages are decrypted correctly on the recipient's client; the server never stores or logs plaintext content.
- [ ] Users can rejoin a room after a disconnect and receive messages sent during the offline period via the REST history endpoint.

### Quality

- [ ] Backend chat module has ≥ 90% test coverage across unit and integration tests for `chatHandler.js` and `chatDb.js`.
- [ ] Frontend `cryptoUtils.js` has 100% unit-test coverage for encrypt/decrypt round-trips, key generation, and key storage.
- [ ] All WebSocket events and REST endpoints pass ESLint with zero errors and have JSDoc annotations for every exported function.
- [ ] End-to-end message delivery latency is verified to be < 100 ms p95 under a 10,000 concurrent-connection load test run with k6 or Artillery.

### Operational

- [ ] The chat subsystem starts successfully alongside the existing Express server with no changes to or regressions in the existing `/api/employees` routes.
- [ ] Redis pub/sub fan-out is verified end-to-end: a message sent on Worker 1 is delivered to a client whose socket is connected to Worker 2.
- [ ] The `/health` endpoint is extended to reflect chat subsystem health, including a PostgreSQL ping and a Redis ping, returning `{ "status": "ok", "postgres": "ok", "redis": "ok" }`.
- [ ] PM2 restarts a crashed worker within 5 seconds without dropping connections or messages on surviving workers.

### Security

- [ ] WebSocket connections presenting an invalid, expired, or missing JWT are rejected immediately with no chat events processed.
- [ ] A user belonging to Room A cannot send, receive, or read events for Room B — room membership enforcement is verified by automated integration tests.
- [ ] Rate limiting emits `chat:error { code: "RATE_LIMITED" }` after 60 messages per minute and does not persist any excess messages to PostgreSQL.
- [ ] Ciphertext stored in PostgreSQL cannot be decoded without the client-side private key — verified by attempting decryption with a different key pair and confirming failure.
- [ ] No plaintext message content appears in server-side logs, error responses, or any database column.
