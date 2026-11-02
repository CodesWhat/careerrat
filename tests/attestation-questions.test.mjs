// CR101: truthfulness and AI-use attestations are never answered for a person.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFillPlan, resolveScreeningAnswer } from "../src/core/apply/form-fill.mjs";
import { draftPacketAnswers } from "../src/core/packet/answers.mjs";
import { isAttestationQuestion } from "../src/core/packet/attestation.mjs";

const ATTESTATIONS = [
  "Did you use AI to help prepare this application?",
  "Have you used ChatGPT or any generative AI tool to write your responses?",
  "Please disclose any use of artificial intelligence in completing this form.",
  "Our AI usage policy: I confirm my answers are my own and not AI-generated.",
  "I certify that the information provided is true and accurate to the best of my knowledge.",
  "I attest that all statements in this application are true and complete.",
  "I understand that false or misleading information may be grounds for termination.",
  "I acknowledge that any misrepresentation is cause for rejection of my application.",
];

const NOT_ATTESTATIONS = [
  "Do you have experience building AI products?",
  "Are you familiar with large language models?",
  "How many years of Python experience do you have?",
  "Are you legally authorized to work in the United States?",
  "What are your salary expectations?",
  "Why do you want to work here?",
  "Link to your portfolio",
];

test("AI-use and truthfulness questions are recognised as attestations", () => {
  for (const label of ATTESTATIONS) assert.equal(isAttestationQuestion(label), true, label);
});

test("ordinary work and screening questions are not attestations", () => {
  for (const label of NOT_ATTESTATIONS) assert.equal(isAttestationQuestion(label), false, label);
});

test("a fixture AI-use question drafts NEEDS YOU, never an answer, and never reaches the AI", async () => {
  let aiCalls = 0;
  const result = await draftPacketAnswers({
    context: { profile: {}, honesty: {}, evidence: { claims: [] } },
    questions: {
      answerable: [
        { id: "q-ai", label: ATTESTATIONS[0], type: "text", required: true },
        { id: "q-true", label: ATTESTATIONS[4], type: "checkbox", required: true },
      ],
      excluded: [],
    },
    call: async () => {
      aiCalls += 1;
      throw new Error("the AI must not be asked an attestation");
    },
  });
  assert.equal(aiCalls, 0);
  assert.equal(result.answers.length, 2);
  for (const answer of result.answers) {
    assert.match(answer.answer, /^NEEDS YOU\b/);
    assert.equal(answer.uploadReady, false);
    assert.deepEqual(answer.evidenceIds, []);
  }
  assert.equal(result.manual.required, true);
});

test("a saved screening answer does not auto-answer an attestation either", () => {
  const formDefaults = {
    screening_answers: {
      "did you use ai to help prepare this application": "No",
      "i certify that the information provided is true": "Yes",
    },
  };
  for (const label of [ATTESTATIONS[0], ATTESTATIONS[4]]) {
    assert.equal(resolveScreeningAnswer({ label }, { formDefaults }).action, "skip", label);
    const [plan] = buildFillPlan({ fields: [{ label }], formDefaults, profile: {} });
    assert.equal(plan.action, "skip", label);
    assert.equal(plan.value, null, label);
  }
});
