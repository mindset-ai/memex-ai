// spec-566 t-7 — the board half of ac-29.
//
//   ac-29  "…a board drop that hits the gate opens the override affordance
//          instead of rolling the card back to its previous column. Rolling
//          back in silence is the exact experience that got spec-391's block
//          reverted, so a test that only asserts the transition was refused
//          leaves the reverted behaviour in place and passes."
//
// That last sentence is why this file exists at all. The server-side tests
// (services/done-gate.integration.test.ts) prove the transition is refused and
// carries `DONE_GATE_BLOCKED`. Every one of them would still pass if the board
// did nothing with the code — which is exactly the state spec-391 was reverted
// for. The claim here is the OTHER half: the board can tell a gate from a fault,
// and behaves differently.
//
// The discriminating case is the pair. A plain failure must STILL roll back
// quietly (that behaviour is correct and unchanged), and a gate refusal must
// roll back AND surface the override. A test that only exercised the gate would
// pass against a hook that opened the dialog for every error, which would turn
// every transient 500 into a spurious "override this?" prompt.

import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

import { useSpecBoard } from './useSpecBoard';
import { updateDocStatus } from '../api/client';
import { ApiError } from '../api/errors';
import type { DocSummary } from '../api/types';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-566';
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, updateDocStatus: vi.fn() };
});
vi.mock('./useTelemetry', () => ({ useTelemetry: () => ({ track: vi.fn() }) }));

const REFUSAL =
  'This Spec cannot close: 1 criterion holds a supersession proposal no one has accepted.';

function makeDoc(): DocSummary {
  return {
    id: 'doc-1',
    handle: 'spec-566',
    title: 'A criterion cannot be rewritten in silence',
    docType: 'spec',
    status: 'verify',
    parentDocId: null,
    createdAt: '2026-09-01T10:00:00Z',
    statusChangedAt: '2026-09-10T10:00:00Z',
    sectionCount: 4,
    archivedAt: null,
  } as unknown as DocSummary;
}

/** A DragEvent stand-in carrying the dragged doc id, as the real drop does. */
function dropEvent(docId: string) {
  return {
    preventDefault: () => {},
    dataTransfer: { getData: () => docId, setData: () => {}, effectAllowed: '', dropEffect: '' },
  } as unknown as React.DragEvent<HTMLElement>;
}

function setup() {
  let docs: DocSummary[] = [makeDoc()];
  const setDocs = vi.fn((next: unknown) => {
    docs = typeof next === 'function' ? (next as (p: DocSummary[]) => DocSummary[])(docs) : (next as DocSummary[]);
  });
  const hook = renderHook(() =>
    useSpecBoard({
      docs,
      setDocs: setDocs as never,
      canWrite: true,
      setDoneExpanded: vi.fn(),
    }),
  );
  return { hook, statusOf: () => docs[0]!.status };
}

/** Make `updateDocStatus` fail with `err`. The cast is because the real
 *  signature returns a Promise; this is a mock. */
function rejectWith(err: Error): void {
  vi.mocked(updateDocStatus).mockImplementation((async (): Promise<never> => {
    throw err;
  }) as never);
}

// Restore the stub after EVERY case [std-37], not just before the next one.
//
// This is load-bearing, and it cost an hour to find. A throwing implementation
// that outlives its test body gets called once more during teardown, and the
// throw surfaces as a phantom failure on THIS test — reported as the ApiError
// with no assertion attached, which reads like the hook swallowing nothing.
// The hook was correct throughout: probing it showed `handleDrop` returning
// cleanly with `gateBlocked` set, while the test still "failed". Three of the
// five cases here failed that way and the two that happened to run a second
// `act()` afterwards passed, which is exactly the kind of order-dependent
// noise a `beforeEach`-only reset leaves behind.
afterEach(() => {
  vi.mocked(updateDocStatus).mockReset();
});

beforeEach(() => vi.mocked(updateDocStatus).mockReset());

describe('spec-566 ac-29 — a refused drop opens the override, it does not just snap back', () => {
  it('surfaces the gate refusal, naming the Spec and the target column', async () => {
    tagAc(acRef(29));

    rejectWith(new ApiError(409, REFUSAL, 'DONE_GATE_BLOCKED'));
    const { hook, statusOf } = setup();

    // Precondition: nothing is pending before the drop, so the assertion below
    // cannot be satisfied by a stuck initial value.
    expect(hook.result.current.gateBlocked).toBeNull();

    await act(async () => {
      await hook.result.current.handleDrop(dropEvent('doc-1'), 'done');
    });

    await waitFor(() => expect(hook.result.current.gateBlocked).not.toBeNull());
    const blocked = hook.result.current.gateBlocked!;
    expect(blocked.docId).toBe('doc-1');
    expect(blocked.target).toBe('done');
    // The server's words reach the user — the refusal names the criterion and
    // the calls that clear it, and swallowing it would leave a bare "blocked".
    expect(blocked.message).toBe(REFUSAL);

    // The card is back where it was. Rolling back is CORRECT; doing only that
    // is the reverted behaviour.
    expect(statusOf()).toBe('verify');
  });

  it('a plain failure still rolls back QUIETLY — no spurious override prompt', async () => {
    tagAc(acRef(29));

    // The discriminating half. Without this, a hook that opened the dialog on
    // every error would pass the case above and turn every transient 500 into
    // an "override this?" prompt.
    rejectWith(new ApiError(500, 'boom'));
    const { hook, statusOf } = setup();

    await act(async () => {
      await hook.result.current.handleDrop(dropEvent('doc-1'), 'done');
    });

    expect(hook.result.current.gateBlocked).toBeNull();
    expect(statusOf()).toBe('verify');
  });

  it('a clean drop moves the card and raises nothing', async () => {
    tagAc(acRef(29));

    vi.mocked(updateDocStatus).mockResolvedValue(undefined);
    const { hook, statusOf } = setup();

    await act(async () => {
      await hook.result.current.handleDrop(dropEvent('doc-1'), 'done');
    });

    expect(hook.result.current.gateBlocked).toBeNull();
    expect(statusOf()).toBe('done');
  });

  it('completes the refused move once an override has been recorded', async () => {
    tagAc(acRef(29));

    rejectWith(new ApiError(409, REFUSAL, 'DONE_GATE_BLOCKED'));
    const { hook, statusOf } = setup();

    await act(async () => {
      await hook.result.current.handleDrop(dropEvent('doc-1'), 'done');
    });
    await waitFor(() => expect(hook.result.current.gateBlocked).not.toBeNull());

    // The override has landed server-side; the gate is now clear.
    vi.mocked(updateDocStatus).mockResolvedValue(undefined);
    await act(async () => {
      await hook.result.current.completeAfterOverride();
    });

    // The drop the user originally made completes — they do not have to drag
    // the card a second time. That is what makes the override a path FORWARD
    // rather than a dead end, which is spec-258 dec-5's guarantee.
    expect(statusOf()).toBe('done');
    expect(hook.result.current.gateBlocked).toBeNull();
  });

  it('dismissing without overriding leaves the card where it was', async () => {
    tagAc(acRef(29));

    rejectWith(new ApiError(409, REFUSAL, 'DONE_GATE_BLOCKED'));
    const { hook, statusOf } = setup();

    await act(async () => {
      await hook.result.current.handleDrop(dropEvent('doc-1'), 'done');
    });
    await waitFor(() => expect(hook.result.current.gateBlocked).not.toBeNull());

    act(() => hook.result.current.clearGateBlocked());

    expect(hook.result.current.gateBlocked).toBeNull();
    expect(statusOf()).toBe('verify');
  });
});
