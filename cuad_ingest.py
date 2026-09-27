#!/usr/bin/env python3
"""
cuad_ingest.py - Ingest CUAD v1 dataset, inspect labels, map categories,
and extract real verbatim clause examples into playbook_raw.json.

Dataset: Contract Understanding Atticus Dataset (CUAD) v1
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
Source: The Atticus Project (https://www.atticusprojectai.org/cuad)
"""

import json
import os
import sys
import io
import zipfile
import urllib.request
from typing import Dict, List, Any, Set, Tuple

CUAD_ZIP_URL = "https://github.com/TheAtticusProject/cuad/raw/main/data.zip"
LOCAL_CACHE_PATH = os.path.join(os.path.dirname(__file__), "data", "CUADv1.json")
OUTPUT_MAPPING_PATH = os.path.join(os.path.dirname(__file__), "category_mapping.json")
OUTPUT_PLAYBOOK_PATH = os.path.join(os.path.dirname(__file__), "playbook_raw.json")
COPY_PLAYBOOK_PATH = os.path.join(os.path.dirname(__file__), "data", "playbook_raw.json")

PRODUCT_CATEGORIES = [
    "Termination",
    "Payment",
    "Confidentiality",
    "Intellectual Property",
    "Liability",
    "Indemnity",
    "Governing Law",
]


def load_cuad_dataset() -> Dict[str, Any]:
    """Download or load cached CUAD v1 dataset in SQuAD QA JSON format."""
    if os.path.exists(LOCAL_CACHE_PATH):
        print(f"[1/5] Loading cached CUAD dataset from {LOCAL_CACHE_PATH}...")
        with open(LOCAL_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"[1/5] Downloading CUAD v1 dataset from {CUAD_ZIP_URL}...")
    req = urllib.request.Request(CUAD_ZIP_URL, headers={"User-Agent": "ContractSentry-Ingest/1.0"})
    with urllib.request.urlopen(req) as resp:
        zip_bytes = resp.read()
        print(f"Downloaded {len(zip_bytes):,} bytes. Extracting CUADv1.json...")
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            cuad_content = zf.read("CUADv1.json")
            data = json.loads(cuad_content.decode("utf-8"))

    # Cache locally to data/CUADv1.json
    os.makedirs(os.path.dirname(LOCAL_CACHE_PATH), exist_ok=True)
    with open(LOCAL_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)
    print(f"Cached CUAD dataset to {LOCAL_CACHE_PATH} ({len(cuad_content):,} bytes).")
    return data


def extract_cuad_labels(cuad_data: Dict[str, Any]) -> List[Dict[str, str]]:
    """Extract and inspect the 41 clause-type categories/labels directly from the dataset."""
    contracts = cuad_data.get("data", [])
    if not contracts:
        raise ValueError("Empty CUAD dataset!")

    first_contract = contracts[0]
    qas = first_contract["paragraphs"][0]["qas"]

    labels: List[Dict[str, str]] = []
    print("\n" + "=" * 80)
    print(f"[2/5] CUAD v1 LABEL SET ({len(qas)} Categories Identified Directly From Dataset)")
    print("=" * 80)

    for idx, qa in enumerate(qas, 1):
        qa_id = qa["id"]
        cat_name = qa_id.split("__", 1)[1] if "__" in qa_id else qa_id
        question = qa.get("question", "")
        # Extract details substring if available
        details = ""
        if "Details:" in question:
            details = question.split("Details:", 1)[1].strip()

        labels.append({
            "index": idx,
            "category": cat_name,
            "question": question,
            "details": details,
        })
        print(f"  {idx:2d}. {cat_name:38s} | {details[:65]}...")

    print("=" * 80 + "\n")
    return labels


