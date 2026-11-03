import { capWorkspaceMessages } from "./jobs.mjs";

const DETAIL_MESSAGE_LIMIT = 200;
const DETAIL_REQUIREMENT_LIMIT = 200;
const DETAIL_CALL_LIMIT = 100;

// The table only needs these. Everything else on a job travels as a detail
// event for the selected row, so a large workspace can't make the snapshot
// line grow with the saved data.
export function summaryJobs(jobs) {
  return jobs.map((job) => ({
    id: job.id,
    kind: job.kind,
    stage: job.stage,
    pay: job.pay,
    fit: job.fit,
    record: {
      company: job.record.company,
      role: job.record.role,
      status: job.record.status,
    },
  }));
}

// One job in full, trimmed so a single oversized record can't exceed the
// bridge's line limit. `truncated` says so for the reader.
export function jobDetail(job) {
  let truncated = false;
  const messages = (list) => {
    const capped = capWorkspaceMessages(list, { limit: DETAIL_MESSAGE_LIMIT });
    if (capped.total > capped.messages.length) truncated = true;
    return capped.messages;
  };
  const record = { ...job.record };
  const requirements = record.evaluation?.requirements;
  if (Array.isArray(requirements) && requirements.length > DETAIL_REQUIREMENT_LIMIT) {
    record.evaluation = {
      ...record.evaluation,
      requirements: requirements.slice(0, DETAIL_REQUIREMENT_LIMIT),
    };
    truncated = true;
  }
  if (Array.isArray(record.conversations) && record.conversations.length > DETAIL_CALL_LIMIT) {
    record.conversations = record.conversations.slice(-DETAIL_CALL_LIMIT);
    truncated = true;
  }
  return {
    ...job,
    record,
    thread: job.thread ? { ...job.thread, messages: messages(job.thread.messages) } : null,
    contextMessages: messages(job.contextMessages),
    truncated,
  };
}
