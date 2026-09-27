<div align="center">

# 🛡️ ContractSentry

### AI-Powered Legal Contract Risk-Review Agent

**Analyze. Retrieve. Detect. Explain.**

An AI-powered system that analyzes legal contracts, identifies potentially risky clauses,
and provides reference-based insights using **LLMs + RAG + a Legal Clause Playbook**.

<br>

[![Live Demo]https://contractsentry1.ai.studio
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/Subhatra-tech/ContractSentry)
[![Python](https://img.shields.io/badge/Python-3.x-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![React](https://img.shields.io/badge/React-TypeScript-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![RAG](https://img.shields.io/badge/AI-RAG-purple?style=flat-square)](#-how-it-works)
[![ChromaDB](https://img.shields.io/badge/Vector%20DB-ChromaDB-orange?style=flat-square)](https://www.trychroma.com/)

</div>

---

## 📌 Overview

**ContractSentry** is an AI-powered contract risk-review agent designed to help users
quickly understand potential risks hidden inside legal contracts.

Instead of manually reviewing every clause, ContractSentry:

**📄 Extracts → 🔍 Segments → 📚 Retrieves → 🧠 Analyzes → ⚠️ Detects → 💡 Explains**

The system combines **Large Language Models (LLMs)** with **Retrieval-Augmented
Generation (RAG)** and a reference-based **Legal Clause Playbook**.

> ⚠️ ContractSentry is an AI-assisted contract review tool and does not replace
> professional legal advice.

---

# ✨ Features

<table>
<tr>

<td width="50%">

### 📄 Contract Processing

Upload a legal contract and extract its
text for automated analysis.

</td>

<td width="50%">

### 🔍 Clause Segmentation

Break the contract into meaningful
individual clauses for focused analysis.

</td>

</tr>

<tr>

<td width="50%">

### 🧠 AI Risk Analysis

Use an LLM to analyze contract clauses
and explain potential concerns.

</td>

<td width="50%">

### 📚 RAG-Based References

Retrieve relevant reference clauses
from the legal playbook before analysis.

</td>

</tr>

<tr>

<td width="50%">

### ⚠️ Risk Classification

Identify potential risks using levels such
as LOW, MEDIUM, HIGH and CRITICAL.

</td>

<td width="50%">

### 💡 Explainable Results

Present risk findings in a simple,
human-readable format.

</td>

</tr>
</table>

---

# 🏗️ System Architecture

```mermaid
flowchart LR

    A["👤 User"] --> B["⚛️ React Frontend"]

    B --> C["⚡ FastAPI Backend"]

    C --> D["📄 PDF Text Extraction"]

    D --> E["🔍 Clause Segmentation"]

    E --> F["📚 RAG Retrieval"]

    F --> G["🗄️ ChromaDB"]

    G --> F

    F --> H["🧠 LLM"]

    H --> I["⚠️ Risk Analysis"]

    I --> J["💡 Explanation & Risk Level"]

    J --> B