def build_category_mapping(cuad_labels: List[Dict[str, str]]) -> Dict[str, Any]:
    """
    Build a mapping file category_mapping.json that maps our 7 product categories
    to genuinely relevant CUAD categories, explicitly flagging missing or indirect matches.
    """
    print("[3/5] Building category mapping file (category_mapping.json)...")
    cuad_category_names = {item["category"] for item in cuad_labels}

    mapping: Dict[str, Any] = {
        "_metadata": {
            "source": "Contract Understanding Atticus Dataset (CUAD) v1",
            "curator": "The Atticus Project",
            "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
            "citation": "Hendrycks et al., CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review (2021)",
            "total_cuad_categories": len(cuad_labels),
            "total_product_categories": len(PRODUCT_CATEGORIES),
        },
        "all_cuad_categories": [item["category"] for item in cuad_labels],
        "category_mappings": {
            "Termination": {
                "product_category": "Termination",
                "match_type": "direct_match",
                "is_flagged": False,
                "mapped_cuad_categories": [
                    "Termination For Convenience",
                    "Notice Period To Terminate Renewal",
                    "Renewal Term",
                    "Post-Termination Services",
                ],
                "description": "Termination clauses governing unilateral termination without cause, non-renewal notification windows, term renewal mechanics, and post-termination transition commitments.",
                "notes": "Direct alignment across four CUAD categories covering voluntary exit, renewal notice, and wind-down obligations.",
            },
            "Payment": {
                "product_category": "Payment",
                "match_type": "direct_match",
                "is_flagged": False,
                "mapped_cuad_categories": [
                    "Revenue/Profit Sharing",
                    "Price Restrictions",
                    "Minimum Commitment",
                    "Volume Restriction",
                ],
                "description": "Financial and pricing terms including royalties/revenue sharing, price escalation restrictions, minimum purchase orders, and volume tier adjustments.",
                "notes": "Direct alignment across four CUAD commercial pricing and financial obligation categories.",
            },
            "Confidentiality": {
                "product_category": "Confidentiality",
                "match_type": "no_direct_match",
                "is_flagged": True,
                "mapped_cuad_categories": [],
                "description": "Confidentiality and non-disclosure obligations protecting proprietary technical and business disclosures.",
                "notes": "FLAGGED: CUAD v1 does NOT have a dedicated 'Confidentiality' or 'Non-Disclosure' category among its 41 labels. The Atticus Project designed CUAD primarily for corporate M&A due diligence, where NDAs are typically separate standalone agreements. Confidentiality is only mentioned in CUAD as a carve-out example under 'Uncapped Liability'. Per instructions, this absence is explicitly flagged and NOT forced into an unrelated bucket.",
            },
            "Intellectual Property": {
                "product_category": "Intellectual Property",
                "match_type": "direct_match",
                "is_flagged": False,
                "mapped_cuad_categories": [
                    "Ip Ownership Assignment",
                    "Joint Ip Ownership",
                    "License Grant",
                    "Non-Transferable License",
                    "Unlimited/All-You-Can-Eat-License",
                    "Irrevocable Or Perpetual License",
                    "Source Code Escrow",
                ],
                "description": "Ownership assignments of created works, joint technology rights, license grants, license restrictions, unlimited usage provisions, and source code escrow triggers.",
                "notes": "Comprehensive direct alignment with 7 CUAD intellectual property and licensing categories.",
            },
            "Liability": {
                "product_category": "Liability",
                "match_type": "direct_match",
                "is_flagged": False,
                "mapped_cuad_categories": [
                    "Cap On Liability",
                    "Uncapped Liability",
                    "Liquidated Damages",
                    "Warranty Duration",
                ],
                "description": "Risk allocation provisions including overall monetary caps on damages, carve-outs to limitations of liability, liquidated damages clauses, and warranty duration limitations.",
                "notes": "Direct alignment with 4 CUAD liability and risk mitigation categories.",
            },
            "Indemnity": {
                "product_category": "Indemnity",
                "match_type": "partial_indirect_match",
                "is_flagged": True,
                "mapped_cuad_categories": [
                    "Uncapped Liability",
                    "Insurance",
                ],
                "description": "Third-party claim indemnification obligations, defense requirements, and insurance coverage mandates backing contractual liabilities.",
                "notes": "FLAGGED: CUAD v1 does not have an isolated standalone 'Indemnification' category label. However, contractual indemnity obligations are explicitly annotated in CUAD under 'Uncapped Liability' (where third-party indemnification commitments are carved out from liability caps) and 'Insurance' (which mandates coverage to satisfy indemnified claims). Extracted clauses draw from these genuine indemnity and risk-backing provisions.",
            },
            "Governing Law": {
                "product_category": "Governing Law",
                "match_type": "direct_match",
                "is_flagged": False,
                "mapped_cuad_categories": [
                    "Governing Law",
                ],
                "description": "Choice of law, jurisdiction, venue selection, and applicable statutory frameworks governing contract interpretation.",
                "notes": "Direct 1:1 match with CUAD's 'Governing Law' category.",
            },
        },
    }

    # Verify that all mapped CUAD categories actually exist in the CUAD dataset
    for cat_name, cat_info in mapping["category_mappings"].items():
        for cuad_cat in cat_info["mapped_cuad_categories"]:
            if cuad_cat not in cuad_category_names:
                raise ValueError(f"Category '{cuad_cat}' in mapping does not exist in CUAD label set!")

    with open(OUTPUT_MAPPING_PATH, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)
    print(f"Saved category mapping to {OUTPUT_MAPPING_PATH}")
    return mapping


