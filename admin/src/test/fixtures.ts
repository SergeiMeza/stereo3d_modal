import type { CasePage, CasesResponse, DisputeSummary, MailPreviewsResponse } from "../lib/types";

export const casesResponse: CasesResponse = {
  cases: [
    {
      id: "CASE-0051",
      type: "dispute",
      reason: "dispute",
      mode: "manual",
      status: "open",
      opened_at: "2026-11-01T01:00:00Z",
      age_hours: 50,
      email_masked: "m•••@outlook.com",
      uid: "uid_51",
      requested_cents: 2800,
      deadline_at: "2026-11-09T00:00:00Z",
      dispute_due: "2026-11-09T00:00:00Z",
      last_activity_at: "2026-11-03T00:00:00Z",
    },
    {
      id: "CASE-0042",
      type: "refund",
      reason: "partial_failure",
      mode: "manual",
      status: "open",
      opened_at: "2026-11-01T01:20:00Z",
      age_hours: 28,
      email_masked: "j•••@gmail.com",
      uid: "uid_123",
      requested_cents: 1243,
      max_refundable_cents: 4972,
      deadline_at: "2026-11-05T06:00:00Z",
      deadline_red: false,
      last_activity_at: "2026-11-02T00:00:00Z",
    },
  ],
  counts: { open: 7, overdue: 1, due_today: 2 },
};

export function casePage(over: Partial<CasePage> = {}, caseOver: Partial<CasePage["case"]> = {}): CasePage {
  return {
    case: {
      id: "CASE-0042",
      uid: "uid_123",
      customer_id: "cus_1",
      type: "refund",
      reason: "partial_failure",
      mode: "manual",
      source: "system",
      status: "open",
      open: true,
      customer_visible: true,
      related: { conversion_ids: ["c_7Hk2Qm"], pi_ids: ["pi_1"], charge_ids: ["ch_1"] },
      requested_cents: 1243,
      decided_cents: 0,
      currency: "usd",
      evidence_n: 1,
      deadline_at: "2026-11-05T06:00:00Z",
      last_activity_at: "2026-11-02T00:00:00Z",
      opened_at: "2026-11-01T01:20:00Z",
      status_since: "2026-11-01T01:20:00Z",
      customer_text: "<img src=x onerror=alert(1)> please refund https://evil.example",
      ...caseOver,
    },
    runs: [
      {
        conversion_id: "c_7Hk2Qm",
        label: "Kyoto walk · 3D video · 4K",
        state: "SUCCEEDED",
        price_cents: 4972,
        delivered: "partly",
        paid_from: "card",
        refunded_cents: 0,
        refundable_cents: 4972,
      },
    ],
    max_refundable_cents: 4972,
    events: [
      { id: "e1", at: "2026-11-01T01:20:00Z", who: "system", kind: "opened", text: "Opened · partial_failure" },
      { id: "e2", at: "2026-11-02T00:30:00Z", who: "owner@example.com", kind: "note", text: "Part 4 failed." },
    ],
    evidence: {
      n: 1,
      built_at: "2026-11-01T01:20:00Z",
      runs: [
        {
          conversion_id: "c_7Hk2Qm",
          state: "SUCCEEDED",
          created_at: "2026-11-01T00:12:00Z",
          updated_at: "2026-11-01T01:20:00Z",
          captured_cents: 4972,
          parts: 4,
          files_delivered: ["p1.mov", "p2.mov", "p3.mov"],
          job_id: "fc-01",
          gpu_cost_usd: 4.29,
          quality: "high",
          bitrate_requested: "auto",
          outputs_media: {
            mvhevc_part01: { video_kbps: 41200, audio_codec: "aac", audio_kbps: 256, source: "worker" },
            sbs_part01: { video_kbps: 38400, audio_codec: "aac", audio_kbps: 256, source: "ffprobe" },
          },
        },
      ],
      downloads: "not recorded yet: the download and play log (M8) is still to come",
      payments: [],
      refunds: [],
      cases: [],
      links: {
        logs_url: "https://console.cloud.google.com/logs/query;query=x",
        stripe_urls: ["https://dashboard.stripe.com/test/payments/pi_1", "javascript:alert(1)"],
        modal_job_ids: ["fc-01"],
      },
    },
    related_cases: [],
    hints: [],
    banners: [],
    account: { uid: "uid_123", email: "j•••@gmail.com", payment_method: "Visa •••• 4242" },
    refunds: [],
    actions: ["approve", "partial", "deny", "ask", "customer_reply", "mark_out_of_band", "note", "refresh_evidence", "close"],
    ...over,
  };
}

export const mailPreviews: MailPreviewsResponse = {
  mails: [
    { id: "E6", subject: "Stereo3D Studio: we refunded $6.75 (CASE-0042)", text: "We refunded $6.75 for Kyoto walk." },
    { id: "E6 waive", subject: "Stereo3D Studio: we won't charge you $1.00 (CASE-0042)", text: "We removed the $1.00 charge." },
    { id: "E10", subject: "Stereo3D Studio: about your refund request (CASE-0042)", text: "..." },
    { id: "E11", subject: "Stereo3D Studio: a question about your refund (CASE-0042)", text: "..." },
  ],
  deny_templates: {
    delivered: "We checked your 3D video and it was delivered as described, so we can't refund this payment.",
    outside_terms: "This payment is outside our refund terms, so we can't refund it.",
  },
};

export const disputes: DisputeSummary = {
  months: [
    { month: "2026-10", charges: 1000, disputes_activity: 4, disputed_cents_activity: 9000, disputes_by_payment: 3, activity_pct: 0.004, won: 1, lost: 1, accepted: 0, countered: 2, lost_cents: 2000, dispute_fees_cents: 3000, efw: 2, efw_cents: 2500, efw_refunded: 1, efw_became_disputes: 1 },
    { month: "2026-11", charges: 100, disputes_activity: 1, disputed_cents_activity: 2800, disputes_by_payment: 1, activity_pct: 0.01, won: 0, lost: 0, accepted: 0, countered: 0, lost_cents: 0, dispute_fees_cents: 1500, efw: 0, efw_cents: 0, efw_refunded: 0, efw_became_disputes: 0 },
  ],
  reference_pct: 0.0075,
  win_rate: 0.5,
  counter_rate: 0.4,
  open: [{ dispute_id: "dp_1", amount_cents: 2800, reason: "product_not_received", status: "needs_response", payment_intent: "pi_9", due_by: "2026-11-09T00:00:00Z", case_id: "CASE-0051" }],
  by_method: { visa: 3, paypal: 2 },
  by_flow: { after: 4, precharge: 1 },
  by_country: { US: 4, JP: 1 },
  scope: "Stereo3D web charges only (metadata.product=svs-web); card networks measure the whole Stripe account",
  account_wide: "https://dashboard.stripe.com/test/disputes",
  denominator: "successful charges from the gateway's charge records (charges_test)",
  generated_at: "2026-11-03T00:00:00Z",
};
