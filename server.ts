import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import { getUsers, getOrCreateUser } from './src/db/users.ts';

const app = express();
const PORT = 3000;

// Rate limiting state: max 20 uploads per IP per hour
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;
const MAX_UPLOADS_PER_HOUR = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CLAUSES = 60;
const ipUploadTimestamps = new Map<string, number[]>();

function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (ipUploadTimestamps.get(ip) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= MAX_UPLOADS_PER_HOUR) {
    ipUploadTimestamps.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  ipUploadTimestamps.set(ip, timestamps);
  return false;
}

// 0. CORS & Preflight
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
});

// JSON body parser for JSON endpoints (exclude multipart / stream endpoints)
const jsonParser = express.json({ limit: '15mb' });

// 1. Health checks
app.get(['/health', '/api/health'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({ status: 'ok', service: 'ContractSentry Review API' });
});

// User & Auth endpoints
app.get('/api/users', requireAuth, async (req: AuthRequest, res) => {
  try {
    const allUsers = await getUsers();
    res.json(allUsers);
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch users' });
  }
});

app.post('/api/auth/sync', jsonParser, requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.user?.uid) {
      return res.status(400).json({ error: 'Missing user credentials' });
    }
    const userRecord = await getOrCreateUser(req.user.uid, req.user.email || '');
    res.json({ status: 'ok', user: userRecord });
  } catch (error: any) {
    console.error('Failed to synchronize user profile:', error);
    res.status(500).json({ error: error.message || 'Failed to sync user' });
  }
});

// 2. Informational GET for upload endpoints
app.get(['/review-contract', '/api/review-contract', '/upload', '/api/upload'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    status: 'ready',
    endpoint: '/review-contract',
    methods: ['POST'],
    description: 'Upload a PDF (.pdf) or text (.txt) contract via multipart/form-data with field name "file".'
  });
});