def extract_clauses_for_category(
    cuad_data: Dict[str, Any],
    product_category: str,
    target_cuad_categories: List[str],
    target_count: int = 18,
    min_length: int = 60,
    indemnity_focus: bool = False,
) -> List[Dict[str, Any]]:
    """
    Extract target_count real clause examples for a product category from mapped CUAD categories.
    Prioritizes variety by pulling from different contracts and different CUAD source documents.
    """
    if not target_cuad_categories:
        return []

    contracts = cuad_data.get("data", [])
    extracted: List[Dict[str, Any]] = []
    used_contracts: Set[str] = set()

    # Pre-index all candidate answers grouped by CUAD category
    cat_candidates: Dict[str, List[Tuple[str, str, str]]] = {cat: [] for cat in target_cuad_categories}

    for contract in contracts:
        contract_title = contract.get("title", "Unknown Contract")
        paragraphs = contract.get("paragraphs", [])
        for p in paragraphs:
            qas = p.get("qas", [])
            for qa in qas:
                qa_id = qa["id"]
                c_name = qa_id.split("__", 1)[1] if "__" in qa_id else qa_id
                if c_name in cat_candidates:
                    answers = qa.get("answers", [])
                    for ans in answers:
                        text = ans.get("text", "").strip()
                        # Normalization of excessive whitespace inside text while preserving verbatim content
                        clean_text = " ".join(text.split())
                        if len(clean_text) >= min_length:
                            if indemnity_focus and c_name == "Uncapped Liability":
                                # Prioritize answers addressing indemnification / defense / third-party claims
                                if any(term in clean_text.lower() for term in ["indemn", "hold harmless", "defend", "third party"]):
                                    cat_candidates[c_name].append((contract_title, c_name, clean_text))
                            else:
                                cat_candidates[c_name].append((contract_title, c_name, clean_text))

    # Round-robin selection across mapped categories to ensure even representation and contract variety
    cat_indices = {cat: 0 for cat in target_cuad_categories}
    active_categories = list(target_cuad_categories)

    while len(extracted) < target_count and active_categories:
        progress_made = False
        for cat in list(active_categories):
            candidates = cat_candidates.get(cat, [])
            idx = cat_indices[cat]
            # Find next candidate with an unused contract
            found_candidate = None
            while idx < len(candidates):
                c_title, c_cat, c_text = candidates[idx]
                idx += 1
                if c_title not in used_contracts:
                    found_candidate = (c_title, c_cat, c_text)
                    used_contracts.add(c_title)
                    break

            cat_indices[cat] = idx
            if found_candidate:
                c_title, c_cat, c_text = found_candidate
                extracted.append({
                    "clause_text": c_text,
                    "source_contract": c_title,
                    "cuad_category": c_cat,
                    "product_category": product_category,
                    "char_length": len(c_text),
                })
                progress_made = True
                if len(extracted) >= target_count:
                    break
            else:
                # No more unique contract candidates in this category
                active_categories.remove(cat)

        if not progress_made:
            # Fallback if unique contracts exhausted before reaching target_count
            break

    return extracted


