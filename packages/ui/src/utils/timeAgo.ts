// spec-259 dec-5: the relative-time helper now lives once in @memex/shared so the
// server (MCP/agent) and the UI render WHEN identically. This module re-exports it
// to keep the existing `utils/timeAgo` import path stable for spec-286's consumers.
export { timeAgo } from '@memex/shared';