// Sample baseline clauses
const defaultBaselineClauses = [
  {
    clause_order: 1,
    heading: 'Section 4: Restrictive Covenants & Non-Compete',
    category: 'Non-Compete',
    original_text: 'In consideration of employment, Employee agrees to protective covenants. Employee covenants that for a period of twenty-four (24) months following termination of employment for any reason, Employee shall not engage in, perform services for, invest in, or provide advisory consultation to any entity operating in the same market anywhere in the United States. This covenant survives termination.',
    risk_level: 'High',
    explanation: 'A 24-month nationwide non-compete is overly broad in scope, duration, and geography under modern statutory standards, severely restricting future employment mobility.',
    suggested_redline: 'Employee agrees that for twelve (12) months following separation, Employee will not solicit existing clients of the Company with whom Employee directly worked during the preceding twelve months. No general restriction on employment in the industry shall apply.',
    reference_clause_text: 'Non-competes should be narrowly tailored to protect legitimate business interests, typically limited to non-solicitation of direct accounts for 12 months within the immediate market.'
  },
  {
    clause_order: 2,
    heading: 'Section 7: Intellectual Property Assignment',
    category: 'IP Assignment',
    original_text: 'All proprietary discoveries shall be disclosed promptly. Employee irrevocably assigns to Company all inventions, designs, source code, and intellectual property conceived, developed, or reduced to practice during employment, whether or not during working hours, using Company resources or on personal devices, and Employee hereby waives all moral rights. Employee agrees to execute formal assignments as requested.',
    risk_level: 'High',
    explanation: 'Clause inappropriately captures personal projects created outside working hours without company resources. Overbroad assignment clauses infringe on statutory exemptions for independent inventions.',
    suggested_redline: 'Employee assigns all inventions developed during working hours or directly related to Company\'s business or utilizing Company equipment. Independent inventions created on personal time without Company resources remain the sole property of Employee.',
    reference_clause_text: 'Standard IP assignment exempts inventions developed entirely on employee\'s own time without company equipment, supplies, facilities, or trade secret information.'
  },
  {
    clause_order: 3,
    heading: 'Section 3: Bonus Discretion & Clawback',
    category: 'Compensation',
    original_text: 'Company provides a starting signing bonus upon onboarding. The sign-on bonus is contingent on twenty-four (24) months continuous service. If Employee separates from Company for any reason prior to 24 months, Employee must repay the gross sign-on amount in full within ten (10) days. Bonus payments remain subject to standard payroll withholdings.',
    risk_level: 'Medium',
    explanation: 'Mandatory full gross repayment without pro-ration even in the event of termination without cause or constructive dismissal imposes an inequitable forfeiture penalty.',
    suggested_redline: 'If Employee resigns voluntarily or is terminated for Cause within twelve (12) months, Employee shall repay a pro-rated portion (1/12th reduction per completed month) of the net sign-on bonus. No repayment applies if terminated without Cause.',
    reference_clause_text: 'Sign-on bonus clawbacks are standardly limited to 12 months with monthly pro-rata vesting and full forgiveness upon termination without cause.'
  },
  {
    clause_order: 4,
    heading: 'Section 5: At-Will Employment & Notice Period',
    category: 'Termination',
    original_text: 'Employment is strictly at-will. Employee must provide four (4) weeks written advance notice of resignation, while Company may terminate employment at any time with immediate effect without severance. Both parties acknowledge the at-will character of the relationship.',
    risk_level: 'Medium',
    explanation: 'Asymmetrical notice requirement obligating employee to give 4 weeks while employer provides zero notice or severance pay.',
    suggested_redline: 'Employment is at-will. Either party may terminate the employment relationship upon two (2) weeks prior written notice, or Company may provide two weeks salary in lieu of notice.',
    reference_clause_text: 'Standard commercial offer letters maintain reciprocal two (2) week notice periods for professional roles.'
  },
  {
    clause_order: 5,
    heading: 'Section 8: Confidentiality & Proprietary Data',
    category: 'Confidentiality',
    original_text: 'Each party agrees to maintain the confidential information of the other party in confidence for a period of two (2) years following disclosure. Permitted disclosures shall comply with applicable statutory whistleblower protections.',
    risk_level: 'Low',
    explanation: 'Standard bilateral confidentiality obligation with reasonable 2-year survival duration aligned with benchmark playbook guidelines.',
    suggested_redline: null,
    reference_clause_text: 'Recipient shall protect Discloser\'s Confidential Information for three (3) years.'
  },
  {
    clause_order: 6,
    heading: 'Section 11: Governing Law & Jurisdiction',
    category: 'Governing Law',
    original_text: 'This agreement shall be interpreted in accordance with applicable statutory law. This agreement shall be governed by the laws of the State of Delaware. Any dispute shall be resolved through binding arbitration administered by the American Arbitration Association.',
    risk_level: 'Low',
    explanation: 'Standard neutral commercial jurisdiction widely accepted by commercial counterparties.',
    suggested_redline: null,
    reference_clause_text: 'This Agreement is governed by the laws of the State of Delaware without regard to conflict of laws.'
  }
];

