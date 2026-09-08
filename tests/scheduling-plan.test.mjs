import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSchedulingHoldIcs,
  planSchedulingReply,
  schedulingPlanOutputSchema,
} from "../src/core/scheduling/plan.mjs";

const communication = {
  id: "comm-temporal-recruiter",
  company: "Temporal Labs",
  role: "Applied AI Engineer",
  subject: "Interview availability",
  summary: "Recruiter asked for availability next week.",
  participants: [{ name: "Avery Recruiter", email: "avery@example.test" }],
  messages: [
    {
      direction: "inbound",
      at: "2030-08-09T13:00:00.000Z",
      summary: "Can you share availability for a recruiter screen next week?",
    },
  ],
};

const application = {
  id: "app-temporal",
  company: "Temporal Labs",
  role: "Applied AI Engineer",
  status: "interview",
};

const profile = {
  candidate: { preferred_name: "Sam" },
  location: { home: "New York, NY" },
  availability: {
    timezone: "America/New_York",
    working_hours: "09:00-18:00",
    preferred_days: ["Tue", "Wed", "Thu"],
    preferred_times: "afternoons",
    buffer_minutes: 15,
    default_meeting_minutes: 30,
    blackout: ["daily 12:00-13:00"],
  },
};

test("scheduling plan asks for missing availability before calling AI or writing a draft", async () => {
  let called = false;
  const result = await planSchedulingReply({
    communication,
    application,
    profile: { candidate: { preferred_name: "Sam" }, location: { home: "Denver, CO" } },
    instruction: "Handle the scheduling reply.",
    now: new Date("2030-08-10T12:00:00.000Z"),
    runBoundedAI: async () => {
      called = true;
      throw new Error("must not call AI without a real availability source");
    },
  });

  assert.equal(called, false);
  assert.equal(result.status, "needs_user");
  assert.deepEqual(result.missing, ["availability"]);
  assert.match(result.message, /days or times/i);
});

