// spec-502 (dec-1/3/4/6): the onboarding wizard shell.
//
// Composes the value-first sequence AFTER step 0 (the Explore companion's CTA lands
// here): name → console demo → connect the agent (the hard-gate spine) → land in a
// populated Memex. Each step fires its funnel event (std-35). The connect step
// REUSES the parked rail's MCP-connect logic (components/home/CreateSpecStep,
// dec-6 salvage) rather than duplicating it — copyable install, completion on
// observed MCP traffic (std-34/ac-9).
//
// The gate DEFERS, NOT LOSES (dec-1/ac-8): a user who can't install now takes an
// explicit "set this up later" branch that keeps their named Memex and lands them
// in it (resume path), rather than a dead end — and there is NO equal-footing
// "author in the browser instead" fork (ac-7).

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { useTelemetry } from '../hooks/useTelemetry';
import { tenantPathFor } from '../utils/tenantUrl';
import { CreateSpecStep } from '../components/home/CreateSpecStep';
import { NameStep } from './NameStep';
import { ConsoleDemo } from './ConsoleDemo';

type Step = 'name' | 'demo' | 'connect';

export function Wizard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { track } = useTelemetry(true);
  const [step, setStep] = useState<Step>('name');

  const personal = session?.memberships?.find((m) => m.kind === 'personal') ?? null;
  const defaultName = personal?.memexName ?? personal?.name ?? 'my-first-memex';

  // Land the user in their (own) personal Memex. After a real connect the agent
  // authors their first spec over MCP, so the board is populated — never empty
  // (dec-4/ac-4). Reuses the spec-482 landing path (?new=1 opens the creation
  // affordance on the board without a Kanban flash).
  function landInMemex(query = '') {
    if (!personal) {
      navigate('/');
      return;
    }
    const mx = personal.memexSlug ?? 'personal';
    navigate(tenantPathFor(personal.slug, mx, `/specs${query}`));
  }

  // Fire the funnel event for each step as it becomes active (std-35).
  const firedDemo = useRef(false);
  const firedConnect = useRef(false);
  useEffect(() => {
    if (step === 'demo' && !firedDemo.current) {
      firedDemo.current = true;
      track('wizard.demo_viewed');
    }
    if (step === 'connect' && !firedConnect.current) {
      firedConnect.current = true;
      track('wizard.reached_connect');
    }
  }, [step, track]);

  return (
    <div data-testid="onboarding-wizard" className="w-full flex flex-col items-center px-6 py-12">
      <div className="w-full max-w-3xl">
        {step === 'name' && (
          <NameStep
            defaultName={defaultName}
            onSubmit={(name) => {
              // No name text on the wire — a completion signal only (std-35).
              track('wizard.memex_named');
              // (Adopting/renaming the existing personal Memex is a follow-up seam —
              // see the QA report. The wizard targets that Memex, mints none.)
              void name;
              setStep('demo');
            }}
          />
        )}

        {step === 'demo' && <ConsoleDemo onDone={() => setStep('connect')} />}

        {step === 'connect' && (
          <div className="flex flex-col gap-6">
            {/* The hard gate — reused connect logic. onComplete latches on observed
                MCP traffic; then we land the user in their now-populated Memex. */}
            <CreateSpecStep onComplete={() => landInMemex('?new=1')} />

            {/* DEFER, NOT LOSE (ac-8): an explicit "later" branch that keeps the
                Memex and lands the user in it with a resume path — NOT a browser
                authoring alternative (ac-7). */}
            <div className="border-t border-edge pt-4">
              <button
                type="button"
                data-testid="wizard-defer-connect"
                onClick={() => {
                  track('wizard.reached_connect', { deferred: true });
                  landInMemex();
                }}
                className="text-sm font-medium text-secondary hover:text-primary underline"
              >
                I can't set this up right now — email me the steps
              </button>
              <p className="mt-1 text-xs text-muted">
                Your Memex is saved. We'll send you the setup steps so you can connect your agent
                when you're ready.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