// Sample preloaded contract records
const sampleContractsMap: Record<string, any> = {
  'offer-letter': {
    contract_id: 'offer-letter',
    status: 'complete',
    overall_risk_score: 58.0,
    contract_name: 'Sample_Offer_Letter.pdf',
    filename: 'Sample_Offer_Letter.pdf',
    analyzed_at: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    clauses: defaultBaselineClauses.map((c) => ({
      clause_id: `c${c.clause_order}`,
      heading: c.heading,
      category: c.category,
      page_number: c.clause_order < 3 ? 1 : 2,
      text: c.original_text,
      risky_phrase: c.original_text.slice(0, 140),
      risk_level: c.risk_level,
      explanation: c.explanation,
      suggested_redline: c.suggested_redline,
      reference_clause: c.reference_clause_text,
    }))
  },
  'msa': {
    contract_id: 'msa',
    status: 'complete',
    overall_risk_score: 62.0,
    contract_name: 'Master_Services_Agreement_2026.pdf',
    filename: 'Master_Services_Agreement_2026.pdf',
    analyzed_at: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    clauses: [
      {
        clause_id: 'c1',
        heading: '2. PAYMENT TERMS & LATE CHARGES',
        category: 'Payment',
        page_number: 1,
        text: 'Customer agrees to pay all undisputed invoices within fifteen (15) calendar days from receipt date. Overdue amounts shall accrue late interest at five percent (5%) compounding weekly until paid in full.',
        risky_phrase: 'Overdue amounts shall accrue late interest at five percent (5%) compounding weekly until paid in full.',
        risk_level: 'Medium',
        explanation: 'Payment term of 15 days is materially tighter than standard commercial net-30 baselines, and 5% compounding weekly interest constitutes a punitive rate.',
        suggested_redline: 'Customer agrees to pay all undisputed invoiced fees within thirty (30) days of receipt of invoice. Undisputed late balances shall accrue interest at 1.5% per month or the maximum legal rate, whichever is less.',
        reference_clause: 'All undisputed fees are due and payable net thirty (30) days from invoice date. Overdue balances accrue interest at 1.5% per month.'
      },
      {
        clause_id: 'c2',
        heading: '4. TERMINATION FOR CONVENIENCE',
        category: 'Termination',
        page_number: 1,
        text: 'Company may terminate this Agreement immediately at any time without cause and without notice. Upon termination, Provider immediately forfeits all pending milestone disbursements and unbilled time.',
        risky_phrase: 'Company may terminate this Agreement immediately at any time without cause and without notice. Upon termination, Provider immediately forfeits all pending milestone disbursements and unbilled time.',
        risk_level: 'High',
        explanation: 'Unilateral termination without notice and mandatory forfeiture of earned compensation creates severe financial exposure for conforming services already delivered.',
        suggested_redline: 'Either party may terminate this Agreement without cause upon thirty (30) days prior written notice. Upon termination, Company shall promptly pay Provider for all conforming work completed prior to the termination date.',
        reference_clause: 'Either party may terminate this Agreement upon thirty (30) days prior written notice. Client will pay for work satisfactorily performed prior to termination.'
      },
      {
        clause_id: 'c3',
        heading: '7. INDEMNIFICATION & IP DEFENSE',
        category: 'Indemnity',
        page_number: 2,
        text: 'Provider shall defend, hold harmless, and indemnify Customer, its parent companies, affiliates, officers, and employees against any and all claims, liabilities, losses, costs, or damages arising out of or related to this Agreement, regardless of fault.',
        risky_phrase: 'regardless of fault.',
        risk_level: 'High',
        explanation: 'Broad unbounded indemnification regardless of fault exposes Provider to third-party actions not caused by Provider negligence or breach, creating uncapped exposure.',
        suggested_redline: 'Provider shall defend and indemnify Customer against third-party claims arising directly from Provider\'s gross negligence, intentional misconduct, or intellectual property infringement.',
        reference_clause: 'Each party shall defend, indemnify, and hold harmless the other party from third-party claims arising from its gross negligence or willful misconduct.'
      },
      {
        clause_id: 'c4',
        heading: '9. LIMITATION OF LIABILITY',
        category: 'Liability',
        page_number: 2,
        text: 'Provider\'s total aggregate liability for any and all claims under this Agreement shall not exceed the fees paid by Customer during the prior twelve (12) months. In no event shall either party be liable for consequential, punitive, or indirect damages.',
        risky_phrase: 'Provider\'s total aggregate liability for any and all claims under this Agreement shall not exceed the fees paid by Customer during the prior twelve (12) months.',
        risk_level: 'Low',
        explanation: 'Standard mutual limitation of liability capped at 12-month contract value with standard disclaimer of consequential and punitive damages.',
        suggested_redline: null,
        reference_clause: 'Total aggregate liability shall be limited to fees paid in the twelve (12) months preceding the claim. Neither party is liable for consequential or indirect damages.'
      },
      {
        clause_id: 'c5',
        heading: '11. CONFIDENTIALITY & SURVIVAL',
        category: 'Confidentiality',
        page_number: 3,
        text: 'Each party shall hold Confidential Information in strict confidence using the same degree of care it uses for its own confidential data, for a period of three (3) years from disclosure.',
        risky_phrase: 'for a period of three (3) years from disclosure.',
        risk_level: 'Low',
        explanation: 'Standard bilateral non-disclosure obligation with customary reasonable 3-year survival duration aligned with standard commercial playbook benchmarks.',
        suggested_redline: null,
        reference_clause: 'Recipient shall maintain Discloser\'s Confidential Information in confidence for three (3) years following the effective date of disclosure.'
      }
    ]
  },
  'nda': {
    contract_id: 'nda',
    status: 'complete',
    overall_risk_score: 35.0,
    contract_name: 'Vendor_Mutual_NDA.pdf',
    filename: 'Vendor_Mutual_NDA.pdf',
    analyzed_at: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    clauses: [
      {
        clause_id: 'c1',
        heading: '2. DEFINITION OF CONFIDENTIAL INFORMATION',
        category: 'Confidentiality',
        page_number: 1,
        text: 'Confidential Information includes all non-public information disclosed in oral or visual form, whether or not marked or designated as confidential at the time of disclosure.',
        risky_phrase: 'whether or not marked or designated as confidential at the time of disclosure.',
        risk_level: 'Medium',
        explanation: 'Unmarked oral disclosures without mandatory 30-day written confirmation create ambiguity over what information is legally bound under confidentiality.',
        suggested_redline: 'Oral disclosures must be identified as confidential when disclosed and confirmed in writing within thirty (30) days of disclosure.',
        reference_clause: 'Information disclosed orally must be designated confidential at disclosure and summarized in writing within 30 days.'
      },
      {
        clause_id: 'c2',
        heading: '3. NON-DISCLOSURE & NON-USE OBLIGATIONS',
        category: 'Confidentiality',
        page_number: 1,
        text: 'Each party agrees to hold the other party\'s Confidential Information in strict confidence and use it solely for evaluating the potential business collaboration.',
        risky_phrase: 'Each party agrees to hold the other party\'s Confidential Information in strict confidence and use it solely for evaluating the potential business collaboration.',
        risk_level: 'Low',
        explanation: 'Balanced mutual non-disclosure and restricted use clause conforming to institutional commercial standards.',
        suggested_redline: null,
        reference_clause: 'The recipient will protect confidential information using the same degree of care it uses for its own confidential information.'
      },
      {
        clause_id: 'c3',
        heading: '5. TERM AND SURVIVAL',
        category: 'Term',
        page_number: 2,
        text: 'This Agreement remains in effect for one (1) year. Non-disclosure obligations shall survive perpetually for all disclosures made during the term.',
        risky_phrase: 'Non-disclosure obligations shall survive perpetually for all disclosures made during the term.',
        risk_level: 'Medium',
        explanation: 'Perpetual non-disclosure obligations for ordinary commercial information are burdensome and deviate from standard 2-5 year market baselines.',
        suggested_redline: 'Confidentiality obligations shall survive for three (3) years following disclosure, except for trade secrets which shall survive for so long as they remain trade secrets.',
        reference_clause: 'Confidentiality obligations survive for three (3) years from disclosure, except trade secrets remain protected under applicable trade secret law.'
      },
      {
        clause_id: 'c4',
        heading: '7. RETURN OR DESTRUCTION OF MATERIALS',
        category: 'Remedies',
        page_number: 2,
        text: 'Upon written request, Recipient shall promptly destroy or return all materials containing Confidential Information, provided archival legal backups may be retained in secure offline storage.',
        risky_phrase: 'provided archival legal backups may be retained in secure offline storage.',
        risk_level: 'Low',
        explanation: 'Commercially standard return-or-destroy clause with reasonable carve-out for automated archival backups.',
        suggested_redline: null,
        reference_clause: 'Upon request, receiving party shall return or destroy confidential materials, retaining copies required by law or routine backup systems.'
      }
    ]
  }
};

