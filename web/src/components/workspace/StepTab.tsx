"use client";

/**
 * One paid step as a full workspace page: the shared PageHeader (step title
 * + description + the "ⓘ Tips" trigger) above the step's dedicated panel
 * (Classic: Depth / Stereo / Deliver; Lifelike: Preview / Deliver — the
 * project's method picks the set; each owns its own parameters around the
 * shared useStepCheckout machinery), which takes the FULL page width
 * (theater — the output players deserve the room). The About/Tips copy from
 * stepDefs and the "last run" pointer into History live in a shadcn Drawer
 * (vaul) opening from the RIGHT, closed by ×, Escape, or the scrim (all
 * provided by vaul/Radix).
 */

import type { JSX } from "react";

import { DeliverPanel } from "@/components/steps/DeliverPanel";
import { DepthPanel } from "@/components/steps/DepthPanel";
import { LifelikeDeliverPanel } from "@/components/steps/LifelikeDeliverPanel";
import { LifelikePreviewPanel } from "@/components/steps/LifelikePreviewPanel";
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
import {
  conversionMethod,
  methodOf,
  type Method,
  type Project,
  type Step,
} from "@/lib/api/types";
import { useT } from "@/lib/i18n/I18nProvider";

import { PageHeader } from "./PageHeader";
import type { WorkspaceTabId } from "./PageTabs";

interface StepPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

type Panel = (props: StepPanelProps) => JSX.Element;

const PANELS: Record<Method, Partial<Record<Step, Panel>>> = {
  classic: {
    depth_preview: DepthPanel,
    stereo_preview: StereoPanel,
    production: DeliverPanel,
  },
  lifelike: {
    lifelike_preview: LifelikePreviewPanel,
    production: LifelikeDeliverPanel,
  },
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
        <ul className="flex list-disc flex-col gap-1.5 ps-4 text-xs text-fg-muted">
          {items.map((item) => (
            <li key={item}>{item}</li>
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
  const t = useT();
  const method = methodOf(project);
  const def = stepDef(step, method, t);
  const Panel = PANELS[method][step];
  if (Panel === undefined) throw new Error(`no ${method} panel for ${step}`);
  // The last run of this step with this method (a project may have runs
  // from before a switch).
  const lastRun = [...(project.conversions ?? [])]
    .filter(
      (c) => c.step === step && conversionMethod(c) === method,
    )
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
                {t("workspace.stepTab.tips")}
              </Button>
            </DrawerTrigger>
            <DrawerContent
              data-testid="step-info-drawer"
              aria-label={t("workspace.stepTab.drawerLabel", { title: def.title })}
              aria-describedby={undefined}
              className="data-[vaul-drawer-direction=right]:w-96 data-[vaul-drawer-direction=right]:max-w-[90vw] data-[vaul-drawer-direction=right]:sm:max-w-[90vw]"
            >
              <DrawerHeader className="flex-row items-center justify-between">
                <DrawerTitle className="text-sm font-semibold">
                  {def.title}
                </DrawerTitle>
                <DrawerClose asChild>
                  <Button variant="ghost" size="xs" aria-label={t("workspace.stepTab.close")}>
                    ×
                  </Button>
                </DrawerClose>
              </DrawerHeader>

              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {lastRun ? (
                  <Card size="sm">
                    <CardContent className="flex items-center gap-2 text-xs">
                      <span className="text-fg-muted">{t("workspace.stepTab.lastRun")}</span>
                      <StateChip conversion={lastRun} />
                      <time
                        dateTime={lastRun.created_at}
                        className="text-fg-muted"
                      >
                        {new Date(lastRun.created_at).toLocaleString(t.intl)}
                      </time>
                      <Button
                        variant="link"
                        size="xs"
                        className="ms-auto"
                        onClick={() => onNavigate("files")}
                      >
                        {t("workspace.stepTab.files")}
                      </Button>
                    </CardContent>
                  </Card>
                ) : null}

                <TipsCard title={t("workspace.stepTab.whatYouGet")} items={def.outputs} />
                <TipsCard title={t("workspace.stepTab.tipsTitle")} items={def.tips} />
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
