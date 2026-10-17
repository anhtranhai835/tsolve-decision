# T-Solve Decision — demo

Demo cho team: **dùng interface của Jev (System One), nhưng model do mình tự host.**

```
demo.ts / harness.ts ──(SDK của mình, ./sdk)──► POST /v1/systemone ──► server.ts ──► Ollama (Qwen)
                                                  (contract của Jev)      đọc logprobs của 1 token đáp án
```

- `sdk/`: SDK của mình, là bản sửa từ SDK chính thức của TypeSafe ([typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js), commit `b844cd1`, MIT). Đã đổi: `TypeSafeClient` → `DecisionClient`, `TypeSafeError` → `DecisionError`, biến env `TYPESAFE_*` → `TSOLVE_DECISION_*`, server mặc định là `http://127.0.0.1:8787`. Vẫn export thêm alias `TypeSafeClient` nên code viết cho Jev chỉ cần đổi đường dẫn import. **Bắt buộc giữ file `sdk/LICENSE`.** Tên sản phẩm không được dùng chữ "Jev"/"TypeSafe" vì đó là thương hiệu.
- `server.ts`: server nói đúng contract `/v1/systemone` (noul / choice / score, xác suất, confidence). Mỗi câu hỏi được đổi thành trắc nghiệm A/B/C…; model chỉ sinh 1 token, xác suất lấy từ logprobs. Server nhận được body nén zstd mà SDK gửi lên.
- `decision.ts`: logic chuyển câu hỏi → prompt và logprobs → đáp án có kiểu (có test trong `decision.test.ts`).
- `tsolve-questions.ts`: các câu hỏi của T-Solve: `triage` (simple/complex), `needs_human`, `urgency`.
- `public/index.html`: màn hình demo, server phục vụ ở `http://127.0.0.1:8787/`. Gồm:
  - **Import** ticket: 20 ticket mẫu, file JSONL/JSON/CSV, hoặc dán trực tiếp.
  - **Pipeline**: Import → Ghép state → 3 câu hỏi chạy song song (triage / cần người / khẩn cấp) → Luật GBR-35 → Định tuyến (Gợi ý Solution hoặc Escalation handler). Bấm vào từng bước để xem input, output và prompt.
  - Khung **"AI đang nghĩ gì"**: model đọc prompt gì, muốn viết token nào với xác suất bao nhiêu, xác suất từng đáp án, và quyết định cuối cùng.
  - **Tổng kết**: accuracy, p95, cảnh báo khi model bị thiên lệch vị trí. Server chỉ gửi trace khi request có header `X-TSolve-Trace: 1`; client Jev bình thường không bị ảnh hưởng.
- `harness.ts` + `data/tickets.jsonl`: chạy 20 ticket tiếng Việt đã gán nhãn, in ra accuracy, recall, Brier và latency p50/p95.

## Chạy

Cần Node 24+ và Ollama. Không có dependency nào, không cần `npm install`.

```bash
ollama pull qwen3:4b
npm run server      # terminal 1, rồi mở http://127.0.0.1:8787/
npm run demo        # terminal 2 (bản dòng lệnh)
npm run harness     # đánh giá 20 ticket
npm run harness -- --model qwen3:0.6b --min-accuracy 0.8   # đổi model; dưới ngưỡng thì exit 1 (dùng làm gate CI)
npm test
```

Biến môi trường (đều có mặc định): `LOCAL_MODEL` (mặc định `qwen3:4b`), `OLLAMA_URL`, `PORT` (8787), `QUESTION_TIMEOUT_MS` (120000; SRS yêu cầu 8000 nhưng demo trên CPU cần nhiều hơn), `TSOLVE_DECISION_TIMEOUT_MS` (300000), `TSOLVE_DECISION_BASE_URL`, `TSOLVE_DECISION_API_KEY` (server local bỏ qua key này).

Server điền sẵn `Answer:` ở đầu câu trả lời của model. Lý do: các model có chế độ suy luận như qwen3:4b bỏ qua `think:false` và mở đầu bằng "First, the…"; khi đã điền sẵn `Answer:`, token tiếp theo bắt buộc là chữ cái đáp án.

## Kết quả đo ngày 17/10/2026: laptop i7-1255U, 16 GB RAM, chỉ CPU, triage 20 ticket

| Cấu hình | Accuracy | Recall simple / complex | Brier | Latency p50 / p95 mỗi ticket (chỉ triage) |
|---|---|---|---|---|
| qwen3:0.6b, mô tả cũ (chưa thêm `Answer:`) | 50% | 100% / 0% | 0.398 | 1.0 s / 1.1 s |
| qwen3:4b, mô tả cũ | 70% | 40% / 100% | 0.165 | 5.0 s / 5.7 s |
| qwen3:4b, mô tả simple mới | 85% | 70% / 100% | 0.085 | (bị cache, không đo) |
| **qwen3:4b, mô tả mới + trung bình 2 thứ tự** (mặc định hiện tại) | **95%** | 90% / 100% | **0.076** | 13 s / 27 s |

- **0.6b**: luôn chọn đáp án đứng đầu, không hiểu nội dung.
- **Mô tả "simple" mới** (`tsolve-questions.ts`): phân loại theo phạm vi ảnh hưởng (1 người / 1 máy) và "đã có cách sửa chuẩn hay chưa", kèm danh sách các nhóm lỗi quen thuộc. Riêng bước này đưa accuracy từ 70% lên 85%.
- **Trung bình 2 thứ tự** (`ORDER_DEBIAS`, bật mặc định): mỗi câu hỏi được hỏi hai lần, lần hai đảo ngược thứ tự đáp án, rồi lấy trung bình xác suất của từng đáp án. Bước này đưa 85% lên 95%, đổi lại thời gian gấp đôi. Đặt `ORDER_DEBIAS=0` để nhanh hơn.
- Ticket còn sai: T09 (Chrome báo lỗi chứng chỉ vì đồng hồ máy sai), model cho P(simple) 0.41.
- **Kết quả này còn lạc quan**: mô tả mới được viết khi đã biết 20 ticket này, nên 95% chưa phải con số của dữ liệu mới. Cần một tập ticket khác (held-out), tốt nhất là 200 ticket theo Report 2, để đo lại.
- Với ngưỡng 0.80 của GBR-35 (màn hình demo áp dụng ngưỡng này, harness thì không), T05 (0.71) và T08 (0.58) vẫn bị chuyển thành Complex. Như vậy Simple thực tế được gợi ý là 7/10 ticket. Đây là hướng an toàn, và là lý do cần calibrate.
- Máy này chạy được 4b mà không cần VPS. Muốn đạt ≤ 8s ổn định cho pilot thì vẫn nên có GPU.

## Bước tiếp theo

1. Viết thêm khoảng 50–200 ticket mới (không dùng khi viết mô tả) để đo accuracy thật.
2. Calibrate (temperature scaling) trên tập held-out để ngưỡng 0.80 của GBR-35 có ý nghĩa thật.
3. Triage thật theo GBR-35: thêm các nguồn tìm được (Published ticket / Wiki) vào `state`.
4. Phía Java (Spring Boot) gọi thẳng HTTP `/v1/systemone` theo contract này.
5. Chỉ fine-tune (LoRA) khi harness cho thấy các bước trên chưa đủ.
