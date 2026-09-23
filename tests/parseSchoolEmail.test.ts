import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isBroadcast,
  parseSchoolEmail,
  summariseWithheld,
  trimEmailBoilerplate,
  type EmailMessage,
} from "../src/shared/parseSchoolEmail.js";

// Synthetic, but each message mirrors a real one from the inbox this was built
// against — including the cases that exposed bugs.
const FIXTURE = readFileSync(
  path.resolve(import.meta.dirname, "fixtures/school-email.json"),
  "utf-8",
);

const BASE: EmailMessage = {
  subject: "Field trip Friday",
  date: "2026-09-18T14:00:00.000Z",
  fromDomain: "example-school.net",
  body: "Please return the permission slip.",
  recipientCount: 1,
  hasListHeaders: false,
  bulkPrecedence: false,
  undisclosedRecipients: false,
};

const OPTS = {
  timeZone: "America/New_York",
  extraNames: ["Childname"],
  bulkDomains: ["example-mail.com"],
};

describe("isBroadcast", () => {
  it("treats no visible recipients as a BCC broadcast", () => {
    // How a teacher mails the whole class: everyone blind-copied.
    expect(isBroadcast({ ...BASE, recipientCount: 0 })).toBe(true);
  });

  it("treats a single addressee as not a broadcast", () => {
    expect(isBroadcast({ ...BASE, recipientCount: 1 })).toBe(false);
  });

  it("treats two addressees as not a broadcast", () => {
    expect(isBroadcast({ ...BASE, recipientCount: 2 })).toBe(false);
  });

  it("treats three or more addressees as a broadcast", () => {
    expect(isBroadcast({ ...BASE, recipientCount: 3 })).toBe(true);
  });

  it("recognises a mass-mail sending domain even when individually addressed", () => {
    // Mass-mail systems address each copy to one person, which is why there is
    // no "sole recipient means direct" rule — it rejected every school broadcast.
    expect(
      isBroadcast({ ...BASE, fromDomain: "mass.example-mail.com" }, ["example-mail.com"]),
    ).toBe(true);
  });

  it("recognises list headers and bulk precedence", () => {
    expect(isBroadcast({ ...BASE, hasListHeaders: true })).toBe(true);
    expect(isBroadcast({ ...BASE, bulkPrecedence: true })).toBe(true);
    expect(isBroadcast({ ...BASE, undisclosedRecipients: true })).toBe(true);
  });
});

describe("trimEmailBoilerplate", () => {
  it("cuts at a signature separator", () => {
    expect(trimEmailBoilerplate("Real content.\n--\nMrs. Example")).toBe("Real content.");
  });

  it("cuts at a confidentiality disclaimer", () => {
    expect(
      trimEmailBoilerplate("Real content.\nThis email and any attachments are confidential."),
    ).toBe("Real content.");
  });

  it("leaves a body with no footer alone", () => {
    expect(trimEmailBoilerplate("Just the content.")).toBe("Just the content.");
  });
});

describe("parseSchoolEmail — a teacher who sends both broadcasts and replies", () => {
  const { events, withheld } = parseSchoolEmail(FIXTURE, OPTS);
  const titles = events.map((e) => e.title);

  it("publishes the BCC'd class broadcast", () => {
    expect(titles).toContain("Next Week: 9/21-9/25");
  });

  it("withholds a reply addressed to one family", () => {
    expect(titles).not.toContain("Re: Missing math homework");
    expect(withheld["not-broadcast"]).toBeGreaterThan(0);
  });

  it("withholds anything naming the child, rather than publishing it redacted", () => {
    // Redacting would yield "Q1 Conference Invite", which reads like a class
    // notice but was written to one family.
    expect(titles.join(" ")).not.toMatch(/Conference Invite/);
    expect(titles.join(" ")).not.toMatch(/Childname/);
  });

  it("strips the footer from what it publishes", () => {
    const post = events.find((e) => e.title === "Next Week: 9/21-9/25");
    expect(post?.description).toContain("view the newsletter each week");
    expect(post?.description).not.toMatch(/confidential/i);
    expect(post?.description).not.toMatch(/Mrs\. Example/);
  });

  it("publishes a message with many addressees", () => {
    expect(titles).toContain("PTA meeting Thursday");
  });

  it("withholds a broadcast with nothing school-related in it", () => {
    expect(titles).not.toContain("Weekend plans");
    expect(withheld["not-school-related"]).toBeGreaterThan(0);
  });
});

describe("parseSchoolEmail — billing is never published", () => {
  const { events, withheld } = parseSchoolEmail(FIXTURE, OPTS);
  const titles = events.map((e) => e.title);

  it("withholds a billing subject", () => {
    expect(titles).not.toContain("September tuition statement");
  });

  it("withholds invoice wording in the body even when the subject looks innocent", () => {
    // "Payment reminder" also mentions a field trip, so relevance alone would
    // have let it through.
    expect(titles).not.toContain("Payment reminder");
    expect(withheld.billing).toBeGreaterThanOrEqual(2);
  });
});

describe("parseSchoolEmail — announcement-only channels", () => {
  it("publishes a newsletter that is indistinguishable from direct mail by headers", () => {
    // Regression: individually addressed, same domain a teacher uses for private
    // replies, so per-message detection cannot see it is a broadcast.
    const { events } = parseSchoolEmail(FIXTURE, { ...OPTS, broadcastChannel: true });
    expect(events.map((e) => e.title)).toContain("Inside the Spark | School Newsletter");
  });

  it("does not mistake a mentioned fee for billing", () => {
    // Regression: a bare "$" match rejected the school's own newsletter, which
    // mentions a $10 field trip fee and a PTA fundraiser.
    const { events } = parseSchoolEmail(FIXTURE, { ...OPTS, broadcastChannel: true });
    const newsletter = events.find((e) => /Inside the Spark/.test(e.title));
    expect(newsletter?.description).toContain("$10");
  });

  it("does not require keywords on an announcement channel", () => {
    // Regression: "Extended Care Location Change For Today" and "Chapel Chats"
    // were dropped as not-school-related by a keyword gate.
    const { events } = parseSchoolEmail(FIXTURE, { ...OPTS, broadcastChannel: true });
    expect(events.map((e) => e.title)).toContain("Weekend plans");
  });

  it("still withholds billing and child-named mail on such a channel", () => {
    const { events } = parseSchoolEmail(FIXTURE, { ...OPTS, broadcastChannel: true });
    const titles = events.map((e) => e.title).join(" ");
    expect(titles).not.toMatch(/tuition|Payment reminder|Childname|Conference Invite/);
  });
});

describe("parseSchoolEmail — output shape", () => {
  const { events } = parseSchoolEmail(FIXTURE, OPTS);

  it("sorts newest first and keeps the arrival instant", () => {
    const received = events.map((e) => e.received_at ?? "");
    expect([...received].sort((a, b) => b.localeCompare(a))).toEqual(received);
  });

  it("files everything as an announcement", () => {
    expect(events.every((e) => e.category === "announcement")).toBe(true);
  });

  it("returns nothing for a malformed payload instead of throwing", () => {
    expect(parseSchoolEmail("not json", OPTS).events).toEqual([]);
  });
});

describe("summariseWithheld", () => {
  it("lists only non-zero reasons", () => {
    const { withheld } = parseSchoolEmail(FIXTURE, OPTS);
    const summary = summariseWithheld(withheld);
    expect(summary).toMatch(/not-broadcast/);
    expect(summary).not.toMatch(/\b0 /);
  });
});
