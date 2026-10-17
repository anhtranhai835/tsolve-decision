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
  - **Pipeline**: Import → Ghép state → 3 câu hỏi chạy song song (triage / cần người / khẩn cấp) → AI quyết định (lấy đúng đáp án AI chọn ở câu triage, không có ngưỡng; AI lỗi thì coi là Complex) → Định tuyến (Gợi ý Solution hoặc Escalation handler). Bấm vào từng bước để xem input, output và prompt.
  - Khung **"AI đang nghĩ gì"**: model đọc prompt gì, muốn viết token nào với xác suất bao nhiêu, xác suất từng đáp án, và quyết định cuối cùng.
  - **Tổng kết**: accuracy, p95, cảnh báo khi model bị thiên lệch vị trí. Server chỉ gửi trace khi request có header `X-TSolve-Trace: 1`; client Jev bình thường không bị ảnh hưởng.
- `harness.ts` + `data/tickets.jsonl`: chạy 20 ticket tiếng Việt đã gán nhãn, in ra accuracy, recall, Brier và latency p50/p95.

## Chạy

Cần Node 24+ và Ollama. Không có dependency nào, không cần `npm install`.

```bash
ollama pull qwen3:4b
ollama pull bge-m3
npm run server      # terminal 1, rồi mở http://127.0.0.1:8787/
npm run demo        # terminal 2 (bản dòng lệnh)
npm run harness     # đánh giá 20 ticket mẫu (phân loại theo nội dung)
npm run harness:sources -- --model qwen3:4b             # triage theo nguồn trên dữ liệu nhóm; ghi vào data/private/runs/, chạy lại thì tự chạy tiếp
npm run harness:sources -- --report --model qwen3:4b    # không gọi model: chọn luật trên dev, chấm trên test
npm test
```

Biến môi trường (đều có mặc định): `LOCAL_MODEL` (`qwen3:4b`), `SIM_GATE` (0.8, ngưỡng similarity của GBR-35, chọn bằng harness), `AI_MIN` (`argmax` = theo đáp án AI chọn; hoặc một số, ví dụ 0.2 = xác suất AI chấm 2 tối thiểu), `ORDER_DEBIAS` (1 = xoay vị trí đáp án), `OLLAMA_URL`, `EMBED_MODEL` (`bge-m3`), `KB_PATH`, `PORT` (8787), `QUESTION_TIMEOUT_MS` (120000; SRS yêu cầu 8000 nhưng demo trên CPU cần nhiều hơn), `TSOLVE_DECISION_TIMEOUT_MS` (300000), `TSOLVE_DECISION_BASE_URL`, `TSOLVE_DECISION_API_KEY` (server local bỏ qua key này).

**Harness triage theo nguồn** (`harness-sources.ts`): chia cố định 105 query có nhãn thành dev (52) và test (53) theo mã query. Chế độ chạy ghi lại, cho từng nguồn, similarity, điểm nhóm chấm, xác suất AI cho 2/1/0. Chế độ `--report` thử 3 cách quyết định: chỉ dùng similarity; similarity + AI tự chọn; similarity + ngưỡng xác suất AI (GBR-35). Với mỗi cách, nó chọn luật trên dev (recall Simple cao nhất mà precision Simple ≥ 90% theo NFR của SRS), rồi chấm đúng một lần trên test. Model mới phải **vượt đường "chỉ dùng similarity"** thì mới đáng dùng.

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
- Màn hình demo và harness giờ dùng cùng một luật: AI chọn gì thì kết quả là đó, không có ngưỡng. Khác với SRS: GBR-35 yêu cầu nguồn có similarity ≥ 0.80 **và** AI xác nhận nguồn áp dụng được với confidence ≥ 0.70. Demo chưa có bước tìm nguồn.
- Máy này chạy được 4b mà không cần VPS. Muốn đạt ≤ 8s ổn định cho pilot thì vẫn nên có GPU.

## Triage theo nguồn (bge-m3 + AI chấm 2/1/0), đo trên dữ liệu đã chấm của nhóm, 17/10/2026

Dùng `npm run harness:sources`, cần có `data/private/tsolve-labelled-dataset.jsonl` (không có trong git). Lần chạy này dừng ở 88/105 query có nhãn. Model: qwen3:4b, chạy trên CPU, mỗi query khoảng 23 giây.

**Tìm nguồn** (60 query có ticket được chấm 2; ticket trùng tiêu đề với query bị loại): hit@1 70%, hit@3 80%, hit@10 92%.

**AI chấm từng nguồn** so với nhóm chấm (hàng = nhóm 2/1/0, cột = AI 2/1/0):

| | AI 2 | AI 1 | AI 0 |
|---|---|---|---|
| nhóm 2 | 86 | 8 | 0 |
| nhóm 1 | 32 | 11 | 0 |
| nhóm 0 | 48 | 72 | 0 |

AI nhận ra 91% nguồn được chấm 2, nhưng **quá dễ dãi**: 48/120 nguồn không liên quan vẫn bị chấm 2, và AI không bao giờ chấm 0. Similarity trung bình của nguồn theo điểm nhóm: điểm 2 là 0.82, điểm 1 là 0.69, điểm 0 là 0.60.

