"use client";

/**
 * Projects shows at most one plan nudge (owner 2026-11-05): Business when
 * the account looks like a business (a company email, business details
 * saved, Business-sized usage), otherwise Pro; the next one shows once
 * that one is dismissed. Plans stay visible early and dismissible.
 */

import type { JSX } from "react";

import { PlansBanner } from "./PlansBanner";
import { TalkToUs, useBusinessNudgeShown } from "./TalkToUs";

export function ProjectsNudge(): JSX.Element | null {
  const business = useBusinessNudgeShown();
  if (business === null) return null;
  return business ? <TalkToUs /> : <PlansBanner />;
}