test("scheduling plan gives bounded AI only scheduling-safe context", async () => {
  const calls = [];
  const executionPlan = {
    operation: "communication.drafting",
    runtimeId: "codex",
  };
  const result = await planSchedulingReply({
    communication: {
      ...communication,
      compensation: { current_base: 999_999 },
      privateNote: "do not transmit",
      messages: [
        {
          ...communication.messages[0],
          body: "Reply to private@example.test or call 555-0000 about the interview.",
        },
      ],
    },
    application: {
      ...application,
      compNote: "$999k private",
      current_base: 999_999,
      note: "private application note",
    },
    profile: {
      ...profile,
      compensation: { current_base: 999_999 },
      contact: { email: "private@example.test", phone: "555-0000" },
    },
    calendarBusy: [
      {
        provider: "google_calendar",
        startIso: "2030-08-13T18:00:00.000Z",
        endIso: "2030-08-13T18:30:00.000Z",
        label: "Secret customer call",
      },
    ],
    instruction: "Offer two afternoon times next week.",
    executionPlan,
    now: new Date("2030-08-10T12:00:00.000Z"),
    runBoundedAI: async (input) => {
      calls.push(input);
      return {
        body: {
          ok: true,
          data: {
            state: "draft_ready",
            timezone: "America/New_York",
            timezoneAssumed: false,
            timezoneNote: "",
            subject: "Re: Interview availability",
            body: "Hi Avery, Tuesday at 3:00 PM or Wednesday at 2:00 PM ET works — Best, Sam",
            round: "recruiter screen",
            contactName: "Avery",
            durationMinutes: 30,
            selectedSlotIndex: null,
            slots: [
              {
                startIso: "2030-08-13T19:00:00.000Z",
                endIso: "2030-08-13T19:30:00.000Z",
                label: "Tue Aug 13, 3:00 PM ET",
              },
              {
                startIso: "2030-08-14T18:00:00.000Z",
                endIso: "2030-08-14T18:30:00.000Z",
                label: "Wed Aug 14, 2:00 PM ET",
              },
            ],
            missing: [],
          },
          ai: { used: true, engine: { label: "Codex" }, elapsedMs: 42 },
        },
      };
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.plan.slots.length, 2);
  assert.doesNotMatch(result.plan.body, /—/);
  assert.match(result.plan.body, /America\/New_York/);
  assert.equal(calls[0].structuredMode, "native-preferred");
  assert.deepEqual(calls[0].executionPlan, executionPlan);
  assert.deepEqual(calls[0].schema, schedulingPlanOutputSchema);
  const prompt = JSON.stringify(calls[0].messages);
  assert.doesNotMatch(
    prompt,
    /999|private@example|555-0000|private application note|Secret customer/
  );
  assert.equal(JSON.parse(calls[0].messages[0].content).calendarBusy[0].label, "Busy");
});

test("scheduling plan drops busy conflicts with the configured buffer", async () => {
  const result = await planSchedulingReply({
    communication,
    application,
    profile,
    calendarBusy: [
      {
        provider: "google_calendar",
        startIso: "2030-08-13T18:45:00.000Z",
        endIso: "2030-08-13T19:15:00.000Z",
        label: "Busy",
      },
    ],
    instruction: "Offer Tuesday afternoon.",
    now: new Date("2030-08-10T12:00:00.000Z"),
    runBoundedAI: async () => ({
      body: {
        ok: true,
        data: {
          state: "draft_ready",
          timezone: "America/New_York",
          timezoneAssumed: false,
          timezoneNote: "",
          subject: "Re: Interview availability",
          body: "Hi Avery, Tuesday at 3:00 PM ET works for me. Best, Sam",
          round: "recruiter screen",
          contactName: "Avery",
          durationMinutes: 30,
          selectedSlotIndex: null,
          slots: [
            {
              startIso: "2030-08-13T19:00:00.000Z",
              endIso: "2030-08-13T19:30:00.000Z",
              label: "Tue Aug 13, 3:00 PM ET",
            },
          ],
          missing: [],
        },
        ai: { used: true },
      },
    }),
  });

  assert.equal(result.status, "needs_user");
  assert.deepEqual(result.missing, ["conflict-free availability"]);
  assert.match(result.message, /busy calendar/i);
});

test("scheduling plan keeps conflict-free slots when only part of a proposal overlaps", async () => {
  const result = await planSchedulingReply({
    communication,
    application,
    profile,
    calendarBusy: [
      {
        provider: "google_calendar",
        startIso: "2030-08-13T18:45:00.000Z",
        endIso: "2030-08-13T19:15:00.000Z",
        label: "Busy",
      },
    ],
    instruction: "Offer Tuesday or Wednesday afternoon.",
    now: new Date("2030-08-10T12:00:00.000Z"),
    runBoundedAI: async () => ({
      body: {
        ok: true,
        data: {
          state: "draft_ready",
          timezone: "America/New_York",
          timezoneAssumed: false,
          timezoneNote: "",
          subject: "Re: Interview availability",
          body: "Hi Avery, Tuesday at 3:00 PM or Wednesday at 2:00 PM ET works. Best, Sam",
          round: "recruiter screen",
          contactName: "Avery",
          durationMinutes: 30,
          selectedSlotIndex: null,
          slots: [
            {
              startIso: "2030-08-13T19:00:00.000Z",
              endIso: "2030-08-13T19:30:00.000Z",
              label: "Tue Aug 13, 3:00 PM ET",
            },
            {
              startIso: "2030-08-14T18:00:00.000Z",
              endIso: "2030-08-14T18:30:00.000Z",
              label: "Wed Aug 14, 2:00 PM ET",
            },
          ],
          missing: [],
        },
        ai: { used: true },
      },
    }),
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.plan.slots.map((slot) => slot.label),
    ["Wed Aug 14, 2:00 PM ET"]
  );
  assert.match(result.plan.body, /Wed Aug 14, 2:00 PM ET/);
  assert.doesNotMatch(result.plan.body, /Tuesday at 3:00 PM|Tue Aug 13/);
});

for (const history of [true, false]) {
  test(`scheduling plan checks conflicts after 200 ${history ? "historical" : "future"} blocks`, async () => {
    const slot = {
      startIso: "2030-08-13T19:00:00.000Z",
      endIso: "2030-08-13T19:30:00.000Z",
      label: "Tue Aug 13, 3:00 PM ET",
    };
    const start = Date.parse(history ? "2029-08-10T12:00:00Z" : "2030-08-11T12:00:00Z");
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      startIso: new Date(start + index * 5 * 60_000).toISOString(),
      endIso: new Date(start + (index * 5 + 1) * 60_000).toISOString(),
      label: "Private meeting",
    }));
    let context;
    const result = await planSchedulingReply({
      communication,
      application,
      profile,
      calendarBusy: [...blocks, { ...slot, label: "Private conflict" }],
      now: new Date("2030-08-10T12:00:00.000Z"),
      runBoundedAI: async (input) => {
        context = JSON.parse(input.messages[0].content);
        return {
          body: {
            ok: true,
            data: {
              state: "draft_ready",
              timezone: "America/New_York",
              timezoneAssumed: false,
              timezoneNote: "",
              subject: "Re: Interview availability",
              body: "Tuesday at 3:00 PM ET works.",
              round: "recruiter screen",
              contactName: "Avery",
              durationMinutes: 30,
              selectedSlotIndex: null,
              slots: [slot],
              missing: [],
            },
          },
        };
      },
    });

    assert.equal(result.status, "needs_user");
    assert.deepEqual(result.missing, ["conflict-free availability"]);
    assert.equal(result.calendarChecked, true);
    assert.equal(context.calendarBusy.length, history ? 1 : 200);
    assert.ok(context.calendarBusy.every((block) => block.label === "Busy"));
    assert.doesNotMatch(JSON.stringify(context), /Private meeting|Private conflict|2029/);
  });
}

