# Phase 2: Tìm nguồn tốt hơn (sửa bỏ sót)

## Bối cảnh
- Hiện tại embed `tiêu đề + 1000 ký tự đầu của đoạn trích cách sửa` bằng bge-m3; tìm bằng cosine.
- Query là tiêu đề issue; đoạn trích cách sửa có nhiều câu xã giao ("Hi IT đã hỗ trợ…"), làm loãng nghĩa.
- Tên hệ thống, mã (`System_01`, `WO`, `FI`) và từ khoá (`checkout`, `checkin`) là tín hiệu mạnh mà embedding hay bỏ qua.
- Mốc: hit@1 70%, hit@3 80%, hit@10 92%; recall Simple 60% ở ngưỡng 0.80.

## Biến thể cần thử (đều chạy trên CPU, không cần LLM)
| id | Nội dung |
|---|---|
| `title-excerpt` | hiện tại (mốc) |
| `title` | chỉ embed tiêu đề ticket |
| `max-field` | similarity = max(sim với tiêu đề, sim với tiêu đề + đoạn trích) |
| `hybrid-rrf` | BM25 trên tiêu đề + đoạn trích, trộn với embedding bằng Reciprocal Rank Fusion (k = 60) |
| `+expansion` | ghép `q_vi`/`q_en` (câu truy vấn nhóm đã viết) vào văn bản của ticket khi index (thêm vào bất kỳ biến thể nào ở trên) |

## File
- Sửa: `retrieval.ts` (chọn biến thể qua `RETRIEVAL`; BM25 tự viết, khoảng 40 dòng, không thêm dependency), `harness-sources.ts`.
- Cache embedding đặt tên theo biến thể (`*.title.embeddings.json`…).

## Các bước
1. Viết `title` và `max-field` (dùng lại cache: thêm vector cho tiêu đề).
2. Viết BM25 (tách từ đơn giản theo khoảng trắng, chuyển chữ thường, giữ dấu tiếng Việt) và RRF.
3. Viết `+expansion`.
4. Với mỗi biến thể: `--retrieval-only` trên **dev**; chọn biến thể có hit@3 cao nhất, nếu bằng nhau thì lấy recall Simple cao hơn ở precision ≥ 90%.
5. Chấm biến thể đã chọn **một lần** trên test; ghi kết quả vào README.
6. Cho chấm bù các cặp mới vào top 3 mà chưa có nhãn (phase 1, bước 4).

## Kiểm tra
- Unit test cho BM25 (xếp hạng đúng trên vài câu mẫu bịa sẵn) và RRF.
- Mục tiêu: hit@3 ≥ 90% trên dev; recall Simple tăng mà precision không giảm (trên test).

## Rủi ro / quay lại
- `+expansion` chỉ có cho 80 ticket: dễ chênh lệch giữa các ticket. Đo riêng nhóm ticket có và không có expansion.
- Similarity của biến thể mới có thang khác, nên ngưỡng 0.80 không còn đúng: luôn chọn lại ngưỡng trên dev.
- Không biến thể nào hơn mốc: giữ `title-excerpt`.
