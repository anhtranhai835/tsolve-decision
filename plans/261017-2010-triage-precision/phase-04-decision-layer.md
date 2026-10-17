# Phase 4: Lớp quyết định

## Bối cảnh
- Luật hiện tại chỉ có một ngưỡng similarity. Sau phase 2–3, mỗi nguồn có thêm vài tín hiệu: similarity, điểm BM25 hoặc RRF, điểm reranker, thứ hạng, và độ chênh giữa top 1 và top 2.
- Chọn ngưỡng bằng tay cho nhiều tín hiệu cùng lúc sẽ dễ overfit, và không tận dụng hết thông tin.

## Phương án (thử theo thứ tự, dừng ở phương án đầu tiên đạt mục tiêu)
1. **Hai ngưỡng** (đúng nguyên văn GBR-35): sim ≥ g **và** điểm reranker ≥ t. Grid search trên dev.
2. **Hồi quy logistic** trên đặc trưng của nguồn tốt nhất: `[sim1, sim1 - sim2, rrf1, rerank1, rank_of_best_rerank]`. Regularization L2, chọn C bằng cross-validation theo query trong dev. Ngưỡng xác suất chọn để precision ≥ 90% trên dev.
3. Lưu model trộn thành `decision-model.json` (hệ số + ngưỡng), khoảng 1 KB; server đọc file này khi khởi động.

## File
- Tạo: `decision-model.ts` (fit logistic, khoảng 60 dòng, không dependency; hoặc dùng script Python của phase 3), `decision-model.json` (đưa vào git được, vì chỉ có hệ số, không có dữ liệu).
- Sửa: `harness-sources.ts` (thêm luật `model`), `server.ts`, `public/index.html` (hiện xác suất của model trộn và các đặc trưng).

## Các bước
1. Xuất bảng đặc trưng từ các bản ghi chạy (dev).
2. Fit, chọn C và ngưỡng trên dev.
3. Chấm test một lần; so với phương án hai ngưỡng và với đường "chỉ dùng similarity".
4. Ghi lựa chọn cuối và lý do vào README.

## Kiểm tra
- Unit test: fit trên một tập bịa sẵn tách được tuyến tính thì phải đạt 100%.
- Test: precision Simple ≥ 90%, recall ≥ 70%.

## Rủi ro / quay lại
- Model trộn không hơn phương án hai ngưỡng quá 2 điểm phần trăm thì giữ hai ngưỡng (đơn giản, dễ giải thích trong báo cáo).
