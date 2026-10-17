"""Fine-tune bge-reranker-v2-m3 on the team's graded pairs and score the harness candidates.

Training pairs: every graded (query, ticket) pair whose query is NOT a labelled test query (same
split as harness-sources.ts: sha1(query id)[0] % 2 == 0 is dev). Label: grade 2 -> 1, grade 0/1 -> 0,
so "same area, different problem" is a hard negative.

Scores written to --out-scores, one JSON line {query, ticket, score} for every exported candidate:
  - dev queries: out-of-fold scores (k folds over the non-test queries), so the harness can pick
    thresholds on dev without having trained on them
  - test queries: the final model, trained on all non-test pairs
--zero-shot skips training and scores everything with the base model, for comparison.

CPU-friendly: embeddings and the lower encoder layers are frozen; only the top --train-layers
layers and the classifier head are trained.

    python rerank/train.py --data <dataset.jsonl> --candidates <candidates.jsonl> --out-scores <scores.jsonl>
        [--out-model <dir>] [--epochs 2] [--lr 2e-5] [--batch 8] [--max-length 256] [--train-layers 8]
        [--folds 3] [--zero-shot] [--limit-steps N]
"""
import argparse
import hashlib
import json
import os
import random
import time
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

BASE = "BAAI/bge-reranker-v2-m3"


def split_of(qid: str) -> str:
    return "dev" if hashlib.sha1(qid.encode()).digest()[0] % 2 == 0 else "test"


def fold_of(qid: str, folds: int) -> int:
    return hashlib.sha1(f"fold:{qid}".encode()).digest()[1] % folds


def doc_text(t: dict) -> str:
    return f"{t['summary']}\n{(t.get('solution_excerpt') or '')[:600]}"


def load_model(path: str, train_layers: int):
    model = AutoModelForSequenceClassification.from_pretrained(path, num_labels=1)
    if train_layers >= 0:
        enc = model.roberta
        for p in enc.embeddings.parameters():
            p.requires_grad = False
        layers = enc.encoder.layer
        for layer in layers[: max(0, len(layers) - train_layers)]:
            for p in layer.parameters():
                p.requires_grad = False
    return model


def train(model, tok, pairs, args, log_prefix=""):
    model.train()
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    steps_per_epoch = (len(pairs) + args.batch - 1) // args.batch
    total = steps_per_epoch * args.epochs if not args.limit_steps else min(args.limit_steps, steps_per_epoch * args.epochs)
    sched = get_linear_schedule_with_warmup(opt, int(0.1 * total), total)
    pos = sum(1 for _, _, y in pairs if y > 0.5)
    pos_weight = torch.tensor([max(1.0, (len(pairs) - pos) / max(1, pos))])
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    rng = random.Random(13)
    step, started = 0, time.perf_counter()
    for epoch in range(args.epochs):
        order = pairs[:]
        rng.shuffle(order)
        for i in range(0, len(order), args.batch):
            batch = order[i : i + args.batch]
            enc = tok([q for q, _, _ in batch], [d for _, d, _ in batch], truncation=True, max_length=args.max_length, padding=True, return_tensors="pt")
            logits = model(**enc).logits.view(-1)
            loss = loss_fn(logits, torch.tensor([y for _, _, y in batch], dtype=torch.float))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            step += 1
            if step % 20 == 0 or step == total:
                rate = step / (time.perf_counter() - started)
                print(f"{log_prefix}epoch {epoch + 1} step {step}/{total} loss {loss.item():.3f} ({rate:.2f} steps/s)", flush=True)
            if step >= total:
                return
    model.eval()


