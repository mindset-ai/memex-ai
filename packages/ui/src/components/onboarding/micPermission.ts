// spec-242 — does this browser session already hold microphone permission?
//
// Used to decide whether the mic-priming page shows the "Turn on Mic" button: a
// user who has already granted the mic never sees it. We query the Permissions
// API (not getUserMedia — that would itself trigger the prompt we're trying to
// pre-empt). The API is absent / unreliable on some browsers (notably Safari),
// so any failure resolves to `false` (assume not-granted → show the button),
// which is the safe default: the worst case is offering a button to a user who
// could also have started voice another way.

export async function isMicAlreadyGranted(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return false;
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state === 'granted';
  } catch {
    return false;
  }
}
