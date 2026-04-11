/**
 * Lightweight pre-check for the /api/analyze endpoint.
 *
 * Sends a ~500-token request to Claude Sonnet to ask what additional
 * market data would improve the upcoming analysis. If Sonnet calls any
 * tools, those results are fetched and returned as a formatted string
 * ready to inject into the main streaming call as extra context.
 *
 * Falls back to null on any error — the main call is unaffected.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { getDb } from './db.js';
import { buildClaudeTools } from './claude-tools.js';
import { executeDbTool } from './db-claude-tools.js';
import logger from './logger.js';

// Maximum tool-use turns for the pre-check (fast path — not the full analysis)
const MAX_PRECHECK_TURNS = 3;

// Sonnet model string — faster and cheaper than Opus for tool selection
const PRECHECK_MODEL = 'claude-sonnet-4-6';

/**
 * Run a lightweight pre-check call with Claude Sonnet to fetch any
 * additional market data needed before the main analysis stream.
 *
 * @param anthropic - Anthropic SDK instance (injected for testability)
 * @param context - The raw analysis context object from the request
 * @param analysisDate - Trading date in YYYY-MM-DD format
 * @param asOf - ISO UTC ceiling timestamp (clamps DB queries to entryTime)
 * @returns Formatted extra-context string, or null if no tools were called
 */
export async function runAnalysisPreCheck(
  anthropic: Anthropic,
  context: Record<string, unknown>,
  analysisDate: string,
  asOf?: string,
): Promise<string | null> {
  try {
    const db = getDb();
    const tools = buildClaudeTools();

    const systemPrompt =
      "You are a data-retrieval assistant. Decide what additional SPX market " +
      "data would help the upcoming analysis. Use the provided tools to fetch " +
      "it, or respond with 'none' if existing context is sufficient.";

    const vixVal = context.vix ?? 'N/A';
    const vix1dVal = context.vix1d ?? 'N/A';
    const spxVal = context.spx ?? 'N/A';
    const modeVal = context.mode ?? 'entry';
    const timeVal = context.entryTime ?? 'live';
    const regimeVal = context.regimeZone ?? 'N/A';

    const userText =
      `Analysis request:\n` +
      `- Mode: ${modeVal}\n` +
      `- Date: ${analysisDate}\n` +
      `- Time: ${timeVal}\n` +
      `- VIX: ${vixVal} / VIX1D: ${vix1dVal}\n` +
      `- SPX: ${spxVal}\n` +
      `- GEX Regime: ${regimeVal}\n\n` +
      `What additional market data would most improve this analysis?`;

    const messages: MessageParam[] = [
      { role: 'user', content: userText },
    ];

    // Collect all tool result strings across all turns
    const toolResultTexts: string[] = [];

    for (let turn = 0; turn < MAX_PRECHECK_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: PRECHECK_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        tools,
        tool_choice: { type: 'auto' },
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        // Claude is done — no more tools to call
        break;
      }

      // Extract all tool_use blocks from this response turn
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0) {
        break;
      }

      // Execute all tool calls in parallel
      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map((block) =>
          executeDbTool(block, db, analysisDate, asOf),
        ),
      );

      // Collect non-error text results for final output
      for (const result of toolResults) {
        if (!result.is_error && typeof result.content === 'string') {
          toolResultTexts.push(result.content);
        }
      }

      // Append assistant message + tool results to continue the conversation
      messages.push({
        role: 'assistant',
        content: response.content,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    if (toolResultTexts.length === 0) {
      return null;
    }

    const header = '=== Additional Market Data (fetched on request) ===';
    return [header, ...toolResultTexts].join('\n');
  } catch (err) {
    logger.warn({ err }, 'analyze pre-check failed — continuing without it');
    return null;
  }
}
