// spec-222 — ambient declaration so tsc accepts the bundler-resolved svg imports
// (Specky.tsx). The host bundler (Vite, in the app) emits the real string URL; for
// `tsc -b` this just types the default export as a string.
declare module '*.svg' {
  const src: string;
  export default src;
}
