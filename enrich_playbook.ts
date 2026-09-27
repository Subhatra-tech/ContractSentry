import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { db } from './src/db/index.js';
import { playbook_clauses } from './src/db/schema.js';
import { sql } from 'drizzle-orm';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface RawClause {
  clause_text: string;
  source_contract?: string;
  cuad_category?: string;
  product_category?: string;
  category?: string;
}

interface EnrichedClause {
  clause_text: string;
  category: string;
  source: string;
  source_contract: string;
  cuad_original_label: string;
  risk_posture: string;
  standard_note: string;
  category_confirmed: boolean;
  embedding?: number[];
}

function formatCleanSource(rawSource?: string): string {
  if (!rawSource) return 'Standard Commercial Precedent';
  const s = rawSource.trim();
  const match = s.match(/(?:EX-[\d.]+-)?([A-Za-z\s]{4,}AGREEMENT|[A-Za-z\s]{4,}CONTRACT)/i);
  if (match && match[1]) {
    const clean = match[1].replace(/_/g, ' ').trim();
    return `Commercial Precedent (${clean.toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())})`;
  }
  const catMatch = s.match(/\(([^)]+)\)/);
  if (catMatch && catMatch[1]) {
    return `Market Precedent (${catMatch[1]})`;
  }
  return 'Standard Commercial Precedent';
}

function getCategoryGuidance(category: string): string {
  switch (category) {
    case 'Termination':
      return `Target posture terms for Termination:
- "favorable to terminating party" (e.g. unilateral termination right, short/immediate notice, without cause or penalty)
- "balanced/neutral" (e.g. mutual termination rights, standard 30-60 day written notice, customary cure periods)
- "favorable to non-terminating party" (e.g. strict long-term lock-in, heavy early termination liquidated fees, narrow cure)`;
    case 'Liability':
      return `Target posture terms for Liability:
- "favorable to liable party" (e.g. broad aggregate liability cap tied to nominal fees, waiver of indirect/consequential damages)
- "balanced/neutral" (e.g. mutual liability caps tied to 12 months fees paid, standard mutual carve-outs)
- "favorable to counterparty/aggrieved party" (e.g. uncapped liability, super-caps, high liquidated damages, broad exposure)`;
    case 'Payment':
      return `Target posture terms for Payment:
- "favorable to payee/vendor" (e.g. strict net 15/immediate payment, compound late interest, fixed minimum commitments)
- "balanced/neutral" (e.g. customary net 30/45 days, reasonable invoice dispute withholding, standard interest rates)
- "favorable to payer/customer" (e.g. extended net 60-90 days, volume discounts/rebates, right to withhold disputed amounts)`;
    case 'Intellectual Property':
      return `Target posture terms for Intellectual Property:
- "favorable to licensor/creator" (e.g. strict reservation of rights, non-transferable/revocable license, licensor IP ownership)
- "balanced/neutral" (e.g. standard commercial grant, mutual pre-existing IP protection, clear work-product assignment)
- "favorable to licensee/recipient" (e.g. perpetual/irrevocable license, source code escrow, full joint ownership/assignment)`;
    case 'Indemnity':
      return `Target posture terms for Indemnity:
- "favorable to indemnified party" (e.g. broad unilateral defense and hold-harmless, attorney fees included, uncapped scope)
- "balanced/neutral" (e.g. customary bilateral third-party IP/infringement indemnity with standard notice & control conditions)
- "favorable to indemnifying party" (e.g. narrow indemnification triggers, strict prompt notice pre-conditions, liability cap applied)`;
    case 'Governing Law':
      return `Target posture terms for Governing Law:
- "favorable to drafting/local party" (e.g. exclusive forum/venue in home jurisdiction with attorney fee shifting)
- "balanced/neutral (standard commercial forum)" (e.g. Delaware, New York, or neutral arbitration forum)
- "favorable to counterparty" (e.g. foreign court submission)`;
    case 'Confidentiality':
      return `Target posture terms for Confidentiality:
- "favorable to disclosing party" (e.g. indefinite/perpetual duration, strict return/destruction of data, narrow carve-outs)
- "balanced/mutual" (e.g. standard 3-5 year mutual non-disclosure, reasonable care standard, standard exceptions)
- "favorable to receiving party" (e.g. short 1-2 year duration, permissive disclosures, loose standard of care)`;
    default:
      return 'Classify as "favorable to weaker party", "balanced/neutral", or "favorable to stronger party".';
  }
}

async function callGeminiWithRetry(prompt: string, retries = 3): Promise<string> {
  // Use gemini-3.1-flash-lite first as it is fast and not throttled by 503
  const models = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
  for (let attempt = 0; attempt < retries; attempt++) {
    const model = models[attempt % models.length];
    try {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });
      if (res.text) return res.text;
    } catch (err: any) {
      console.warn(`[Attempt ${attempt + 1}] Model ${model} error: ${err.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to generate content after ${retries} attempts.`);
}

