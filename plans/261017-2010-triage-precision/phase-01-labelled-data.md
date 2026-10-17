# Phase 1: Dữ liệu nhãn (cả nhóm làm, song song với phase 2–3)

## Bối cảnh
- Hiện có 120 query với 2.311 cặp, chỉ một người chấm (Bình). Còn 24 cặp chưa chấm, nên 15 query chưa có nhãn.
- SRS đặt NFR trên **≥ 200 ticket có nhãn**. Với 53 query test, mỗi query sai làm accuracy dao động khoảng 2%, nên con số còn nhiễu.
- Guideline yêu cầu hai người chấm độc lập.

## Yêu cầu
1. Chấm nốt 24 cặp còn thiếu.
2. Người chấm thứ hai chấm độc lập ít nhất 30 query (khoảng 600 cặp), rồi tính **Cohen's kappa** trên thang 0/1/2. Đây là **trần** mà AI có thể đạt. Các cặp hai người chấm khác nhau thì cùng nhau xử lý.
3. Thêm query mới đến **≥ 200 query có nhãn**. Query lấy từ tiêu đề issue thật mới (không trùng ticket có trong kho); với mỗi query, chấm top 20 ticket do bge-m3 tìm ra, theo đúng guideline cũ.
4. **Bổ sung nhãn cho các cặp được tìm ra nhưng chưa ai chấm** (hiện có 8/315 cặp top 3): mỗi lần đổi cách tìm nguồn ở phase 2 thì chấm bù các cặp mới xuất hiện trong top 3.

## File
- Excel chấm nhãn: theo mẫu `labelling_*.xlsx` cũ, chỉ lưu trên Google Drive của nhóm.
- Gộp vào `data/private/tsolve-labelled-dataset.jsonl` bằng script gộp trước đây; cần đưa script gộp vào repo (bản không chứa dữ liệu).

## Các bước
1. Xuất danh sách 24 cặp còn thiếu (đã có pair_id), gửi Bình chấm.
2. Tạo file chấm cho người thứ hai (cùng định dạng, thứ tự ngẫu nhiên).
3. Viết script tính kappa và in các cặp hai người chấm khác nhau.
4. Sinh file chấm cho các query mới: lấy top 20 ticket theo bge-m3, xáo trộn thứ tự, không ghi similarity để tránh ảnh hưởng người chấm.
5. Gộp dữ liệu và chạy lại `harness-sources --report`. Cách chia dev/test theo mã query được giữ cố định, nên query cũ không đổi phần.

## Kiểm tra
- 0 cặp chưa chấm; kappa ≥ 0.6 (mức đồng thuận khá). Nếu thấp hơn thì phải làm rõ guideline trước khi train.
- ≥ 200 query có nhãn, tỉ lệ Simple/Complex ghi lại trong README.

## Rủi ro / quay lại
- Kappa thấp nghĩa là chính nhãn đang nhiễu: sửa guideline trước, chưa nên train.
- Quy tắc bảo mật số 7: không gửi file chấm qua chat hay email.
