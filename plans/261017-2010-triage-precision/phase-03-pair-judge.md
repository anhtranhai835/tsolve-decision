# Phase 3: Bộ chấm cặp (sửa gợi ý sai)

## Bối cảnh
- Gợi ý sai ở ngưỡng 0.80 chủ yếu thuộc loại "cùng mảng nhưng khác vấn đề" (nhóm chấm 1).
- LLM 4B zero-shot không phân biệt được: bản thinking chấm 2 cho mọi cặp, bản instruct chấm 1 cho mọi cặp.
- Cross-encoder (reranker) đọc cả hai văn bản cùng lúc và được làm ra đúng cho việc chấm độ liên quan của một cặp.

## Yêu cầu
1. **Reranker zero-shot:** `BAAI/bge-reranker-v2-m3` (568M, đa ngôn ngữ), chạy local trên CPU.
2. **Fine-tune** reranker đó trên các cặp của **query thuộc phần dev** (cộng thêm query mới từ phase 1, chia theo cùng quy tắc mã query). Không cặp nào của query test được đưa vào train.
3. Đưa điểm reranker vào harness như một `judge`, đo giống hệt các LLM.

## Hạ tầng
- Ollama không chạy reranker, nên dùng một **sidecar Python** nhỏ (FastAPI + `sentence-transformers` `CrossEncoder`), chỉ nghe trên 127.0.0.1, endpoint `POST /rerank {query, docs[]} → scores[]`.
- Hoặc llama.cpp `llama-server --reranking` với bản GGUF của reranker, nếu muốn khỏi cài Python.
- `server.ts` gọi sidecar khi `JUDGE=reranker`; giao diện hiện điểm reranker ở các node nguồn.

## Tham số fine-tune (khởi điểm)
| Tham số | Giá trị |
|---|---|
| Nhãn | điểm 2 → 1.0; điểm 1 → 0.0 (thử thêm 0.3); điểm 0 → 0.0 |
| Loss | BCEWithLogits |
| Learning rate | 2e-5, warmup 10%, linear decay |
| Epoch | 2–3 (dừng sớm theo dev, dùng cross-validation theo query trong dev) |
| Batch / max length | 16 / 512 token |
| Văn bản cặp | query = tiêu đề issue; doc = tiêu đề ticket + 600 ký tự đầu của đoạn trích cách sửa |
| Phần cứng | CPU qua đêm (khoảng 2k–4k cặp × 3 epoch); có GPU nội bộ thì khoảng 15 phút |

## File
- Tạo: `rerank/server.py`, `rerank/train.py`, `rerank/requirements.txt` (code thì vào git, model thì không).
- Model đã fine-tune lưu tại `data/private/models/reranker-<ngày>/` (ngoài git; coi là dữ liệu mật).
- Sửa: `harness-sources.ts` (judge = reranker), `server.ts`, `public/index.html`.

## Các bước
1. Dựng sidecar, chạy zero-shot; đo trên dev bằng harness (luật: sim ≥ g và điểm reranker ≥ t, chọn g và t trên dev).
2. Viết `train.py`; train bằng cross-validation 5-fold theo query **trong dev** để chọn số epoch và nhãn cho điểm 1.
3. Train bản cuối trên toàn bộ dev; chấm test một lần.
4. Ghi sha256 của model và kết quả harness tương ứng vào README.

## Kiểm tra
- Mục tiêu: precision Simple ≥ 90% trên test và recall không thấp hơn mốc 60%.
- Latency: chấm 3 cặp ≤ 1.5 s trên CPU.

## Rủi ro / quay lại
- Dữ liệu ít, dễ overfit: dùng cross-validation theo query, có dừng sớm, ưu tiên ít epoch.
- Model đã fine-tune có thể nhớ nội dung ticket: không đẩy lên Hugging Face hay GitHub.
- Zero-shot đã đủ tốt thì bỏ qua fine-tune.