@torch.no_grad()
def score(model, tok, pairs, max_length):
    model.eval()
    out = []
    for i in range(0, len(pairs), 16):
        batch = pairs[i : i + 16]
        enc = tok([q for q, _ in batch], [d for _, d in batch], truncation=True, max_length=max_length, padding=True, return_tensors="pt")
        out += torch.sigmoid(model(**enc).logits.view(-1).float()).tolist()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out-scores", required=True)
    ap.add_argument("--out-model")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--train-layers", type=int, default=8)
    ap.add_argument("--folds", type=int, default=3)
    ap.add_argument("--zero-shot", action="store_true")
    ap.add_argument("--limit-steps", type=int, default=0, help="stop each training after N steps (timing runs)")
    args = ap.parse_args()
    torch.manual_seed(13)
    torch.set_num_threads(os.cpu_count() or 4)

    rows = [json.loads(l) for l in Path(args.data).read_text(encoding="utf-8").splitlines() if l.strip()]
    tickets = {r["id"]: r for r in rows if r["kind"] == "ticket"}
    queries = {r["id"]: r for r in rows if r["kind"] == "query"}
    cands = [json.loads(l) for l in Path(args.candidates).read_text(encoding="utf-8").splitlines() if l.strip()]

    # a query is held out when it is labelled and in the test split: the harness scores on those
    held_out = {q for q, r in queries.items() if r.get("triage") and split_of(q) == "test"}
    trainable = [q for q in queries if q not in held_out]
    pairs_of = lambda qids: [
        (queries[q]["summary"], doc_text(tickets[c["ticket_id"]]), 1.0 if c["grade"] == 2 else 0.0)
        for q in qids for c in queries[q]["candidates"] if c["grade"] is not None and c["ticket_id"] in tickets
    ]
    cand_pairs = lambda qids: [(r["id"], c["ticket"]) for r in cands if r["id"] in qids for c in r["cands"]]
    to_text = lambda pairs: [(queries[q]["summary"], doc_text(tickets[t])) for q, t in pairs]

    tok = AutoTokenizer.from_pretrained(BASE)
    scores: dict[tuple[str, str], float] = {}
    all_pairs = cand_pairs(set(r["id"] for r in cands))
    print(f"train queries {len(trainable)} (held-out test {len(held_out)}), graded pairs {len(pairs_of(trainable))}, candidates to score {len(all_pairs)}", flush=True)

    if args.zero_shot:
        model = load_model(BASE, -1)
        for p, s in zip(all_pairs, score(model, tok, to_text(all_pairs), args.max_length)):
            scores[p] = s
    else:
        # out-of-fold scores for dev candidates
        dev_ids = {r["id"] for r in cands if r["split"] == "dev"}
        for k in range(args.folds):
            fit_ids = [q for q in trainable if fold_of(q, args.folds) != k]
            score_ids = {q for q in dev_ids if fold_of(q, args.folds) == k}
            model = load_model(BASE, args.train_layers)
            print(f"fold {k + 1}/{args.folds}: train on {len(fit_ids)} queries, score {len(score_ids)} dev queries", flush=True)
            train(model, tok, pairs_of(fit_ids), args, f"  fold {k + 1} ")
            todo = cand_pairs(score_ids)
            for p, s in zip(todo, score(model, tok, to_text(todo), args.max_length)):
                scores[p] = s
            del model
        # final model on every non-test query, scores the test candidates
        model = load_model(BASE, args.train_layers)
        print(f"final: train on {len(trainable)} queries", flush=True)
        train(model, tok, pairs_of(trainable), args, "  final ")
        test_ids = {r["id"] for r in cands if r["split"] == "test"}
        todo = cand_pairs(test_ids)
        for p, s in zip(todo, score(model, tok, to_text(todo), args.max_length)):
            scores[p] = s
        if args.out_model:
            Path(args.out_model).mkdir(parents=True, exist_ok=True)
            model.save_pretrained(args.out_model)
            tok.save_pretrained(args.out_model)
            meta = {k: v for k, v in vars(args).items() if k not in ("data", "candidates", "out_scores", "out_model")}
            meta.update(base=BASE, train_queries=len(trainable), train_pairs=len(pairs_of(trainable)))
            Path(args.out_model, "tsolve-train.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            print(f"saved model to {args.out_model}", flush=True)

    with open(args.out_scores, "w", encoding="utf-8") as f:
        for (q, t), s in scores.items():
            f.write(json.dumps({"query": q, "ticket": t, "score": round(s, 4)}) + "\n")
    print(f"wrote {len(scores)} scores to {args.out_scores}", flush=True)


if __name__ == "__main__":
    main()
