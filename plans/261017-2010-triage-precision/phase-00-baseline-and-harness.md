# Phase 0: Chốt mốc và mở rộng harness

## Bối cảnh
- `harness-sources.ts` ghi kết quả theo từng model, và chỉ tính các lần chạy có cùng câu hỏi (`questionId`).
- Các phase sau còn thay đổi **cách tìm nguồn** và **bộ chấm cặp**, nên harness phải phân biệt được kết quả theo từng biến thể đó.

## Yêu cầu
- Commit code harness hiện tại (xoay vị trí đáp án, chia dev/test, report chọn luật trên dev) để làm mốc.
- Mỗi lần chạy ghi thêm `retrieval` (id của biến thể tìm nguồn) và `judge` (tên model chấm cặp, hoặc `none`).
- Thêm chế độ `--retrieval-only`: chỉ đo hit@k và triage "chỉ dùng similarity", không gọi LLM, chạy vài phút.
- Report in thêm **độ chênh similarity giữa top 1 và top 2**, làm đặc trưng cho phase 4.

## File
- Sửa: `harness-sources.ts`, `retrieval.ts` (cho chọn biến thể qua `RETRIEVAL=...`).
- Không đụng tới: `data/private/*` (ngoài git).

## Các bước
1. `git commit` bản hiện tại: harness với dev/test và mốc 70% / 82% / 60%.
2. Thêm trường `retrieval` và `judge` vào bản ghi; tên file chạy đổi thành `runs/<retrieval>__<judge>.jsonl`.
3. Thêm `--retrieval-only` (dùng lại `score()` với luật `aiMin: "none"`).
4. Chạy lại `--retrieval-only` với biến thể hiện tại (`title+excerpt`), kiểm tra ra đúng mốc cũ.

## Kiểm tra
- `npm test` pass; thêm 1 test cho việc đọc hoặc ghi bản ghi có trường mới.
- `--retrieval-only` cho cùng hit@k (70/80/92%) và cùng 70% / 82% / 60% trên test như hiện tại.

## Rủi ro / quay lại
- Đổi tên file chạy làm mất liên kết với bản ghi cũ: giữ các file cũ, chỉ đổi cách đặt tên cho lần chạy mới.