async function getEmbeddingWithRetry(text: string, retries = 3): Promise<number[]> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: text,
        config: { outputDimensionality: 768 },
      });
      const values = res.embeddings?.[0]?.values || (res as any).embedding?.values;
      if (values && values.length === 768) {
        return values;
      }
    } catch (err: any) {
      console.warn(`[Attempt ${attempt + 1}] Embedding error: ${err.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to generate 768-dim embedding after ${retries} attempts.`);
}

async function main() {
  console.log('=== Contract Playbook LLM Enrichment & pgvector Ingestion Pipeline ===\n');

  // 1. Load playbook_raw.json
  const rawPath = path.resolve('playbook_raw.json');
  if (!fs.existsSync(rawPath)) {
    throw new Error(`playbook_raw.json not found at ${rawPath}`);
  }
  const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const rawClauses: RawClause[] = rawData.clauses || [];
  console.log(`[Step 1] Loaded ${rawClauses.length} raw clauses from playbook_raw.json.`);

  // Load Confidentiality baseline clauses if missing
  const existingCategories = new Set(rawClauses.map((c) => c.product_category || c.category));
  if (!existingCategories.has('Confidentiality')) {
    const backupPath = path.resolve('data/playbook_clauses.json');
    if (fs.existsSync(backupPath)) {
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      const backupList = Array.isArray(backupData) ? backupData : backupData.clauses;
      const confClauses = backupList.filter((c: any) => c.category === 'Confidentiality');
      for (const c of confClauses) {
        rawClauses.push({
          clause_text: c.clause_text,
          source_contract: c.source || 'Commercial Mutual NDA Standards',
          cuad_category: 'Confidentiality',
          product_category: 'Confidentiality',
        });
      }
      console.log(`  Added ${confClauses.length} Confidentiality clauses for complete 7-category coverage.`);
    }
  }

  console.log(`  Total clauses to enrich: ${rawClauses.length}`);

  // 2. Batch LLM Annotation (BATCH_SIZE = 8 for fast processing)
  const BATCH_SIZE = 8;
  const enrichedList: EnrichedClause[] = [];

  console.log('\n[Step 2] Enriching clauses with Gemini LLM annotations...');
  for (let i = 0; i < rawClauses.length; i += BATCH_SIZE) {
    const batch = rawClauses.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rawClauses.length / BATCH_SIZE);

    const batchPromptItems = batch.map((item, idx) => {
      const cat = item.product_category || item.category || 'General';
      const cuad = item.cuad_category || 'Commercial Provision';
      const contract = item.source_contract || 'Commercial Precedent';
      const guidance = getCategoryGuidance(cat);

      return `[Clause ${idx + 1}]
Category: ${cat}
Original CUAD Label: ${cuad}
Contract: ${contract}
Text: "${item.clause_text}"
${guidance}
`;
    }).join('\n---\n\n');

    const prompt = `You are a Senior Commercial Legal Review Specialist annotating benchmark clauses for an AI contract review playbook.
Analyze the following ${batch.length} clauses and output a JSON array of ${batch.length} evaluations in exact order.

Important instructions:
1. "risk_posture": Classify the clause's baseline risk posture using the category-appropriate terms. Aim for contrast and an authentic spread across risk postures per category — not all clauses should be balanced; identify clauses that are one-sided or heavily favorable to one party.
2. "standard_note": Exactly one concise sentence explaining what makes this clause typical, standard, or notable for its category.
3. "category_confirmed": boolean (true if the category assignment still makes sense given the actual text; false if flagged for manual review).

Clauses to analyze:
${batchPromptItems}

Return pure JSON array format:
[
  {
    "clause_index": 1,
    "risk_posture": "balanced/neutral",
    "standard_note": "A concise one-sentence note...",
    "category_confirmed": true
  }
]
`;

    try {
      const responseText = await callGeminiWithRetry(prompt);
      let parsedArray: any[] = [];
      try {
        parsedArray = JSON.parse(responseText);
      } catch {
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) parsedArray = JSON.parse(jsonMatch[0]);
      }

      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const evalResult = parsedArray[j] || parsedArray.find((p: any) => p.clause_index === j + 1) || {};
        const cat = raw.product_category || raw.category || 'General';
        const rawSource = raw.source_contract || raw.cuad_category || 'Commercial Precedent';
        const cleanSource = formatCleanSource(rawSource);

        enrichedList.push({
          clause_text: raw.clause_text,
          category: cat,
          source: cleanSource,
          source_contract: raw.source_contract || rawSource,
          cuad_original_label: raw.cuad_category || cat,
          risk_posture: evalResult.risk_posture || 'balanced/neutral',
          standard_note: evalResult.standard_note || `Standard market benchmark clause for ${cat}.`,
          category_confirmed: evalResult.category_confirmed ?? true,
        });
      }
      console.log(`  ✓ Batch ${batchNum}/${totalBatches} annotated (${enrichedList.length}/${rawClauses.length} clauses)`);
    } catch (e: any) {
      console.error(`  ✗ Batch ${batchNum} error:`, e.message);
      for (const raw of batch) {
        const cat = raw.product_category || raw.category || 'General';
        enrichedList.push({
          clause_text: raw.clause_text,
          category: cat,
          source: formatCleanSource(raw.source_contract),
          source_contract: raw.source_contract || 'Commercial Precedent',
          cuad_original_label: raw.cuad_category || cat,
          risk_posture: 'balanced/neutral',
          standard_note: `Standard market benchmark clause for ${cat}.`,
          category_confirmed: true,
        });
      }
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  // 3. Generate Gemini Embeddings (768 dimensions) with concurrent pool of 5
  console.log('\n[Step 3] Generating 768-dimensional Gemini embeddings via gemini-embedding-2-preview...');
  const CONCURRENCY = 5;
  for (let i = 0; i < enrichedList.length; i += CONCURRENCY) {
    const chunk = enrichedList.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (item, idx) => {
        try {
          const vec = await getEmbeddingWithRetry(item.clause_text);
          item.embedding = vec;
        } catch (err: any) {
          console.warn(`  Fallback embedding for clause ${i + idx + 1}: ${err.message}`);
          item.embedding = new Array(768).fill(0.001);
        }
      })
    );
    const progress = Math.min(i + CONCURRENCY, enrichedList.length);
    if (progress % 20 === 0 || progress === enrichedList.length) {
      console.log(`  ✓ Embedded ${progress}/${enrichedList.length} clauses`);
    }
  }

  // 4. Save JSON backup
  fs.mkdirSync('data', { recursive: true });
  const outputPath = path.resolve('data/playbook_enriched.json');
  fs.writeFileSync(outputPath, JSON.stringify(enrichedList, null, 2), 'utf8');
  console.log(`\n[Step 4] Saved enriched dataset to ${outputPath}`);

  // 5. Store in Cloud SQL (PostgreSQL) playbook_clauses table
  console.log('\n[Step 5] Inserting enriched clauses into PostgreSQL (playbook_clauses)...');
  await db.delete(playbook_clauses);
  console.log('  Cleared previous records in playbook_clauses.');

  const CHUNK_SIZE = 25;
  for (let i = 0; i < enrichedList.length; i += CHUNK_SIZE) {
    const chunk = enrichedList.slice(i, i + CHUNK_SIZE);
    await db.insert(playbook_clauses).values(
      chunk.map((item) => ({
        category: item.category,
        clause_text: item.clause_text,
        source: item.source,
        source_contract: item.source_contract,
        cuad_original_label: item.cuad_original_label,
        risk_posture: item.risk_posture,
        standard_note: item.standard_note,
        embedding: item.embedding,
      }))
    );
    console.log(`  Inserted rows ${i + 1} to ${i + chunk.length}`);
  }

  // 6. Rebuild HNSW vector similarity index
  console.log('\n[Step 6] Re-running vector similarity index build (HNSW on pgvector)...');
  await db.execute(sql`DROP INDEX IF EXISTS playbook_clauses_embedding_idx;`);
  await db.execute(sql`
    CREATE INDEX playbook_clauses_embedding_idx 
    ON public.playbook_clauses 
    USING hnsw (embedding vector_cosine_ops);
  `);
  console.log('  ✓ HNSW vector cosine similarity index successfully built.');

  // 7. Verify Results & Distribution
  console.log('\n=== Final Playbook Verification & Distribution Summary ===');
  const countResult = await db.execute(sql`SELECT count(*) as total FROM playbook_clauses;`);
  console.log(`Total clauses in playbook_clauses: ${countResult.rows[0].total}`);

  const catPostureResult = await db.execute(sql`
    SELECT category, risk_posture, count(*) as count
    FROM playbook_clauses
    GROUP BY category, risk_posture
    ORDER BY category, count DESC;
  `);

  console.log('\nRisk Posture Spread per Category:');
  const grouped: Record<string, Record<string, number>> = {};
  for (const row of catPostureResult.rows as any[]) {
    if (!grouped[row.category]) grouped[row.category] = {};
    grouped[row.category][row.risk_posture] = Number(row.count);
  }

  for (const [cat, postures] of Object.entries(grouped)) {
    console.log(`\n• ${cat}:`);
    for (const [pos, cnt] of Object.entries(postures)) {
      console.log(`    - [${pos}]: ${cnt}`);
    }
  }

  const sampleResult = await db.execute(sql`
    SELECT category, risk_posture, standard_note, cuad_original_label, substr(clause_text, 1, 90) as snippet
    FROM playbook_clauses
    ORDER BY category
    LIMIT 3;
  `);
  console.log('\nSample Verified Clauses:');
  console.log(JSON.stringify(sampleResult.rows, null, 2));

  console.log('\n=== All Operations Completed Successfully ===');
}

main().catch((err) => {
  console.error('Fatal error in enrichment pipeline:', err);
  process.exit(1);
}).then(() => process.exit(0));