test("scheduling model context retains a recently ended block within the buffer", async () => {
  let context;
  await planSchedulingReply({
    communication,
    application,
    profile,
    calendarBusy: [
      { startIso: "2030-08-10T11:00:00Z", endIso: "2030-08-10T11:45:00Z" },
      { startIso: "2030-08-10T11:45:00Z", endIso: "2030-08-10T11:50:00Z" },
    ],
    now: new Date("2030-08-10T12:00:00Z"),
    runBoundedAI: async (input) => {
      context = JSON.parse(input.messages[0].content);
      return { body: { ok: false } };
    },
  });
  assert.equal(context.calendarBusy.length, 1);
  assert.equal(context.calendarBusy[0].endIso, "2030-08-10T11:50:00Z");
});

for (const rejected of [
  { name: "past", startIso: "2030-08-09T19:00:00Z", endIso: "2030-08-09T19:30:00Z" },
  { name: "invalid", startIso: "invalid", endIso: "invalid" },
]) {
  test(`scheduling reply removes ${rejected.name} slots from its body`, async () => {
    const result = await planSchedulingReply({
      communication,
      application,
      profile,
      now: new Date("2030-08-10T12:00:00Z"),
      runBoundedAI: async () => ({
        body: {
          ok: true,
          data: {
            state: "draft_ready",
            timezone: "America/New_York",
            timezoneAssumed: false,
            timezoneNote: "",
            subject: "Re: Interview availability",
            body: "August 9 at 3 PM ET or August 13 at 3 PM ET works.",
            round: "recruiter screen",
            contactName: "Avery",
            durationMinutes: 30,
            selectedSlotIndex: 1,
            slots: [
              {
                startIso: rejected.startIso,
                endIso: rejected.endIso,
                label: "August 9 at 3 PM ET",
              },
              {
                startIso: "2030-08-13T19:00:00Z",
                endIso: "2030-08-13T19:30:00Z",
                label: "August 13 at 3 PM ET",
              },
            ],
            missing: [],
          },
        },
      }),
    });
    assert.equal(result.status, "ready");
    assert.equal(result.plan.slots.length, 1);
    assert.equal(result.plan.selectedSlotIndex, 0);
    assert.match(result.plan.body, /August 13 at 3 PM ET/);
    assert.doesNotMatch(result.plan.body, /August 9/);
  });
}