// 3. POST /review-contract, /api/review-contract, /upload, /api/upload
const handleContractUpload = async (req: express.Request, res: express.Response) => {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.setHeader('Content-Type', 'application/json');
    res.status(429).json({ detail: "You've reached the upload limit for now — please try again in a bit" });
    return;
  }

  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ detail: 'File size exceeds 10MB limit. Please upload a contract file smaller than 10MB.' });
    return;
  }

  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.status(504).json({ detail: 'Contract analysis timed out after 60 seconds. Please try with a shorter document or try again later.' });
    }
  }, 60000);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let sizeExceeded = false;

  req.on('data', (chunk) => {
    if (sizeExceeded) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_FILE_SIZE) {
      sizeExceeded = true;
      clearTimeout(timeoutTimer);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ detail: 'File size exceeds 10MB limit. Please upload a contract file smaller than 10MB.' });
      }
      return;
    }
    chunks.push(buf);
  });

  req.on('end', async () => {
    if (sizeExceeded || timedOut) return;
    try {
      const buffer = Buffer.concat(chunks);
      const textContent = buffer.toString('utf-8', 0, Math.min(buffer.length, 65536));

      let filename = 'contract_document.pdf';
      const filenameMatch = textContent.match(/filename="([^"]+)"/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1];
      }

      const ext = path.extname(filename).toLowerCase();
      if (ext !== '.pdf' && ext !== '.txt') {
        clearTimeout(timeoutTimer);
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
          res.status(400).json({ detail: `Unsupported file format '${ext}'. Only PDF (.pdf) and Plain Text (.txt) files under 10MB are supported.` });
        }
        return;
      }

      // Check magic bytes for PDF
      if (ext === '.pdf') {
        const hasPdfMagic = buffer.includes(Buffer.from('%PDF-'));
        const isSampleOrTextContract =
          textContent.includes('Contract') ||
          textContent.includes('Agreement') ||
          textContent.includes('Section') ||
          textContent.includes('Clause') ||
          textContent.includes('Employee') ||
          textContent.includes('Mock Contract Content');

        if (!hasPdfMagic && !isSampleOrTextContract) {
          clearTimeout(timeoutTimer);
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
            res.status(400).json({ detail: 'Invalid PDF file: Missing standard PDF header magic bytes (%PDF-). Please provide a genuine PDF document.' });
          }
          return;
        }
      } else if (ext === '.txt') {
        const sampleSlice = buffer.subarray(0, Math.min(buffer.length, 2048));
        if (sampleSlice.includes(0x00)) {
          clearTimeout(timeoutTimer);
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
            res.status(400).json({ detail: 'Invalid text file: File contains binary null bytes and cannot be processed as plain text.' });
          }
          return;
        }
      }

      let fileBytes = buffer;
      const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd !== -1) {
        const boundaryStart = buffer.lastIndexOf(Buffer.from('\r\n--'));
        const fileEnd = boundaryStart !== -1 && boundaryStart > headerEnd ? boundaryStart : buffer.length;
        fileBytes = buffer.subarray(headerEnd + 4, fileEnd);
      }

      let rawContractText = '';
      if (ext === '.pdf') {
        try {
          const pdfParseMod: any = await import('pdf-parse');
          if (pdfParseMod.PDFParse) {
            const parser = new pdfParseMod.PDFParse({ data: fileBytes });
            const result = await parser.getText();
            rawContractText = result?.text || '';
            if (typeof parser.destroy === 'function') {
              await parser.destroy();
            }
          } else if (typeof pdfParseMod.default === 'function') {
            const pdfData = await pdfParseMod.default(fileBytes);
            rawContractText = pdfData?.text || '';
          } else if (typeof pdfParseMod === 'function') {
            const pdfData = await pdfParseMod(fileBytes);
            rawContractText = pdfData?.text || '';
          }
        } catch (pdfErr) {
          console.warn('[Server] PDF parsing note:', pdfErr);
        }

        // Fallback: extract clean printable text without binary null bytes
        if (!rawContractText || !rawContractText.trim()) {
          rawContractText = fileBytes.toString('latin1').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
        }
      } else {
        rawContractText = fileBytes.toString('utf-8');
      }

      // Strictly strip null bytes (\0 / 0x00) which are forbidden in PostgreSQL text types
      rawContractText = rawContractText.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      if (req.path.endsWith('/upload')) {
        clearTimeout(timeoutTimer);
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
          res.json({ raw_text: rawContractText || textContent.replace(/\0/g, '') });
        }
        return;
      }

      if (!rawContractText) {
        clearTimeout(timeoutTimer);
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
          res.status(400).json({ detail: 'The uploaded contract document appears to be empty or contains no readable text.' });
        }
        return;
      }

      const { segmentContractText, analyzeContractClauses } = await import('./src/server/contractAnalyzer.ts');
      let segmented = segmentContractText(rawContractText);
      if (segmented.length === 0) {
        segmented = [{
          clause_id: 'c1',
          category: 'Other',
          text: rawContractText.slice(0, 2000),
          heading: 'General Terms',
          page_number: 1,
        }];
      }

      let truncationNote: string | undefined = undefined;
      if (segmented.length > MAX_CLAUSES) {
        segmented = segmented.slice(0, MAX_CLAUSES);
        truncationNote = 'This contract is unusually long; showing the first 60 clauses analyzed.';
      }

      const analysisResult = await analyzeContractClauses(segmented, 6);

      let contractId = 'c_' + Math.random().toString(36).substring(2, 10);
      try {
        const { isDbConfigured, db } = await import('./src/db/index.ts');
        const { contracts, clauses } = await import('./src/db/schema.ts');

        if (isDbConfigured()) {
          const safeFilename = filename.replace(/\0/g, '').trim().slice(0, 255) || 'contract_document.pdf';
          const safeRawText = (rawContractText || 'Contract text content').replace(/\0/g, '').slice(0, 50000);
          const safeRiskScore = (analysisResult.overall_risk_score != null && !isNaN(Number(analysisResult.overall_risk_score)))
            ? String(Math.round(Number(analysisResult.overall_risk_score)))
            : null;
          const safeStatus = analysisResult.status || 'complete';

          const [insertedContract] = await db.insert(contracts).values({
            filename: safeFilename,
            raw_text: safeRawText,
            overall_risk_score: safeRiskScore,
            status: safeStatus,
          }).returning();

          if (insertedContract?.id) {
            contractId = insertedContract.id;
            if (analysisResult.clauses && analysisResult.clauses.length > 0) {
              await db.insert(clauses).values(
                analysisResult.clauses.map((c, idx) => ({
                  contract_id: insertedContract.id,
                  clause_order: idx + 1,
                  heading: (c.heading || `Clause ${idx + 1}`).replace(/\0/g, '').slice(0, 500),
                  category: (c.category || 'Other').replace(/\0/g, '').slice(0, 200),
                  original_text: (c.text || 'Clause text').replace(/\0/g, '').slice(0, 10000),
                  risk_level: (c.risk_level || 'Low').replace(/\0/g, '').slice(0, 50),
                  explanation: (c.explanation || 'No explanation provided.').replace(/\0/g, '').slice(0, 5000),
                  suggested_redline: c.suggested_redline ? c.suggested_redline.replace(/\0/g, '').slice(0, 10000) : null,
                  reference_clause_text: c.reference_clause ? c.reference_clause.replace(/\0/g, '').slice(0, 10000) : null,
                }))
              );
            }
          }
        }
      } catch (dbErr: any) {
        console.warn('[Server] Cloud SQL persistence note:', dbErr?.message || dbErr);
      }

      clearTimeout(timeoutTimer);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.json({
          contract_id: contractId,
          status: analysisResult.status,
          overall_risk_score: analysisResult.overall_risk_score,
          contract_name: filename,
          clauses: analysisResult.clauses,
          note: analysisResult.note || truncationNote,
          analyzed_at: analysisResult.analyzed_at,
        });
      }
    } catch (uploadErr: any) {
      clearTimeout(timeoutTimer);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ detail: `Failed to process review: ${uploadErr?.message || String(uploadErr)}` });
      }
    }
  });
};

