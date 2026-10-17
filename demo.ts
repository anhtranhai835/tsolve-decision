// Demo: our SDK (forked from the official Jev SDK) asks the local decision server about a few
// Vietnamese tickets. Switching to another System One server only changes TSOLVE_DECISION_BASE_URL.
import { DecisionClient } from "./sdk/index.ts";
import { TSOLVE_QUESTIONS } from "./tsolve-questions.ts";

// the local server ignores the key; the SDK only requires one to be set
// slow CPU models need a longer client timeout than the SDK's 10 s default
const client = new DecisionClient({
  apiKey: process.env.TSOLVE_DECISION_API_KEY ?? "local",
  timeout: Number(process.env.TSOLVE_DECISION_TIMEOUT_MS) || 300_000,
});

const tickets = [
  { summary: "Không đăng nhập được Jira", description: "Sau khi đổi mật khẩu Google sáng nay thì Jira báo invalid credentials." },
  { summary: "Thanh toán lỗi 500 toàn hệ thống", description: "Từ 9h sáng mọi khách hàng đều không tạo được đơn, API payment trả 500." },
  { summary: "Excel báo file đang bị khóa", description: "Mở file báo cáo chung thì Excel báo file đang được người khác chỉnh sửa." },
  { summary: "Tài khoản admin đăng nhập lúc 3h sáng từ IP lạ", description: "Log cho thấy admin đăng nhập từ IP nước ngoài, nghi lộ mật khẩu." },
];

console.log(`Server: ${client.baseURL}\n`);
for (const [i, state] of tickets.entries()) {
  const started = performance.now();
  const r = await client.systemOne({ state, questions: TSOLVE_QUESTIONS });
  const ms = Math.round(performance.now() - started);
  if (i === 0) console.log("Raw response of the first ticket:\n", JSON.stringify(r, null, 2), "\n");

  const { triage, needs_human, urgency } = r.answers;
  console.log(`• ${state.summary}`);
  console.log(
    `  triage=${triage.choice} (simple ${triage.probabilities.simple}, complex ${triage.probabilities.complex}, confidence ${triage.confidence})`,
  );
  console.log(`  needs_human=${needs_human.noul}  urgency=${urgency.score} / 3  [${r.model}, ${ms} ms]\n`);
}
