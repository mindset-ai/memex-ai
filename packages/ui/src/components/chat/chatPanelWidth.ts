// spec-415 (dec-2): the single source of truth for the in-app agent panels' width
// bounds. Extracted out of ResizableChatRail.tsx so the floor lives in ONE place
// that every docked-agent mechanism imports — the percentage-sized drift panel in
// DocumentShell.tsx and the pixel-sized rails (standards/issues/scaffold) can no
// longer drift apart. The floor (CHAT_MIN_W) is the shared minimum; default/max
// stay rail-only knobs.
export const CHAT_MIN_W = 300;
export const CHAT_DEFAULT_W = 384; // = the old fixed w-96
export const CHAT_MAX_W = 720;
