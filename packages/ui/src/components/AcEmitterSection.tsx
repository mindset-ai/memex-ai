// spec-201 dec-2: the "Install the AC emitter" section on the Integrations page.
// Sibling of CliInstallSection. Static copy (no guided checklist): pick an
// adapter from the manifest-driven matrix → copy its install command → mint a
// MEMEX_EMIT_KEY (deep link to the per-Memex Emission Keys panel) → tag a test.
//
// The adapter matrix is rendered from the @memex/shared acEmitterManifest
// (dec-3), so it can't drift from the shipped adapters.

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  acEmitterManifest,
  type AcEmitterEntry,
  type AcEmitterStatus,
} from '@memex/shared';
import { CodeBlock, InlineCode } from './CodeBlock';
import { Badge } from './ui/Badge';
import { resolveNavTo } from '../utils/tenantUrl';
import { useAuth } from './AuthContext';

// Map the adapter availability onto the shared lifecycle palette (statusStyles
// via Badge): available → success/green, coming-soon → info/blue, planned →
// neutral. Reusing Badge keeps the look consistent and stays clear of the
// spec-167 single-consumer accent-foreground token.
const STATUS_TO_DOMAIN: Record<AcEmitterStatus, string> = {
  available: 'done',
  'coming-soon': 'build',
  planned: 'draft',
};
const STATUS_LABEL: Record<AcEmitterStatus, string> = {
  available: 'Available',
  'coming-soon': 'Coming soon',
  planned: 'Planned',
};

const TAG_EXAMPLE = `import { tagAc } from '@memex-ai-ac/vitest';

it('keeps the cache warm', () => {
  tagAc('your-namespace/your-memex/specs/spec-1/acs/ac-1');
  expect(cache.isWarm()).toBe(true);
});`;

function defaultAdapter(): AcEmitterEntry {
  return acEmitterManifest.find((a) => a.status === 'available') ?? acEmitterManifest[0];
}

export function AcEmitterSection() {
  const location = useLocation();
  const { session } = useAuth();
  const [selected, setSelected] = useState<AcEmitterEntry>(defaultAdapter);

  const keysHref = resolveNavTo('/keys', location.pathname, session?.memberships);
  const emitKeyCmd = `MEMEX_EMIT_KEY=mxk_your_key_here npm test`;

  return (
    <section id="install-ac-emitter" aria-labelledby="install-ac-emitter-heading">
      <h2 id="install-ac-emitter-heading" className="text-xl font-semibold mb-2 text-heading">
        Install the AC emitter
      </h2>
      <p className="mb-6 text-secondary">
        Tag your tests with an acceptance-criterion ref and Memex turns the AC green when
        the test passes. Pick your adapter, install it, set your emission key, and tag a
        test.
      </p>

      {/* Adapter matrix — one row per manifest entry (ac-13). */}
      <div className="mb-8 border rounded-lg divide-y border-edge divide-edge" role="table" aria-label="AC emitter adapters">
        {acEmitterManifest.map((adapter) => {
          const isSelected = adapter.package === selected.package;
          const isAvailable = adapter.status === 'available';
          return (
            <button
              key={adapter.package}
              role="row"
              aria-selected={isSelected}
              disabled={!isAvailable}
              onClick={() => isAvailable && setSelected(adapter)}
              className={
                'w-full text-left px-4 py-3 flex items-center justify-between gap-4 transition-colors ' +
                (isSelected ? 'bg-overlay ' : '') +
                (isAvailable ? 'hover:bg-overlay cursor-pointer' : 'opacity-60 cursor-not-allowed')
              }
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium text-primary">
                  {adapter.framework}{' '}
                  <span className="text-secondary font-normal">· {adapter.language}</span>
                </span>
                <a
                  href={adapter.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs underline text-muted hover:text-primary"
                >
                  {adapter.package}
                </a>
              </span>
              <Badge
                status={STATUS_TO_DOMAIN[adapter.status]}
                label={STATUS_LABEL[adapter.status]}
              />
            </button>
          );
        })}
      </div>

      {/* 1. Install (ac-9) */}
      <div className="mb-8">
        <h3 className="text-base font-medium mb-3 text-heading">
          1. Install the {selected.framework} adapter
        </h3>
        <CodeBlock code={selected.installCommand} />
      </div>

      {/* 2. Emission key (ac-10, ac-11) */}
      <div className="mb-8">
        <h3 className="text-base font-medium mb-3 text-heading">2. Set your emission key</h3>
        <p className="text-sm mb-3 text-secondary">
          Mint a key in the{' '}
          <Link to={keysHref} className="underline hover:text-primary">
            Emission Keys
          </Link>{' '}
          panel, then expose it to your test runner as{' '}
          <InlineCode>MEMEX_EMIT_KEY</InlineCode> (or store it as a CI secret):
        </p>
        <CodeBlock code={emitKeyCmd} />
      </div>

      {/* 3. Tag a test (ac-11) */}
      <div>
        <h3 className="text-base font-medium mb-3 text-heading">3. Tag a test</h3>
        <p className="text-sm mb-3 text-secondary">
          Call <InlineCode>tagAc()</InlineCode> with the AC's full ref inside the test that
          proves it:
        </p>
        <CodeBlock code={TAG_EXAMPLE} />
      </div>
    </section>
  );
}
