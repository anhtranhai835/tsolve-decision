// The typed questions T-Solve asks about a new Jira issue. Written with the SDK builders, exactly
// as they would be written for Jev.
import { choice, noul, score } from "./sdk/index.ts";

export const triage = choice(
  "Classify this new IT/support issue for T-Solve triage. Decide by scope and by whether the fix is already known, not by how annoying the issue sounds.",
  {
    simple:
      "Affects only the reporter or one device, and a standard fix already exists that the reporter or helpdesk applies without investigating: " +
      "password or login after a change, missing access or permission, account or app setup on a new machine, a setting or language preference, " +
      "a device needing a routine action (printer paper, restart), a file locked by another user, or a how-to question.",
    complex:
      "A system problem an engineer must investigate: errors or an outage for many users or customers, wrong or lost data, " +
      "a security incident, a failure after a deploy or integration change, or a root cause nobody knows yet.",
  },
);

// GBR-35 style triage: after source search, ask the AI about each found ticket separately, with
// the same 2 / 1 / 0 rubric the team used to grade pairs. The issue is Simple when the AI picks
// same_problem for at least one source. (Asking about all sources in one shared state made
// qwen3:4b say yes to everything, unrelated tickets included.)
type Issue = { summary: string; description?: string };
type FoundSource = { id: string; title: string; excerpt: string };

// The team's labelling scale (grade 2 / 1 / 0), worded short on purpose. On 8 graded queries with
// qwen3:4b this wording matched 7/8 labels; the guideline pasted verbatim with its examples and
// "tricky" rule made the model answer same_area for everything (3/7), and the verbatim grade
// definitions alone made it answer same_problem too often (4/8).
export const sourceMatch = choice("Compare the new issue with the resolved source ticket.", {
  same_problem: "Same problem: the source's fix could be reused for the new issue",
  same_area: "Same app or topic, but a different problem, or the fix would not apply",
  unrelated: "Unrelated",
});

// One System One request per source: { state, questions: { match } }.
export const sourceChecks = (issue: Issue, sources: FoundSource[]) =>
  sources.map((s) => ({
    state: {
      new_issue: { summary: issue.summary, description: issue.description ?? "" },
      source: { ticket: s.id, title: s.title, solution: s.excerpt.slice(0, 600) },
    },
    questions: { match: sourceMatch },
  }));

export const TSOLVE_QUESTIONS = {
  triage,
  needs_human: noul("Should a person be alerted to handle this issue right now?", {
    true: "A handler must act now",
    false: "It can wait or the reporter can fix it",
  }),
  urgency: score("How urgent is this issue?", [
    "Low: no impact on work",
    "Medium: one person affected, a workaround exists",
    "High: blocks a team's work",
    "Critical: production incident or many users affected",
  ]),
};
