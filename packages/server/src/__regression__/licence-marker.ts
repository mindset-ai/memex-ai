// The licence-tier predicate, shared by the per-Spec fair-code guards.
//
// In this repo THE FILE PATH IS THE LICENCE MARKER: a `.ee.` filename or a `.ee`
// directory segment puts a file under the Memex Enterprise License; everything else is
// the Sustainable Use License. Adding or removing the marker re-licenses the file, so
// every Spec makes an explicit fair-code/EE call up front [per std-25], and a PR
// touching EE files needs a signed CLA.
//
// Extracted from spec-500's guard when spec-545 became its second consumer. Four lines
// is a thin module, and normally the deletion test would say inline it — but this
// particular predicate decides which licence a file ships under, and two copies that
// drift on a detail (is `.ee` an exact path segment, or any segment containing it?)
// disagree about something with legal consequences rather than merely cosmetic ones
// [per std-51]. One definition, many callers.

/** True when a repo-relative path carries the EE marker in its filename or a dirname. */
export function isEeMarked(repoRelPath: string): boolean {
  const segments = repoRelPath.split("/");
  const base = segments.pop() ?? "";
  // `.ee.` filename marker OR `.ee` as an exact directory segment. An exact segment
  // match on purpose: a directory merely CONTAINING ".ee" (say `packages/tree.ee-old`)
  // is not the marker, and treating it as one would mis-report a fair-code file as EE.
  return base.includes(".ee.") || segments.includes(".ee");
}

/** The EE-marked subset of `paths` — empty when every path is fair-code. */
export function eeMarkedAmong(paths: readonly string[]): string[] {
  return paths.filter(isEeMarked);
}
