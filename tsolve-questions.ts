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
