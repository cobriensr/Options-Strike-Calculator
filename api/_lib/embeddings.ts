/**
 * OpenAI embeddings helper for the lessons-learned system.
 *
 * Provides:
 *   generateEmbedding()   — convert text to a 1536-d vector via text-embedding-3-small
 *   findSimilarLessons()  — cosine-similarity search over the lessons table
 *
 * Install: npm install openai
 */

import OpenAI from 'openai';
import { getDb } from './db.js';

// ============================================================
// OPENAI CLIENT (lazy singleton, same pattern as db.ts)
// ============================================================

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/** Reset the cached OpenAI client. Exported for tests only. */
export function _resetClient() {
  _client = null;
}

// ============================================================
// GENERATE EMBEDDING
// ============================================================

/**
 * Generate a 1536-dimension embedding vector for the given text
 * using OpenAI's text-embedding-3-small model.
 *
 * Returns null on any error (API timeout, network failure, missing key).
 */
export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  try {
    const response = await getClient().embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// FIND SIMILAR LESSONS
// ============================================================

export interface SimilarLesson {
  id: number;
  text: string;
  tags: string[];
  category: string | null;
  sourceDate: string;
}

/**
 * Query the lessons table for the N most similar active lessons
 * by cosine distance (using the HNSW index on the embedding column).
 */
export async function findSimilarLessons(
  embedding: number[],
  limit: number = 5,
): Promise<SimilarLesson[]> {
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await sql`
    SELECT id, text, tags, category, source_date
    FROM lessons
    WHERE status = 'active'
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id as number,
    text: row.text as string,
    tags: row.tags as string[],
    category: (row.category as string) ?? null,
    sourceDate: row.source_date as string,
  }));
}