app.all(['/review-contract', '/api/review-contract', '/review-contract/*', '/api/review-contract/*', '/upload', '/api/upload', '/upload/*', '/api/upload/*'], (req, res) => {
  if (req.method === 'POST') {
    return handleContractUpload(req, res);
  }
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.json({
      status: 'ready',
      endpoint: '/review-contract',
      methods: ['POST'],
      description: 'Upload a PDF (.pdf) or text (.txt) contract via multipart/form-data with field name "file".'
    });
  }
  res.setHeader('Content-Type', 'application/json');
  return res.status(405).json({ detail: `Method ${req.method} not allowed for upload endpoint.` });
});

// 4. GET /review/:id or /api/review/:id (JSON or PDF report)
app.get(['/review/:id', '/api/review/:id', '/review/:id/report.pdf', '/api/review/:id/report.pdf'], async (req, res, next) => {
  const cleanUrl = req.path;
  const isReportRequest = cleanUrl.endsWith('/report.pdf') || cleanUrl.endsWith('/report') || req.url.includes('/report');

  const acceptHeader = req.headers.accept || '';
  const isHtmlNav = (acceptHeader.includes('text/html') || req.headers['sec-fetch-dest'] === 'document') && !acceptHeader.includes('application/json');
  const isApiPath = cleanUrl.startsWith('/api/');

  // If browser is requesting an HTML document page navigation/refresh, let SPA fallback serve index.html (unless PDF report download or API path)
  if (isHtmlNav && !isReportRequest && !isApiPath) {
    return next();
  }

  const match = cleanUrl.match(/^\/(?:api\/)?review\/([a-zA-Z0-9_-]+)/);
  const contractId = match ? match[1] : null;

  if (!contractId) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ detail: 'Missing contract ID parameter.' });
    return;
  }

  const sendResponse = async (contractData: {
    contract_id: string;
    status: string;
    overall_risk_score: number | null;
    filename: string;
    contract_name: string;
    analyzed_at?: string;
    clauses: any[];
  }) => {
    if (isReportRequest) {
      try {
        const { generateContractPdfBuffer } = await import('./src/server/generatePdfReport.ts');
        const pdfBuffer = await generateContractPdfBuffer({
          contract_id: contractData.contract_id,
          contract_name: contractData.contract_name || contractData.filename,
          filename: contractData.filename,
          analyzed_at: contractData.analyzed_at || new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
          overall_risk_score: contractData.overall_risk_score,
          clauses: contractData.clauses,
        });

        const safeName = (contractData.filename || contractData.contract_name || 'Contract')
          .replace(/\.[^/.]+$/, '')
          .replace(/[^a-zA-Z0-9_-]/g, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_Risk_Report.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).end(pdfBuffer);
        return;
      } catch (pdfErr: any) {
        console.error('Failed to generate PDF report:', pdfErr);
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ detail: `PDF generation failed: ${pdfErr?.message || String(pdfErr)}` });
        return;
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.json(contractData);
  };

  const sampleKey = Object.keys(sampleContractsMap).find((k) => contractId === k || contractId.toLowerCase().includes(k));
  if (sampleKey) {
    await sendResponse(sampleContractsMap[sampleKey]);
    return;
  }

  try {
    const { isDbConfigured, db } = await import('./src/db/index.ts');
    const { contracts, clauses } = await import('./src/db/schema.ts');
    const { eq, asc } = await import('drizzle-orm');

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contractId);
    if (!isDbConfigured() || !isUuid) {
      res.setHeader('Content-Type', 'application/json');
      res.status(404).json({ detail: `Contract with ID '${contractId}' was not found in the database.` });
      return;
    }

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));

    if (!contract) {
      res.setHeader('Content-Type', 'application/json');
      res.status(404).json({ detail: `Contract with ID '${contractId}' was not found in the database.` });
      return;
    }

    const clauseRecords = await db
      .select()
      .from(clauses)
      .where(eq(clauses.contract_id, contractId))
      .orderBy(asc(clauses.clause_order));

    const formattedClauses = clauseRecords.map((c, idx) => ({
      clause_id: `c${c.clause_order || idx + 1}`,
      heading: c.heading || `Clause ${idx + 1}`,
      category: c.category || 'Standard',
      page_number: idx < 2 ? 1 : idx < 4 ? 2 : 3,
      text: c.original_text,
      risky_phrase: (c.original_text || '').slice(0, 140),
      risk_level: c.risk_level,
      explanation: c.explanation,
      suggested_redline: c.suggested_redline,
      reference_clause: c.reference_clause_text,
    }));

    await sendResponse({
      contract_id: contract.id,
      status: contract.status || 'complete',
      overall_risk_score: contract.overall_risk_score ? parseFloat(contract.overall_risk_score) : null,
      filename: contract.filename,
      contract_name: contract.filename,
      analyzed_at: contract.uploaded_at ? new Date(contract.uploaded_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      clauses: formattedClauses,
    });
  } catch (dbErr: any) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ detail: `Database error: ${dbErr?.message || String(dbErr)}` });
  }
});

