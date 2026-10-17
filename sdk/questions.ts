import { DecisionError } from "./errors.ts";
import type {
  BoxQuestion,
  ChoiceCriteria,
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Questions,
  ScoreCriteria,
  ScoreQuestion,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Create a yes/no question with optional descriptions for either outcome.
 *
 * @param instructions - The question as text, a JSON object or array; `null` or omitted
 * requires `criteria` to describe at least one outcome.
 * @param criteria - Descriptions of the yes and no outcomes.
 */
export const noul: {
  (instructions: NonNullable<EntryType>, criteria?: NoulQuestion["criteria"]): NoulQuestion;
  (
    instructions: EntryType | undefined,
    criteria:
      | { true: NonNullable<EntryType>; false?: EntryType }
      | { true?: EntryType; false: NonNullable<EntryType> },
  ): NoulQuestion;
} = (instructions: EntryType = null, criteria?: NoulQuestion["criteria"]): NoulQuestion => ({
  type: "noul",
  instructions,
  criteria,
});

/**
 * Create a score question using an ordered rubric.
 *
 * @param instructions - The question as text, a JSON object or array, or `null`.
 * @param criteria - At least two descriptions indexed by score from zero; entries may be `null`.
 *   A list built at runtime, such as a `string[]`, is accepted, and `systemOne` rejects it when
 *   it has fewer than two entries.
 */
export const score: {
  <const T extends ScoreCriteria>(instructions: EntryType, criteria: T): ScoreQuestion<T>;
  <const T extends readonly EntryType[]>(
    instructions: EntryType,
    // A literal list's length is known, so lists of fewer than two entries match no overload.
    criteria: T & (number extends T["length"] ? unknown : never),
  ): ScoreQuestion<readonly [T[number], T[number], ...T[number][]]>;
} = (instructions: EntryType, criteria: readonly EntryType[]): ScoreQuestion => {
  // `systemOne` rejects lists of fewer than two entries.
  const rubric = criteria as ScoreCriteria;
  if (!Array.isArray(criteria)) {
    throw new DecisionError(
      "Score criteria must be a list of descriptions indexed by score from zero, not a map.",
    );
  }
  return { type: "score", instructions, criteria: rubric };
};

/**
 * Create a question that selects between named alternatives.
 *
 * @param instructions - The question as text, a JSON object or array, or `null`.
 * @param criteria - Labels mapped to descriptions, or `null` for undescribed labels.
 */
export const choice = <const T extends ChoiceCriteria>(
  instructions: EntryType,
  criteria: T,
): ChoiceQuestion<T> => {
  if (Array.isArray(criteria)) {
    throw new DecisionError("Choice criteria must be a map of labels to descriptions, not a list.");
  }
  return { type: "choice", instructions, criteria };
};

/**
 * Create a question that locates what its instructions describe in the request's image.
 * The T-Solve decision server does not answer `box` questions yet.
 *
 * @param instructions - What to locate, as text, an asset, a JSON object or array; defaults to `null`.
 *
 * @example
 * ```ts
 * const { answers } = await client.systemOne({
 *   state: image(await openAsBlob("photo.jpg")),
 *   questions: { dog: box("The dog") },
 *   model: "tsolve-decision",
 * });
 * const { top, bottom, left, right } = answers.dog.box;
 * ```
 */
export const box = (instructions: EntryType = null): BoxQuestion => ({
  type: "box",
  instructions,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateChoice = (name: string, { criteria }: ChoiceQuestion): void => {
  if (!isObject(criteria)) {
    throw new DecisionError(
      `Choice question "${name}" has criteria that are not a map; ` +
        "choice criteria must be a map of labels to descriptions.",
    );
  }
  if (Object.keys(criteria).length === 0) {
    throw new DecisionError(
      `Choice question "${name}" has no criteria; at least one choice is required.`,
    );
  }
};

const validateNoul = (name: string, { instructions, criteria }: NoulQuestion): void => {
  if (criteria != null && !isObject(criteria)) {
    throw new DecisionError(`Noul question "${name}" criteria must be an object.`);
  }
  if (instructions == null && !Object.values(criteria ?? {}).some((value) => value != null)) {
    throw new DecisionError(
      `Noul question "${name}" has neither instructions nor criteria; at least one is required.`,
    );
  }
};

/**
 * Reject empty question sets, score questions without a list of at least two criteria, choice
 * questions without a nonempty map of criteria, and noul questions with non-object criteria or
 * with neither instructions nor a described outcome.
 */
export const validateQuestions = (questions: Questions): void => {
  if (Object.keys(questions).length === 0) {
    throw new DecisionError("At least one question is required.");
  }
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") validateChoice(name, question);
    if (question.type === "noul") validateNoul(name, question);
    if (question.type !== "score") continue;
    if (!Array.isArray(question.criteria)) {
      throw new DecisionError(
        `Score question "${name}" has criteria that are not a list; ` +
          "score criteria must be a list of descriptions indexed by score from zero.",
      );
    }
    if (question.criteria.length < 2) {
      throw new DecisionError(
        `Score question "${name}" has ${question.criteria.length} criteria; ` +
          "at least two scores are required.",
      );
    }
  }
};
