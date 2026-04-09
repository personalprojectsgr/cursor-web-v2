# Session-to-Window Binding Issues

## Core Problem

When multiple Cursor IDE windows connect to the same MCP server endpoint (`/mcp`), each creates an anonymous HTTP session. The server cannot determine which session belongs to which window, causing messages from the web client to be delivered to the wrong window's agent.

## Root Cause

The MCP protocol's `initialize` request only includes `clientInfo: { name: "Cursor", version: "..." }` -- identical for all windows. The `Mcp-Session-Id` is server-generated and carries no window identity. This is a known limitation of the MCP protocol (see [anthropics/claude-code#41836](https://github.com/anthropics/claude-code/issues/41836)).

## Issue Timeline

### 1. Messages Swallowed (Initial)
- **Symptom**: User sends message, never delivered to agent.
- **Cause**: No message queue. If `wait_for_response` wasn't actively waiting, message was lost.
- **Fix**: Added `pendingMessages` queue, messages drain on next `wait_for_response` call.

### 2. Cross-Window Message Leak
- **Symptom**: Message sent to Window A delivered to Window B's agent.
- **Cause**: `route()` had a "cross-bind" fallback that would deliver to any available session.
- **Fix**: Removed cross-bind, enforced strict session isolation.

### 3. SSE Stream Death
- **Symptom**: Agent stops receiving messages after extended idle period.
- **Cause**: Cursor's internal MCP tool timeout (60s default) and Railway's 15-minute HTTP timeout killed stale SSE streams. Previous keepalive pings didn't reset Cursor's timeout.
- **Fix**: Replaced complex keepalive with 4-minute auto-resolve returning `[keepalive]` text, forcing agent to re-call `wait_for_response` with a fresh HTTP connection.

### 4. Wrong Window Binding (Ongoing)
- **Symptom**: Session A binds to Window B's chatKey, Session B binds to Window A's chatKey. Messages routed to wrong window.
- **Cause**: Auto-bind picks sessions arbitrarily when CDP data isn't available yet.
- **Attempts**:
  - CDP `activeMcp` matching: Failed because DOM text uses display names (`Wait For Response`) not internal names (`wait_for_response`). Fixed with regex, but still unreliable due to timing.
  - Waiter preference: Pick the session with an active waiter. Fails when both sessions have waiters, or neither does yet.
  - `_doRebindUnbound` mismatch correction: Detects and corrects wrong bindings, but by the time it runs (10s interval), the first message may already be delivered to the wrong window.
  - Timing correlation: Unreliable due to bridge relay latency, CDP poll intervals, and simultaneous session creation.

## Current Architecture

```
Cursor Window A  ──POST /mcp──►  Railway Server  ◄──Socket.IO──  Web Client
Cursor Window B  ──POST /mcp──►       │
                                      │
                              Session abc123 (anonymous)
                              Session def456 (anonymous)
                                      │
                              Which is which? ← THE PROBLEM
```

## Proposed Solution

Add optional `chat_id` parameter to `wait_for_response`. The agent passes its workspace/project name, enabling deterministic server-side binding by matching against CDP `documentTitle`.