**Triage** (Simple khi có nguồn được AI chấm 2), và mô phỏng thêm cổng similarity trên cùng kết quả:

| Cổng similarity | Accuracy | Simple đúng | Complex đúng | Gợi ý đưa ra (đúng điểm 2 / sai điểm 0) |
|---|---|---|---|---|
| không có (hiện tại) | 67% | 49/52 | 10/36 | 75 (36 / **22**) |
| 0.65 | **80%** | 43/52 | 27/36 | 52 (35 / 5) |
| 0.70 | 78% | 39/52 | 30/36 | 45 (34 / **2**) |
| 0.80 (con số trong SRS) | 73% | 30/52 | 34/36 | 32 (28 / 1) |

Ngưỡng được chọn trên chính dữ liệu này nên con số còn lạc quan; phải kiểm lại trên phần test riêng (xem bước 2.3 bên dưới). Câu hỏi đã thử 3 cách diễn đạt khác (gộp 3 nguồn vào một state; guideline nguyên văn có ví dụ; định nghĩa nguyên văn), cả ba đều kém hơn trên 8 query thử (xem chú thích trong `tsolve-questions.ts`).

## So sánh model trên dev/test cố định (harness mới, xoay vị trí đáp án), 17/10/2026

105 query có nhãn; luật chọn trên dev (52), chấm trên **test (53)**:

| Cách quyết định | qwen3:4b (thinking) | qwen3:4b-instruct-2507 |
|---|---|---|
| Chỉ dùng similarity (sim ≥ 0.80, không AI) | acc 70%, precision Simple 82%, recall 60% | (giống, vì không dùng AI) |
| Similarity + AI tự chọn | 70% / 82% / 60% (AI không thay đổi gì) | 52% / 78% / 23% |
| Similarity + ngưỡng xác suất AI | 70% / 82% / 60% | 65% / 80% / 53% |

AI chấm so với nhóm chấm, trên toàn bộ các cặp đã chấm:
- qwen3:4b chấm **2 cho gần như mọi cặp** (107/107 cặp nhóm chấm 2, 58/58 cặp chấm 1, 141/142 cặp chấm 0).
- Bản instruct chấm **1 cho gần như mọi cặp**.
- Cả hai đều không phân biệt được cặp đúng và cặp sai. Mọi quyết định thực chất đến từ similarity của bge-m3.
- Ngưỡng similarity được chọn trên dev là **0.80, trùng GBR-35**.
- Chưa cách nào đạt precision Simple ≥ 90% trên test (tốt nhất 82%).

Lỗi đã sửa trong harness: với câu hỏi 3 đáp án, chỉ đảo ngược thứ tự thì đáp án giữa vẫn nằm ở chữ "B", mà qwen3 lại chọn "B" cho gần như mọi câu sau khi đã điền sẵn `Answer:`. Giờ server xoay vòng để mỗi đáp án lần lượt đứng ở A, B và C (`optionOrders`), rồi lấy trung bình.

**Kết luận cho T-Solve:** MVP nên dùng triage chỉ bằng similarity (bge-m3 + pgvector, khoảng 1 giây trên CPU). LLM 4B chạy zero-shot không giúp gì cho bước này. Muốn đạt precision ≥ 90% thì cần **train**: model nhỏ trộn tín hiệu, rồi đến reranker fine-tune trên các cặp đã chấm. Đánh giá vẫn bằng harness này.

## Bước tiếp theo

1. Viết thêm khoảng 50–200 ticket mới (không dùng khi viết mô tả) để đo accuracy thật.
2. **Harness quanh AI để chấm nguồn chuẩn hơn** (để làm sau). Nguyên tắc: model trả lời câu hẹp, code quyết định, có cổng kiểm tra, có đo lường. Thứ tự đề xuất:
   1. Cổng similarity trước khi hỏi AI (theo GBR-35). Ticket simple có top-1 similarity khoảng 0.81, ticket complex khoảng 0.64.
   2. Tách câu hỏi nhỏ ("cùng hệ thống?", "cùng triệu chứng?", "cách sửa dùng lại được?"); code chỉ coi là cùng vấn đề khi cả ba đều có. Mục đích là sửa lỗi AI nhầm "cùng mảng" thành "cùng vấn đề".
   3. Runner thử nhiều biến thể (cách hỏi, model, ngưỡng) trên dữ liệu đã chia dev/test, rồi in bảng xếp hạng.
   4. Ví dụ thật lấy từ phần dev của dữ liệu đã chấm, đưa vào prompt.
   5. Bỏ phiếu giữa nhiều cách hỏi, và đánh dấu "không chắc" (khi đó coi là Complex, hoặc chuyển cho model lớn hơn).
3. Khi đã có ngưỡng thì calibrate (temperature scaling) trên tập held-out để con số ngưỡng có ý nghĩa thật.
4. Phía Java (Spring Boot) gọi thẳng HTTP `/v1/systemone` theo contract này.
5. Chỉ fine-tune (LoRA) khi harness cho thấy các bước trên chưa đủ.
