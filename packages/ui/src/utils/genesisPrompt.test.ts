import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  buildClaudeCodePrompt,
  buildCursorPrompt,
  buildCopilotPrompt,
  MEMEX_USAGE_GUIDANCE,
} from './genesisPrompt';
import { deriveMcpUrl } from './mcpUrl';

const AC_ENV_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';
const AC_CLAUDE_CODE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-19';
const AC_CURSOR = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-20';
// spec-430 ac-9: the Claude Code prompt drives the unified install (npx install + the
// hooks-only checkout plugin) — Claude-Code-only; Cursor stays MCP-only (no plugin).
const AC_9_430 = 'mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9';
// spec-452: Copilot is the third coder, and genesisPrompt.ts is the single source for
// all three prompt strings.
const S452 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-452/acs/ac-${n}`;

const PROD_MCP_URL = deriveMcpUrl('https://memex.ai/api'); // https://memex.ai/mcp

describe('spec-201 ac-19 / spec-430 ac-9: Claude Code Genesis prompt = unified install + checkout plugin', () => {
  it('drives the unified `npx memex-ai install` (not `claude mcp add`) and the checkout plugin (spec-430)', () => {
    tagAc(AC_CLAUDE_CODE);
    tagAc(AC_9_430);
    const prompt = buildClaudeCodePrompt(PROD_MCP_URL);
    expect(prompt).toContain('npx -y memex-ai install');
    expect(prompt).toContain('claude plugin marketplace add mindset-ai/memex-ai');
    expect(prompt).toContain('claude plugin install memex-checkout@memex');
    expect(prompt).toMatch(/reload the window/i);
    // superseded (dec-2): the old OAuth `claude mcp add` path is gone from this prompt
    expect(prompt).not.toContain('claude mcp add');
  });

  it('instructs the agent to write the Memex-use clause into CLAUDE.md', () => {
    tagAc(AC_CLAUDE_CODE);
    const prompt = buildClaudeCodePrompt(PROD_MCP_URL);
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain(MEMEX_USAGE_GUIDANCE);
  });

  it('omits --api-base for prod but adds it for a non-prod env', () => {
    tagAc(AC_9_430);
    expect(buildClaudeCodePrompt(PROD_MCP_URL)).toContain('npx -y memex-ai install\n');
    const intUrl = deriveMcpUrl('https://int.memex.ai/api');
    expect(buildClaudeCodePrompt(intUrl)).toContain(
      'npx -y memex-ai install --api-base https://int.memex.ai',
    );
  });
});

describe('spec-201 ac-20: Cursor Genesis prompt', () => {
  it('instructs the agent to add the server to Cursor MCP config with the given URL', () => {
    tagAc(AC_CURSOR);
    const prompt = buildCursorPrompt(PROD_MCP_URL);
    expect(prompt).toContain('.cursor/mcp.json');
    expect(prompt).toContain(`"url": "${PROD_MCP_URL}"`);
  });

  it('instructs the agent to add a .cursor/rules/*.mdc Memex-use rule', () => {
    tagAc(AC_CURSOR);
    const prompt = buildCursorPrompt(PROD_MCP_URL);
    expect(prompt).toContain('.cursor/rules/memex.mdc');
    expect(prompt).toContain(MEMEX_USAGE_GUIDANCE);
  });
});

describe('spec-201 ac-18: prompts embed the derived MCP URL (per environment)', () => {
  it('uses the int host when given the int API URL (Claude Code: apiBase; Cursor: mcp URL)', () => {
    tagAc(AC_ENV_DERIVED);
    const intUrl = deriveMcpUrl('https://int.memex.ai/api'); // https://int.memex.ai/mcp
    // Claude Code drives `npx memex-ai install --api-base https://int.memex.ai` (no /mcp).
    expect(buildClaudeCodePrompt(intUrl)).toContain('https://int.memex.ai');
    expect(buildClaudeCodePrompt(intUrl)).not.toContain('https://int.memex.ai/mcp');
    // Cursor still embeds the MCP URL directly.
    expect(buildCursorPrompt(intUrl)).toContain('https://int.memex.ai/mcp');
  });
});

