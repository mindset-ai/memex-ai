import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  buildClaudeCodePrompt,
  buildCursorPrompt,
  MEMEX_USAGE_GUIDANCE,
} from './genesisPrompt';
import { deriveMcpUrl } from './mcpUrl';

const AC_ENV_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';
const AC_CLAUDE_CODE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-19';
const AC_CURSOR = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-20';
// spec-430 ac-9: the Claude Code prompt drives the unified install (npx install + the
// hooks-only checkout plugin) — Claude-Code-only; Cursor stays MCP-only (no plugin).
const AC_9_430 = 'mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9';

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