def build_playbook_raw(cuad_data: Dict[str, Any], mapping: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract 15-20 real clause examples per category and format into playbook_raw.json.
    """
    print("\n[4/5] Extracting diverse verbatim clauses from CUAD source documents...")
    category_mappings = mapping["category_mappings"]

    extracted_by_category: Dict[str, List[Dict[str, Any]]] = {}
    all_clauses: List[Dict[str, Any]] = []
    category_stats: Dict[str, Any] = {}

    for prod_cat in PRODUCT_CATEGORIES:
        info = category_mappings[prod_cat]
        mapped_cats = info["mapped_cuad_categories"]
        is_indemnity = prod_cat == "Indemnity"

        if not mapped_cats:
            print(f"  [-] {prod_cat:22s} -> 0 clauses (Flagged: No direct CUAD category match)")
            extracted_by_category[prod_cat] = []
            category_stats[prod_cat] = {
                "extracted_count": 0,
                "flagged": True,
                "reason": info["notes"],
            }
            continue

        clauses = extract_clauses_for_category(
            cuad_data=cuad_data,
            product_category=prod_cat,
            target_cuad_categories=mapped_cats,
            target_count=18,
            min_length=60,
            indemnity_focus=is_indemnity,
        )

        unique_contracts = len({c["source_contract"] for c in clauses})
        cuad_sources_used = list({c["cuad_category"] for c in clauses})

        extracted_by_category[prod_cat] = clauses
        all_clauses.extend(clauses)
        category_stats[prod_cat] = {
            "extracted_count": len(clauses),
            "unique_contracts_sampled": unique_contracts,
            "cuad_categories_sampled": cuad_sources_used,
            "flagged": info.get("is_flagged", False),
        }

        print(
            f"  [+] {prod_cat:22s} -> {len(clauses)} clauses from {unique_contracts} distinct contracts "
            f"(across {len(cuad_sources_used)} CUAD labels: {', '.join(cuad_sources_used)})"
        )

    # Construct final playbook_raw payload
    playbook_raw = {
        "_metadata": {
            "dataset_name": "Contract Understanding Atticus Dataset (CUAD) v1",
            "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "atticus_url": "https://www.atticusprojectai.org/cuad",
            "citation": "Dan Hendrycks, Collin Burns, Anya Chen, Spencer Ball. CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review. arXiv:2103.06268 (2021).",
            "total_clauses": len(all_clauses),
            "total_categories_mapped": len([k for k, v in category_stats.items() if v["extracted_count"] > 0]),
            "unmatched_categories": [k for k, v in category_stats.items() if v["extracted_count"] == 0],
            "category_summary": category_stats,
        },
        "category_mapping_summary": {
            k: {
                "match_type": v["match_type"],
                "mapped_cuad_categories": v["mapped_cuad_categories"],
                "is_flagged": v["is_flagged"],
            }
            for k, v in category_mappings.items()
        },
        "categories": extracted_by_category,
        "clauses": all_clauses,
    }

    print(f"\n[5/5] Writing playbook_raw.json (Total {len(all_clauses)} real verbatim clauses)...")
    with open(OUTPUT_PLAYBOOK_PATH, "w", encoding="utf-8") as f:
        json.dump(playbook_raw, f, indent=2)
    print(f"Saved primary raw playbook to {OUTPUT_PLAYBOOK_PATH}")

    os.makedirs(os.path.dirname(COPY_PLAYBOOK_PATH), exist_ok=True)
    with open(COPY_PLAYBOOK_PATH, "w", encoding="utf-8") as f:
        json.dump(playbook_raw, f, indent=2)
    print(f"Saved duplicate copy to {COPY_PLAYBOOK_PATH}")

    return playbook_raw


def main():
    print("=" * 80)
    print("ContractSentry - CUAD Dataset Ingestion & Raw Playbook Extractor")
    print("Licensed CC BY 4.0 by The Atticus Project (atticusprojectai.org/cuad)")
    print("=" * 80)

    # 1. Load CUAD v1 dataset
    cuad_data = load_cuad_dataset()

    # 2. Inspect and print 41 categories
    cuad_labels = extract_cuad_labels(cuad_data)

    # 3. Build category_mapping.json
    mapping = build_category_mapping(cuad_labels)

    # 4 & 5. Extract 15-20 clauses per category with high variety and save playbook_raw.json
    playbook_raw = build_playbook_raw(cuad_data, mapping)

    print("\n" + "=" * 80)
    print("INGESTION COMPLETE")
    print(f"- Categories Mapped: {len(mapping['category_mappings'])}")
    print(f"- Total Real Clauses Extracted: {len(playbook_raw['clauses'])}")
    print(f"- Output Mapping: {OUTPUT_MAPPING_PATH}")
    print(f"- Output Raw Playbook: {OUTPUT_PLAYBOOK_PATH}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()
