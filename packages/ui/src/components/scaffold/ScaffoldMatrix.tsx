// b-68 t-13: the (tool × phase) nudge matrix — ac-2.
//
// Pivot view: rows are tools, columns are phases. Each cell shows the composed
// nudge text for that (tool, phase). Computed by `toNudge`, the same projection
// the agent calls at runtime.

import { useMemo } from 'react';
import { toNudge, type GuidanceBlock, type Phase, type ScaffoldDataset } from '@memex/shared';

const ALL_PHASES: readonly Phase[] = ['draft', 'specify', 'build', 'verify', 'done'] as const;

interface Props {
  dataset: ScaffoldDataset;
  orgBlocks: readonly GuidanceBlock[];
}

export function ScaffoldMatrix({ dataset, orgBlocks }: Props) {
  const cells = useMemo(() => {
    const out: Record<string, Record<Phase, string>> = {};
    for (const tool of dataset.tools) {
      out[tool.name] = {} as Record<Phase, string>;
      for (const phase of ALL_PHASES) {
        out[tool.name][phase] = toNudge({ dataset, tool: tool.name, phase, orgBlocks });
      }
    }
    return out;
  }, [dataset, orgBlocks]);

  return (
    <div data-testid="scaffold-matrix" className="overflow-x-auto">
      <table className="min-w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left p-2 border-b border-default sticky left-0 bg-bg">
              Tool
            </th>
            {ALL_PHASES.map((p) => (
              <th key={p} className="text-left p-2 border-b border-default">
                <code>{p}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataset.tools.map((tool) => (
            <tr key={tool.name} className="align-top">
              <td className="p-2 border-b border-default sticky left-0 bg-bg font-mono font-semibold">
                {tool.name}
              </td>
              {ALL_PHASES.map((phase) => {
                const text = cells[tool.name][phase];
                return (
                  <td
                    key={phase}
                    data-testid={`scaffold-matrix-cell-${tool.name}-${phase}`}
                    className="p-2 border-b border-default max-w-xs"
                  >
                    <pre className="whitespace-pre-wrap text-xs leading-snug">
                      {text || '(empty)'}
                    </pre>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
