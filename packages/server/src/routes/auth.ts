// Thin shim — the real auth router is composed in routes/auth/index.ts.
// Kept so existing importers (`import { auth } from "./auth.js"`) continue to work.
export { auth } from "./auth/index.js";
