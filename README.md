# ContractSentry

ContractSentry is an AI-powered contract review, clause segmentation, and risk analysis platform. It scans commercial agreements to identify non-standard covenants, calculate clause risk scores, explain legal liabilities in plain English, and provide market-benchmarked redlines.

---

## Backend Setup & Execution Runbook

To run the FastAPI backend server locally with PostgreSQL pgvector search and the CUAD reference playbook:

### 1. Initialize Virtual Environment
```bash
cd contractsentry/backend
python3 -m venv venv
source venv/bin/activate
# On Windows:
# venv\Scripts\activate
```

### 2. Install Dependency Manifest
```bash
pip install -r requirements.txt
```

### 3. Seed Clause Playbook Vector Store
Indexes standard reference clauses from the CUAD dataset directly into the PostgreSQL `playbook_clauses` table with pgvector embeddings:
```bash
python3 seed_playbook.py
```

### 4. Launch FastAPI via Uvicorn
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 5. Health Check & API Verification
```bash
curl http://localhost:8000/health
# Returns: {"status": "ok", "service": "ContractSentry Review API"}
```

---

## Frontend Web Application

The frontend is built with React 18, TypeScript, and Tailwind CSS.

### Development Server
```bash
npm run dev
```

### Production Build
```bash
npm run build
```

---

## Core Architecture & Review Pipeline

1. **Document Ingestion**: Multi-page PDF text extraction and plain text processing.
2. **Deterministic Clause Segmentation**: Regex-guided parsing identifying major clause categories (Termination, Liability, Payment, Confidentiality, Intellectual Property, Indemnity, Governing Law).
3. **Playbook Benchmarking**: Comparing incoming clause language against vetted baseline standards from the CUAD dataset.
4. **Conservative Risk Triage**: Scoring risk (High, Medium, Low), surfacing plain-English liability explanations, and generating balanced redline recommendations.