for (const proposal of [
  {
    name: "all-past",
    slots: [
      {
        startIso: "2030-08-09T19:00:00Z",
        endIso: "2030-08-09T19:30:00Z",
        label: "August 9 at 3 PM ET",
      },
    ],
  },
  {
    name: "all-invalid",
    slots: [{ startIso: "invalid", endIso: "invalid", label: "August 9 at 3 PM ET" }],
  },
  { name: "originally empty", slots: [] },
]) {
  test(`scheduling link handles ${proposal.name} proposed slots`, async () => {
    const link = "https://calendar.example.test/sam";
    const originalBody = proposal.slots.length
      ? "August 9 at 3 PM ET works for me."
      : `Please choose a time at ${link}.`;
    const result = await planSchedulingReply({
      communication,
      application,
      profile: { ...profile, availability: { ...profile.availability, scheduling_link: link } },
      now: new Date("2030-08-10T12:00:00Z"),
      runBoundedAI: async () => ({
        body: {
          ok: true,
          data: {
            state: "draft_ready",
            timezone: "America/New_York",
            timezoneAssumed: false,
            timezoneNote: "",
            subject: "Re: Interview availability",
            body: originalBody,
            round: "recruiter screen",
            contactName: "Avery",
            durationMinutes: 30,
            selectedSlotIndex: null,
            slots: proposal.slots,
            missing: [],
          },
        },
      }),
    });
    if (proposal.slots.length) {
      assert.equal(result.status, "needs_user");
      assert.deepEqual(result.missing, ["availability"]);
      assert.equal(result.plan, undefined);
    } else {
      assert.equal(result.status, "ready");
      assert.deepEqual(result.plan.slots, []);
      assert.equal(result.plan.body, `${originalBody}\n\nAll times are in America/New_York.`);
    }
  });
}

test("scheduling plan requires confirmation before using an inferred timezone", async () => {
  const result = await planSchedulingReply({
    communication,
    application,
    profile: {
      ...profile,
      availability: { ...profile.availability, timezone: undefined },
    },
    instruction: "Offer Wednesday afternoon.",
    now: new Date("2030-08-10T12:00:00.000Z"),
    runBoundedAI: async () => ({
      body: {
        ok: true,
        data: {
          state: "draft_ready",
          timezone: "America/New_York",
          timezoneAssumed: true,
          timezoneNote: "Inferred from New York, NY.",
          subject: "Re: Interview availability",
          body: "Hi Avery, Wednesday at 2:00 PM ET works for me. Best, Sam",
          round: "recruiter screen",
          contactName: "Avery",
          durationMinutes: 30,
          selectedSlotIndex: null,
          slots: [
            {
              startIso: "2030-08-14T18:00:00.000Z",
              endIso: "2030-08-14T18:30:00.000Z",
              label: "Wed Aug 14, 2:00 PM ET",
            },
          ],
          missing: [],
        },
        ai: { used: true },
      },
    }),
  });

  assert.equal(result.status, "needs_user");
  assert.deepEqual(result.missing, ["timezone confirmation"]);
  assert.match(result.message, /America\/New_York/);
});

test("scheduling hold ICS is dependency-free and escapes recruiter text", () => {
  const hold = buildSchedulingHoldIcs({
    application,
    round: "hiring manager",
    contactName: "Avery, Recruiting",
    startIso: "2030-08-14T18:00:00.000Z",
    endIso: "2030-08-14T18:30:00.000Z",
    now: new Date("2030-08-10T12:00:00.000Z"),
  });

  assert.equal(hold.filename, "temporal-labs-hiring-manager-hold-2030-08-14.ics");
  assert.match(hold.ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(hold.ics, /STATUS:TENTATIVE/);
  assert.match(hold.ics, /DTSTART:20300814T180000Z/);
  assert.match(hold.ics, /Avery\\, Recruiting/);
});