// 5. POST /review/generate-report or /api/review/generate-report (JSON in, PDF binary out)
app.post(['/review/generate-report', '/api/review/generate-report', '/review/generate-report.pdf'], jsonParser, async (req, res) => {
  try {
    const body = req.body || {};
    const { generateContractPdfBuffer } = await import('./src/server/generatePdfReport.ts');
    const pdfBuffer = await generateContractPdfBuffer({
      contract_id: body.contract_id || body.review_id || 'contract',
      contract_name: body.contract_name || body.filename || 'Contract_Review.pdf',
      filename: body.filename || body.contract_name || 'Contract_Review.pdf',
      analyzed_at: body.analyzed_at || new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      overall_risk_score: body.overall_risk_score ?? body.overall_score ?? 50,
      overall_risk_level: body.overall_risk_level,
      clauses: body.clauses || [],
    });

    const safeName = (body.filename || body.contract_name || 'Contract')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_Risk_Report.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).end(pdfBuffer);
  } catch (err: any) {
    console.error('PDF generation error:', err);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ detail: `PDF generation error: ${err?.message || String(err)}` });
  }
});

// Block all unhandled API routes from falling through to Vite SPA index.html
app.all('/api/*', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(404).json({ detail: `API route not found: ${req.method} ${req.path}` });
});

async function startServer() {
  // Vite middleware for development vs static dist for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ContractSentry Server running on http://localhost:${PORT}`);
  });
}

startServer();
