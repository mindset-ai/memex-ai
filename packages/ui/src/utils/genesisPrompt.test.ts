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

const PROD_MCP_URL = deriveMcpUrl('https://memex.ai/api'); // https://memex.ai/mcp

describe('spec-201 ac-19: Claude Code Genesis prompt', () => {
  it('instructs the agent to register the MCP server via `claude mcp add` with the given URL', () => {
    tagAc(AC_CLAUDE_CODE);
    const prompt = buildClaudeCodePrompt(PROD_MCP_URL);
    expect(prompt).toContain('claude mcp add');
    expect(prompt).toContain(`memex ${PROD_MCP_URL}`);
  });

  it('instructs the agent to write the Memex-use clause into CLAUDE.md', () => {
    tagAc(AC_CLAUDE_CODE);
    const prompt = buildClaudeCodePrompt(PROD_MCP_URL);
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain(MEMEX_USAGE_GUIDANCE);
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
  it('uses the int URL when given the int API URL', () => {
    tagAc(AC_ENV_DERIVED);
    const intUrl = deriveMcpUrl('https://int.memex.ai/api'); // https://int.memex.ai/mcp
    expect(buildClaudeCodePrompt(intUrl)).toContain('https://int.memex.ai/mcp');
    expect(buildCursorPrompt(intUrl)).toContain('https://int.memex.ai/mcp');
  });
});
