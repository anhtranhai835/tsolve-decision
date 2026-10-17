# Plan: nâng độ chính xác AI Ticket Triage (UC-38 / GBR-35)

**Trạng thái:** đề xuất, chưa bắt đầu · **Lập ngày:** 17/10/2026

## Mục tiêu

Phân loại Simple/Complex cho issue mới theo GBR-35 (tìm nguồn, rồi xác nhận nguồn), đạt chỉ tiêu SRS mà vẫn chạy được trên CPU.

## Mốc hiện tại (harness `harness-sources --report`, phần test 53 query)

| Chỉ số | Hiện tại | Mục tiêu |
|---|---|---|
| Precision Simple | 82% | **≥ 90%** (NFR của SRS) |
| Recall Simple | 60% | ≥ 70% (mục tiêu xa: 80%) |
| Accuracy | 70% | ≥ 80% |
| Tìm nguồn hit@3 | 80% | ≥ 90% |
| Latency triage p95 (CPU) | ~1 s nếu chỉ dùng similarity; ~30 s nếu có LLM | ≤ 8 s |

Luật hiện tại: similarity bge-m3 ≥ 0.80. LLM 4B zero-shot không cải thiện được kết quả (cả bản thinking lẫn bản instruct).

## Hai kiểu lỗi cần sửa

1. **Gợi ý sai** (precision): các nguồn "cùng mảng nhưng khác vấn đề" vẫn vượt ngưỡng 0.80 (nhóm chấm 1). Cần một bộ chấm cặp tinh hơn embedding.
2. **Bỏ sót** (recall): ticket cùng vấn đề nhưng similarity chỉ 0.6–0.8. Cần cách tìm nguồn tốt hơn.

## Các phase

| # | Phase | Sửa lỗi | Phụ thuộc | File |
|---|---|---|---|---|
| 0 | Chốt mốc và mở rộng harness | — | — | [phase-00](phase-00-baseline-and-harness.md) |
| 1 | Dữ liệu nhãn: chấm nốt, người chấm thứ hai, lên ≥ 200 query | cả hai (độ tin cậy) | chạy song song với 2 | [phase-01](phase-01-labelled-data.md) |
| 2 | Tìm nguồn tốt hơn: tiêu đề riêng, BM25 hybrid, bổ sung từ khoá | bỏ sót | 0 | [phase-02](phase-02-retrieval.md) |
| 3 | Bộ chấm cặp: reranker zero-shot, rồi fine-tune | gợi ý sai | 0, 2 | [phase-03](phase-03-pair-judge.md) |
| 4 | Lớp quyết định: chọn ngưỡng / model trộn tín hiệu trên dev | cả hai | 2, 3 | [phase-04](phase-04-decision-layer.md) |
| 5 | Tích hợp vào T-Solve và cập nhật tài liệu | — | 4 | [phase-05](phase-05-integration-and-docs.md) |

Phase 1 do cả nhóm làm (chấm nhãn), chạy song song với phase 2–3 do người code làm.

## Tiêu chí nghiệm thu

- [ ] `harness-sources --report` trên **test** đạt precision Simple ≥ 90% và recall Simple ≥ 70%.
- [ ] Toàn bộ triage (tìm nguồn + chấm + quyết định) có p95 ≤ 8 s trên CPU của máy pilot.
- [ ] Mỗi thay đổi đều có một dòng kết quả harness trên dev và test, ghi trong README.
- [ ] Không có ticket thật, model đã fine-tune, hay log trong git (`data/private/` vẫn bị ignore).
- [ ] SRS (GBR-35, actor Embedding service, IV.1.2) và Report 2 (R09, báo cáo đánh giá) được cập nhật theo kết quả đo.

## Quy tắc chung

- Chọn mọi thứ (ngưỡng, biến thể, hyperparameter) **trên dev**; chỉ chấm **test một lần** cho mỗi lựa chọn cuối cùng.
- Phương án mới phải vượt **đường "chỉ dùng similarity"** trên test, nếu không thì không đưa vào.
- Dữ liệu và model đã train trên ticket thật là dữ liệu mật: chỉ lưu local hoặc trên Drive của nhóm.