describe('spec-452: Copilot (VS Code agent mode) Genesis prompt', () => {
  it('ac-13: registers the server in .vscode/mcp.json (servers / type:http / url)', () => {
    tagAc(S452(13));
    const p = buildCopilotPrompt(PROD_MCP_URL);
    expect(p).toContain('.vscode/mcp.json');
    expect(p).toContain('"servers"');
    expect(p).toContain('"type": "http"');
    expect(p).toContain(`"url": "${PROD_MCP_URL}"`);
  });

  it('ac-13: embeds the environment-derived MCP URL', () => {
    tagAc(S452(13));
    const intUrl = deriveMcpUrl('https://int.memex.ai/api');
    expect(buildCopilotPrompt(intUrl)).toContain('https://int.memex.ai/mcp');
  });

  it('ac-11: writes the clause into .github/copilot-instructions.md (not the path-scoped .instructions.md form)', () => {
    tagAc(S452(11));
    const p = buildCopilotPrompt(PROD_MCP_URL);
    expect(p).toContain('.github/copilot-instructions.md');
    expect(p).not.toContain('.instructions.md');
  });

  it('ac-12: reuses the shared MEMEX_USAGE_GUIDANCE clause verbatim', () => {
    tagAc(S452(12));
    expect(buildCopilotPrompt(PROD_MCP_URL)).toContain(MEMEX_USAGE_GUIDANCE);
  });

  it('ac-14: MCP-only over OAuth — no checkout plugin, no cloud-agent / PAT / repo-settings flow', () => {
    tagAc(S452(14));
    const p = buildCopilotPrompt(PROD_MCP_URL);
    expect(p).not.toContain('claude plugin');
    expect(p).not.toContain('memex-checkout');
    expect(p).not.toContain('npx -y memex-ai install');
    expect(p).not.toMatch(/personal access token|\bPAT\b|repository settings|repo settings/i);
  });
});

describe('spec-452: genesisPrompt.ts is the single source for all three coder prompts', () => {
  it('ac-15: exports all three builders, each embedding the passed MCP URL', () => {
    tagAc(S452(15));
    const intUrl = deriveMcpUrl('https://int.memex.ai/api');
    expect(buildClaudeCodePrompt(intUrl)).toContain('https://int.memex.ai');
    expect(buildCursorPrompt(intUrl)).toContain('https://int.memex.ai/mcp');
    expect(buildCopilotPrompt(intUrl)).toContain('https://int.memex.ai/mcp');
  });

  it('ac-16: only the Claude Code prompt carries the checkout plugin', () => {
    tagAc(S452(16));
    expect(buildClaudeCodePrompt(PROD_MCP_URL)).toContain('claude plugin');
    expect(buildCursorPrompt(PROD_MCP_URL)).not.toContain('claude plugin');
    expect(buildCopilotPrompt(PROD_MCP_URL)).not.toContain('claude plugin');
  });

  it('ac-17: every coding-agent prompt both registers MCP and writes the clause to its memory file', () => {
    tagAc(S452(17));
    const cc = buildClaudeCodePrompt(PROD_MCP_URL);
    expect(cc).toContain('npx -y memex-ai install');
    expect(cc).toContain('CLAUDE.md');
    expect(cc).toContain(MEMEX_USAGE_GUIDANCE);

    const cur = buildCursorPrompt(PROD_MCP_URL);
    expect(cur).toContain('.cursor/mcp.json');
    expect(cur).toContain('.cursor/rules/memex.mdc');
    expect(cur).toContain(MEMEX_USAGE_GUIDANCE);

    const co = buildCopilotPrompt(PROD_MCP_URL);
    expect(co).toContain('.vscode/mcp.json');
    expect(co).toContain('.github/copilot-instructions.md');
    expect(co).toContain(MEMEX_USAGE_GUIDANCE);
  });
});
