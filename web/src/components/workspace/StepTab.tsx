"use client";

/**
 * One paid step as a full workspace page: the shared PageHeader (step title
 * + description + the "ⓘ Tips" trigger) above the step's dedicated panel
 * (Depth / Stereo / Deliver — each owns its own parameters around the
 * shared useStepCheckout machinery), which takes the FULL page width
 * (theater — the output players deserve the room). The About/Tips copy from
 * stepDefs and the "last run" pointer into History live in a shadcn Drawer
 * (vaul) opening from the RIGHT, closed by ×, Escape, or the scrim (all
 * provided by vaul/Radix).
 */

import type { JSX } from "react";

import { DeliverPanel } from "@/components/steps/DeliverPanel";
import { DepthPanel } from "@/components/steps/DepthPanel";
import { StateChip } from "@/components/steps/StateChip";
import { stepDef } from "@/components/steps/stepDefs";
import { StereoPanel } from "@/components/steps/StereoPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import type { Project, Step } from "@/lib/api/types";

import { PageHeader } from "./PageHeader";
import type { WorkspaceTabId } from "./PageTabs";

interface StepPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

const PANELS: Record<Step, (props: StepPanelProps) => JSX.Element> = {
  depth_preview: DepthPanel,
  stereo_preview: StereoPanel,
  production: DeliverPanel,
};

function TipsCard({ title, items }: { title: string; items: string[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-fg-muted">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export interface StepTabProps {
  step: Step;
  project: Project;
  onProjectChanged: () => void;
  onNavigate: (tab: WorkspaceTabId) => void;
}

export function StepTab({
  step,
  project,
  onProjectChanged,
  onNavigate,
}: StepTabProps): JSX.Element {
  const def = stepDef(step);
  const Panel = PANELS[step];
  const lastRun = [...(project.conversions ?? [])]
    .filter((c) => c.step === step)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];

  return (
    <div data-testid={`step-tab-${step}`} className="flex flex-col gap-3">
      <PageHeader
        title={def.title}
        description={def.description}
        actions={
          <Drawer direction="right">
            <DrawerTrigger asChild>
              <Button variant="outline" size="xs" data-testid="step-info-button">
                ⓘ Tips
              </Button>
            </DrawerTrigger>
            <DrawerContent
              data-testid="step-info-drawer"
              aria-label={`${def.title} — what you get and tips`}
              aria-describedby={undefined}
              className="data-[vaul-drawer-direction=right]:w-96 data-[vaul-drawer-direction=right]:max-w-[90vw] data-[vaul-drawer-direction=right]:sm:max-w-[90vw]"
            >
              <DrawerHeader className="flex-row items-center justify-between">
                <DrawerTitle className="text-sm font-semibold">
                  {def.title}
                </DrawerTitle>
                <DrawerClose asChild>
                  <Button variant="ghost" size="xs" aria-label="Close tips">
                    ×
                  </Button>
                </DrawerClose>
              </DrawerHeader>

              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {lastRun ? (
                  <Card size="sm">
                    <CardContent className="flex items-center gap-2 text-xs">
                      <span className="text-fg-muted">Last run</span>
                      <StateChip state={lastRun.state} />
                      <time
                        dateTime={lastRun.created_at}
                        className="text-fg-muted"
                      >
                        {new Date(lastRun.created_at).toLocaleString()}
                      </time>
                      <Button
                        variant="link"
                        size="xs"
                        className="ml-auto"
                        onClick={() => onNavigate("history")}
                      >
                        History →
                      </Button>
                    </CardContent>
                  </Card>
                ) : null}

                <TipsCard title="What you get" items={def.outputs} />
                <TipsCard title="Tips" items={def.tips} />
              </div>
            </DrawerContent>
          </Drawer>
        }
      />

      <div className="min-w-0">
        <Panel project={project} onProjectChanged={onProjectChanged} />
      </div>
    </div>
  );
}
