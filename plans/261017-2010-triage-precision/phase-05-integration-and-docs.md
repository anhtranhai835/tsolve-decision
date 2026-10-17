# Phase 5: Tích hợp vào T-Solve và cập nhật tài liệu

## Bối cảnh
- T-Solve backend: Java 21 / Spring Boot, PostgreSQL + pgvector, Ollama (Local AI service), triage qua T-Solve Jira App (UC-38, ngân sách 8 s).
- `tsolve-decision` là bản demo và harness. Luồng thật phải chạy trong Spring Boot.

## Yêu cầu
1. **Spring Boot:**
   - Index ticket đã Published và Wiki chunk bằng bge-m3 (Ollama `POST /api/embed`), lưu vào pgvector.
   - Triage: embed issue (sau khi mask PII), lấy top 3 bằng pgvector (cộng BM25 nếu phase 2 chọn hybrid, dùng full-text search của Postgres), gọi bộ chấm (sidecar reranker, hoặc không có), rồi áp luật hoặc model trộn của phase 4.
   - Gọi bộ chấm theo contract `/v1/systemone` hoặc `/rerank`, để sau này đổi model mà không phải sửa Java.
   - Timeout hoặc lỗi thì trả Complex (GBR-35).
2. **Cấu hình:** `SIM_GATE`, `AI_MIN` (hoặc `decision-model.json`), tên model; đặt trong config, không hard-code.
3. **Hiệu năng:** đo p95 trên máy pilot (CPU) ≤ 8 s.
4. **Tài liệu:**
   - Report 3 (SRS): GBR-35 ghi ngưỡng đã đo và bộ chấm thực tế; actor "Embedding service" đổi thành bge-m3 local; sửa IV.1.2 (không gửi văn bản ra ngoài để embed).
   - Report 2: đóng R09; mục "Triage and Chatbot evaluation report" dùng bảng của harness (dev/test, precision, recall, latency).
   - README demo: cập nhật kết quả cuối.

## File (repo T-Solve, ngoài repo này)
- Module `triage`: `EmbeddingClient`, `SourceSearch` (pgvector + full-text), `PairJudgeClient`, `TriageDecision`, `TriageController` (API cho Jira App).
- Migration Flyway: cột `embedding vector(1024)` cho Published ticket và Wiki chunk, cùng index HNSW.

## Các bước
1. Port luật quyết định (hoặc model trộn) sang Java, có unit test dùng lại các ca của harness.
2. Viết job index (JOB-03 cho Wiki, thêm job cho Published ticket).
3. Thêm integration test: issue mẫu, top 3, quyết định, so với kết quả của harness trên cùng dữ liệu.
4. Đo latency trên máy pilot.
5. Cập nhật SRS và Report 2.

## Kiểm tra
- Kết quả Java khớp harness trên ≥ 20 query mẫu (cùng nguồn, cùng quyết định).
- p95 ≤ 8 s trên CPU của máy pilot.

## Rủi ro / quay lại
- Kết quả Java lệch harness (do chuẩn hoá vector, tách từ BM25): viết test so sánh số liệu với độ sai số nhỏ.
- Máy pilot yếu hơn laptop dev: tắt bộ chấm, chỉ dùng similarity (vẫn đạt GBR-35 ở mức hiện tại).
