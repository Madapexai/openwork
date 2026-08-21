/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight, RefreshCw, Search, Sparkles, Star, X } from "lucide-react";
import { useNavigate } from "react-router";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import {
  addCliAgentOptionalModel,
  cliModelMatches,
  deleteCliAgentOptionalModel,
  getCliAgentSupportedModels,
  isCliModelOptional,
} from "./cli-agent-model-store";
import { readDenSettings } from "@/app/lib/den";
import { modelEquals, resolveProviderDisplayName } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { isRecommendedModel } from "../../../../app/defaults";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { usePlatform } from "../../../kernel/platform";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  useOpenWorkModelsPromoEligibility,
  isOpenWorkModelsPromoHidden,
  OPENWORK_MODELS_PROVIDER_ID,
  OPENWORK_MODELS_PROVIDER_NAME,
  openWorkModelsPromoChangedEvent,
} from "../../cloud/openwork-models-promo";

export const MODEL_PICKER_DEFAULT_SUBTITLE = "Select a model for this session.";
export const MODEL_PICKER_UNAVAILABLE_SUBTITLE = "The model you were using is no longer available, please select a different model for this session.";

export function resolveModelPickerSubtitle(subtitle: string | undefined) {
  return subtitle ?? MODEL_PICKER_DEFAULT_SUBTITLE;
}

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  disabledProviders?: string[];
  organizationModelsEmpty?: boolean;
  organizationModelsSettingsUrl?: string;
  query: string;
  setQuery: (value: string) => void;
  subtitle?: string;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  /** Den entitlement present; used to avoid a false Subscribe CTA while models sync. */
  openWorkModelsEntitled?: boolean;
  /** The server is waiting to reload this workspace with OpenWork Models. */
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  restrictToCloud?: boolean;
  /** Active CLI agent (e.g. "kimi"). When set, the picker prioritizes that
   *  agent's supported models and confirms before registering an unsupported
   *  model as an optional model for it. */
  agentId?: string | null;
  /** The selected CLI agent's built-in default model (Agent.model). */
  agentDefaultModel?: ModelRef | null;
};

type ProviderGroup = {
  id: string;
  name: string;
  isNew: boolean;
  isCloud: boolean;
  isDisabled: boolean;
  hasCurrent: boolean;
  recommended: ModelOption[];
  other: ModelOption[];
};

export type ModelPickerEmptyState = {
  messageKey: string;
  showConnectProvider: boolean;
  showRefreshOrganizationModels: boolean;
  showOrganizationModelsSettings: boolean;
};

export function resolveModelPickerEmptyState(input: {
  providerGroupCount: number;
  query: string;
  organizationModelsEmpty: boolean;
  restrictToCloud: boolean;
  organizationModelsSettingsUrl?: string;
}): ModelPickerEmptyState | null {
  if (input.providerGroupCount > 0) return null;
  if (input.query.trim()) {
    return {
      messageKey: "models.no_models_match_search",
      showConnectProvider: false,
      showRefreshOrganizationModels: false,
      showOrganizationModelsSettings: false,
    };
  }
  if (input.organizationModelsEmpty) {
    return {
      messageKey: "models.organization_models_empty",
      showConnectProvider: false,
      showRefreshOrganizationModels: true,
      showOrganizationModelsSettings: Boolean(input.organizationModelsSettingsUrl),
    };
  }
  return {
    messageKey: "models.no_models_available",
    showConnectProvider: !input.restrictToCloud,
    showRefreshOrganizationModels: false,
    showOrganizationModelsSettings: false,
  };
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [promoHidden, setPromoHidden] = useState(isOpenWorkModelsPromoHidden);
  const [refreshingOrganizationModels, setRefreshingOrganizationModels] = useState(false);
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const platform = usePlatform();
  const openWorkModelsPromoEligible = useOpenWorkModelsPromoEligibility();
  const organizationModelsSettingsUrl = props.organizationModelsSettingsUrl;
  const organizationProviderLabel = useMemo(
    () => readDenSettings().activeOrgName?.trim() || t("settings.provider_source_organization"),
    [denAuth.status],
  );

  const disabledSet = useMemo(
    () => new Set(props.disabledProviders ?? []),
    [props.disabledProviders],
  );

  /* ---- CLI-agent-aware model support ---- */
  const hasAgentContext = Boolean(props.agentId);
  const agentLabel = useMemo(
    () => (props.agentId ? props.agentId.charAt(0).toUpperCase() + props.agentId.slice(1) : ""),
    [props.agentId],
  );
  const [, forceStoreRefresh] = useState(0);
  // The set of models this CLI agent can currently run: its built-in default
  // plus any optional models the user has registered via this dialog.
  const supportedRefs = useMemo<ModelRef[]>(() => {
    void forceStoreRefresh;
    return props.agentId ? getCliAgentSupportedModels(props.agentId, props.agentDefaultModel ?? undefined) : [];
  }, [props.agentId, props.agentDefaultModel, forceStoreRefresh]);
  const supportedSet = useMemo(
    () => new Set(supportedRefs.map((m) => `${m.providerID}/${m.modelID}`)),
    [supportedRefs],
  );
  const isModelSupported = useCallback(
    (providerID: string, modelID: string) => supportedSet.has(`${providerID}/${modelID}`),
    [supportedSet],
  );

  // Two-view picker: provider perspective (grouped) vs model perspective
  // (flat). Only surfaced when a CLI agent is active, otherwise the classic
  // single provider-grouped view is kept.
  const [view, setView] = useState<"provider" | "model">("provider");
  const [confirmModel, setConfirmModel] = useState<ModelOption | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelRef | null>(null);

  // Filter by search (declared before the agent-aware memos that consume it)
  const filteredOptions = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(
      (o) =>
        o.title.toLowerCase().includes(q) ||
        o.providerID.toLowerCase().includes(q) ||
        o.modelID.toLowerCase().includes(q) ||
        (o.description ?? "").toLowerCase().includes(q),
    );
  }, [props.options, props.query]);

  // Synthesize ModelOption entries for the CLI agent's supported models so
  // they show up even when their provider is not (yet) a connected source.
  const agentSupportedOptions = useMemo<ModelOption[]>(() => {
    if (!hasAgentContext) return [];
    const byKey = new Map<string, ModelOption>();
    for (const opt of filteredOptions) byKey.set(`${opt.providerID}/${opt.modelID}`, opt);
    return supportedRefs
      .map((ref) => {
        const existing = byKey.get(`${ref.providerID}/${ref.modelID}`);
        if (existing) return existing;
        return {
          providerID: ref.providerID,
          modelID: ref.modelID,
          title: ref.modelID,
          description: resolveProviderDisplayName(ref.providerID),
          behaviorTitle: "Reasoning",
          behaviorLabel: "Default",
          behaviorDescription: "",
          behaviorValue: null,
          isFree: false,
          isRecommended: false,
        };
      })
      .filter((opt, index, arr) => arr.findIndex((o) => o.providerID === opt.providerID && o.modelID === opt.modelID) === index);
  }, [filteredOptions, hasAgentContext, supportedRefs]);

  // Flat "model view": agent-supported models first, then everything else.
  const modelViewOptions = useMemo<ModelOption[]>(() => {
    if (!hasAgentContext) return filteredOptions;
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const opt of agentSupportedOptions) {
      seen.add(`${opt.providerID}/${opt.modelID}`);
      out.push(opt);
    }
    for (const opt of filteredOptions) {
      const key = `${opt.providerID}/${opt.modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(opt);
    }
    return out;
  }, [agentSupportedOptions, filteredOptions, hasAgentContext]);

  // Selecting a model: supported models (or any model when no CLI agent is
  // active) apply immediately; an unsupported model asks before registering
  // it as an optional model for the active CLI agent.
  const requestSelect = useCallback(
    (opt: ModelOption) => {
      const ref = { providerID: opt.providerID, modelID: opt.modelID };
      if (!hasAgentContext || isModelSupported(opt.providerID, opt.modelID)) {
        props.onSelect(ref);
        return;
      }
      setConfirmModel(opt);
    },
    [hasAgentContext, isModelSupported, props.onSelect],
  );
  const confirmAddOptional = useCallback(() => {
    if (props.agentId && confirmModel) {
      addCliAgentOptionalModel(props.agentId, {
        providerID: confirmModel.providerID,
        modelID: confirmModel.modelID,
      });
      forceStoreRefresh((n) => n + 1);
      props.onSelect({ providerID: confirmModel.providerID, modelID: confirmModel.modelID });
    }
    setConfirmModel(null);
  }, [confirmModel, props]);
  const cancelConfirm = useCallback(() => setConfirmModel(null), []);

  const requestDelete = useCallback((ref: ModelRef) => {
    setDeleteModel(ref);
  }, []);
  const confirmDelete = useCallback(() => {
    if (props.agentId && deleteModel) {
      deleteCliAgentOptionalModel(props.agentId, deleteModel);
      forceStoreRefresh((n) => n + 1);
    }
    setDeleteModel(null);
  }, [deleteModel, props.agentId]);
  const cancelDelete = useCallback(() => setDeleteModel(null), []);

  // Reset on open
  useEffect(() => {
    if (props.open) {
      props.setQuery("");
    }
  }, [props.open]);

  useEffect(() => {
    const handlePromoChanged = () => setPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  // Focus search
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  // Group by provider
  const providerGroups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup>();
    for (const opt of filteredOptions) {
      let group = map.get(opt.providerID);
      if (!group) {
        group = {
          id: opt.providerID,
          name: opt.description ?? resolveProviderDisplayName(opt.providerID),
          isNew: !!opt.isRecommended,
          isCloud: opt.source === "cloud",
          isDisabled: disabledSet.has(opt.providerID),
          hasCurrent: false,
          recommended: [],
          other: [],
        };
        map.set(opt.providerID, group);
      }
      if (isRecommendedModel(opt.modelID)) {
        group.recommended.push(opt);
      } else {
        group.other.push(opt);
      }
      if (modelEquals(props.current, { providerID: opt.providerID, modelID: opt.modelID })) {
        group.hasCurrent = true;
      }
    }
    const groups = [...map.values()];
    for (const group of groups) {
      group.recommended.sort((a, b) => a.title.localeCompare(b.title));
      group.other.sort((a, b) => a.title.localeCompare(b.title));
    }
    const supportedProviders = new Set<string>();
    for (const ref of supportedRefs) supportedProviders.add(ref.providerID);
    return groups.sort((a, b) => {
      if (hasAgentContext) {
        const aSupported = supportedProviders.has(a.id);
        const bSupported = supportedProviders.has(b.id);
        if (aSupported !== bSupported) return aSupported ? -1 : 1;
      }
      if (a.isDisabled !== b.isDisabled) return a.isDisabled ? 1 : -1;
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      if (a.hasCurrent !== b.hasCurrent) return a.hasCurrent ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredOptions, props.current, disabledSet, hasAgentContext, supportedRefs]);

  // Auto-expand on search
  useEffect(() => {
    if (props.query.trim()) {
      setExpandedProviders(new Set(providerGroups.map((g) => g.id)));
    }
  }, [props.query, providerGroups]);

  // Expand current, organization-provided, and OpenWork groups once they appear
  // (options often load async).
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!props.open) {
      autoExpandedRef.current = new Set();
      return;
    }
    const toExpand: string[] = [];
    const queueExpand = (id: string) => {
      if (!autoExpandedRef.current.has(id) && !toExpand.includes(id)) toExpand.push(id);
    };
    const current = providerGroups.find((group) => group.hasCurrent);
    if (current) queueExpand(current.id);
    for (const group of providerGroups) {
      if (group.isCloud) queueExpand(group.id);
    }
    const openwork = providerGroups.find((group) => group.id === OPENWORK_MODELS_PROVIDER_ID);
    if (openwork) queueExpand(openwork.id);
    if (toExpand.length === 0) return;
    for (const id of toExpand) autoExpandedRef.current.add(id);
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      for (const id of toExpand) next.add(id);
      return next;
    });
  }, [props.open, providerGroups]);

  const toggleProvider = useCallback((id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const openWorkModelsAvailable = useMemo(
    () => hasOpenWorkModelsProvider(props.options.map((option) => option.providerID)),
    [props.options],
  );
  const showOpenWorkModelsPromo = useMemo(
    () =>
      openWorkModelsPromoEligible &&
      !promoHidden &&
      !openWorkModelsAvailable &&
      !props.openWorkModelsEntitled,
    [openWorkModelsPromoEligible, openWorkModelsAvailable, promoHidden, props.openWorkModelsEntitled],
  );

  const openOpenWorkModels = useCallback(() => {
    props.onClose();
    if (!denAuth.isSignedIn) {
      navigate("/settings/cloud-account");
    }
    window.setTimeout(() => {
      platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
    }, 0);
  }, [denAuth.isSignedIn, navigate, platform, props.onClose]);

  const hideOpenWorkModels = useCallback(() => {
    hideOpenWorkModelsPromo();
    setPromoHidden(true);
  }, []);

  const handleSelect = useCallback(
    (opt: ModelOption) => requestSelect(opt),
    [requestSelect],
  );

  const handleRefreshOrganizationModels = useCallback(async () => {
    if (!props.onRefreshOrganizationModels || refreshingOrganizationModels) return;
    setRefreshingOrganizationModels(true);
    try {
      await props.onRefreshOrganizationModels();
    } finally {
      setRefreshingOrganizationModels(false);
    }
  }, [props.onRefreshOrganizationModels, refreshingOrganizationModels]);

  const emptyState = resolveModelPickerEmptyState({
    providerGroupCount: providerGroups.length,
    query: props.query,
    organizationModelsEmpty: Boolean(props.organizationModelsEmpty),
    restrictToCloud: Boolean(props.restrictToCloud),
    organizationModelsSettingsUrl,
  });

  // Escape
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("models.title")}</DialogTitle>
          <DialogDescription>
            {resolveModelPickerSubtitle(props.subtitle)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Search */}
          <div className="relative mb-4 shrink-0">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              className="h-10 w-full rounded-xl border border-dls-border bg-dls-surface pl-9 pr-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              placeholder={t("models.search_placeholder")}
              value={props.query}
              onChange={(e) => props.setQuery(e.target.value)}
            />
          </div>

          {props.openWorkModelsSyncing ? (
            <div className="mb-3 flex shrink-0 items-center overflow-hidden rounded-2xl border border-amber-6/60 bg-amber-2/40">
              <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
                <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} size={18} className="shrink-0 text-amber-11" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-dls-text">
                    <span>{OPENWORK_MODELS_PROVIDER_NAME}</span>
                  </div>
                  <div className="truncate text-[11px] text-dls-secondary">
                    Included on your plan — pending workspace reload.
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {showOpenWorkModelsPromo ? (
            <div className="mb-3 flex shrink-0 items-center overflow-hidden rounded-2xl border border-blue-6/60 bg-blue-2/60 shadow-[0_12px_30px_-20px_rgba(var(--dls-accent-rgb),0.45)]">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-blue-3/70"
                onClick={openOpenWorkModels}
              >
                <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} size={18} className="shrink-0 text-blue-11" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-dls-text">
                    <Sparkles className="size-3.5 text-blue-11" />
                    <span>{OPENWORK_MODELS_PROVIDER_NAME}</span>
                  </div>
                  <div className="truncate text-[11px] text-dls-secondary">
                    {denAuth.isSignedIn ? "Subscribe to use hosted frontier models in this workspace." : "Sign in to unlock hosted frontier models for your team."}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5 text-[11px] font-medium text-blue-11">
                  {denAuth.isSignedIn ? "Subscribe" : "Sign in"}
                  <ArrowRight className="size-3" />
                </span>
              </button>
              <button
                type="button"
                className="flex size-9 shrink-0 items-center justify-center border-l border-blue-6/60 text-blue-11 transition-colors hover:bg-blue-3/70"
                onClick={hideOpenWorkModels}
                aria-label="Hide OpenWork Models"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}

          {/* Content */}
          <div className="flex min-h-0 flex-1 flex-col">
            {hasAgentContext ? (
              <div className="mb-3 shrink-0">
                <Tabs value={view} onValueChange={(v) => setView(v as "provider" | "model")}>
                  <TabsList className="w-full">
                    <TabsTrigger value="provider" className="flex-1">Providers</TabsTrigger>
                    <TabsTrigger value="model" className="flex-1">Models</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="mt-1.5 px-1 text-[11px] text-dls-secondary">
                  {agentSupportedOptions.length > 0
                    ? `${agentLabel} can run ${agentSupportedOptions.length} model${agentSupportedOptions.length === 1 ? "" : "s"} below.`
                    : `${agentLabel} has no registered models yet. Adding one will make it switchable in ${agentLabel}.`}
                </div>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 -mr-1">
              {emptyState ? (
                <div className="space-y-3 rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center">
                  <div className="text-sm text-dls-secondary">
                    {t(emptyState.messageKey)}
                  </div>
                  {emptyState.showRefreshOrganizationModels ? (
                    <Button variant="outline" onClick={() => void handleRefreshOrganizationModels()} disabled={refreshingOrganizationModels}>
                      <RefreshCw className={`mr-1 size-3 ${refreshingOrganizationModels ? "animate-spin" : ""}`} />
                      {refreshingOrganizationModels ? t("models.refreshing_organization_models") : t("models.refresh_organization_models")}
                    </Button>
                  ) : null}
                  {emptyState.showOrganizationModelsSettings && organizationModelsSettingsUrl ? (
                    <Button variant="ghost" onClick={() => platform.openLink(organizationModelsSettingsUrl)}>
                      {t("models.manage_organization_models")}
                    </Button>
                  ) : null}
                  {emptyState.showConnectProvider ? (
                    <Button variant="outline" onClick={props.onOpenSettings}>
                      {t("models.connect_provider")}
                    </Button>
                  ) : null}
                </div>
              ) : view === "model" && hasAgentContext ? (
                <div className="space-y-1">
                  {modelViewOptions.length === 0 ? (
                    <div className="rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center text-sm text-dls-secondary">
                      {t("models.no_models_match_search")}
                    </div>
                  ) : (
                    modelViewOptions.map((opt) => (
                      <DefaultModelRow
                        key={`${opt.providerID}/${opt.modelID}`}
                        opt={opt}
                        current={props.current}
                        onSelect={handleSelect}
                        supportedLabel={isModelSupported(opt.providerID, opt.modelID) ? agentLabel : undefined}
                        isOptional={Boolean(props.agentId) && isCliModelOptional(props.agentId!, { providerID: opt.providerID, modelID: opt.modelID })}
                        onDelete={props.agentId ? () => requestDelete({ providerID: opt.providerID, modelID: opt.modelID }) : undefined}
                      />
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  {hasAgentContext && agentSupportedOptions.length > 0 ? (
                    <AgentSupportedSection
                      agentLabel={agentLabel}
                      options={agentSupportedOptions}
                      current={props.current}
                      onSelect={handleSelect}
                      agentId={props.agentId ?? undefined}
                      onDeleteModel={requestDelete}
                    />
                  ) : null}
                  {providerGroups.map((group) => (
                    <ProviderAccordion
                      key={group.id}
                      group={group}
                      expanded={expandedProviders.has(group.id)}
                      current={props.current}
                      canToggleProvider={!!props.onToggleProvider}
                      onToggleExpand={() => toggleProvider(group.id)}
                      onToggleProvider={props.onToggleProvider}
                      onSelect={handleSelect}
                      organizationProviderLabel={organizationProviderLabel}
                      supportsAgentLabel={hasAgentContext ? agentLabel : undefined}
                      isModelSupported={isModelSupported}
                      agentId={props.agentId ?? undefined}
                      onDeleteModel={requestDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>
            {t("models.done")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>

      {/* Confirm registering an unsupported model for the active CLI agent. */}
      <AlertDialog open={confirmModel !== null} onOpenChange={(open) => { if (!open) setConfirmModel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add this model to {agentLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmModel?.providerID}/{confirmModel?.modelID}</strong> is not currently supported by the
              {" "}{agentLabel} CLI agent. Add it as an optional model so you can switch to it within {agentLabel}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelConfirm}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmAddOptional}>Add &amp; use</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm removing an optional model from the active CLI agent. */}
      <AlertDialog open={deleteModel !== null} onOpenChange={(open) => { if (!open) setDeleteModel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this model from {agentLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteModel?.providerID}/{deleteModel?.modelID}</strong> will no longer be available within
              {" "}{agentLabel}. You can add it back later from any provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider accordion                                                 */
/* ------------------------------------------------------------------ */

function ProviderAccordion({
  group,
  expanded,
  current,
  canToggleProvider,
  onToggleExpand,
  onToggleProvider,
  onSelect,
  organizationProviderLabel,
  supportsAgentLabel,
  isModelSupported,
  agentId,
  onDeleteModel,
}: {
  group: ProviderGroup;
  expanded: boolean;
  current: ModelRef;
  canToggleProvider: boolean;
  onToggleExpand: () => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onSelect: (opt: ModelOption) => void;
  organizationProviderLabel: string;
  supportsAgentLabel?: string;
  isModelSupported?: (providerID: string, modelID: string) => boolean;
  agentId?: string;
  onDeleteModel?: (ref: ModelRef) => void;
}) {
  const totalModels = group.recommended.length + group.other.length;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const supportedFor = (opt: ModelOption) =>
    supportsAgentLabel && isModelSupported ? isModelSupported(opt.providerID, opt.modelID) : false;

  return (
    <div className={group.isDisabled ? "opacity-50" : ""}>
      {/* Provider header */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
          onClick={onToggleExpand}
        >
          <Chevron size={14} className="shrink-0 text-dls-secondary" />
          <ProviderIcon providerId={group.id} size={18} className="shrink-0 text-dls-text" />
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-medium text-dls-text">{group.name}</span>
            {" "}
            <span className="ml-2 text-[11px] text-dls-secondary">
              {totalModels} model{totalModels === 1 ? "" : "s"}
            </span>
          </div>
          {" "}
          <span className="flex shrink-0 items-center gap-1.5">
            {group.isNew ? (
              <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">New</span>
            ) : null}
            {group.isCloud ? (
              <span className="rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">{organizationProviderLabel}</span>
            ) : null}
            {group.hasCurrent ? (
              <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">Current</span>
            ) : null}
          </span>
        </button>
        {canToggleProvider ? (
          <button
            type="button"
            className={[
              "mr-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
              group.isDisabled
                ? "border border-dls-border text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                : "bg-green-3 text-green-11 hover:bg-green-4",
            ].join(" ")}
            onClick={(e) => { e.stopPropagation(); onToggleProvider?.(group.id, group.isDisabled); }}
            title={group.isDisabled ? "Enable this provider" : "Disable this provider"}
          >
            {group.isDisabled ? "Enable" : "Enabled"}
          </button>
        ) : null}
      </div>

      {/* Models */}
      {expanded && !group.isDisabled ? (
        <div className="ml-9 space-y-0.5 pb-2 pt-0.5">
          {group.recommended.length > 0 ? (
            <>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                Recommended
              </div>
              {group.recommended.map((opt) => (
                <DefaultModelRow
                  key={opt.modelID}
                  opt={opt}
                  current={current}
                  onSelect={onSelect}
                  recommended
                  supported={supportedFor(opt)}
                  supportedLabel={supportsAgentLabel}
                  isOptional={Boolean(agentId) && isCliModelOptional(agentId!, { providerID: opt.providerID, modelID: opt.modelID })}
                  onDelete={onDeleteModel ? () => onDeleteModel({ providerID: opt.providerID, modelID: opt.modelID }) : undefined}
                />
              ))}
            </>
          ) : null}
          {group.other.length > 0 ? (
            <>
              {group.recommended.length > 0 ? (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                  All models
                </div>
              ) : null}
              {group.other.map((opt) => (
                <DefaultModelRow
                  key={opt.modelID}
                  opt={opt}
                  current={current}
                  onSelect={onSelect}
                  supported={supportedFor(opt)}
                  supportedLabel={supportsAgentLabel}
                  isOptional={Boolean(agentId) && isCliModelOptional(agentId!, { providerID: opt.providerID, modelID: opt.modelID })}
                  onDelete={onDeleteModel ? () => onDeleteModel({ providerID: opt.providerID, modelID: opt.modelID }) : undefined}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Default tab: model row (click to select as default)                */
/* ------------------------------------------------------------------ */

function DefaultModelRow({
  opt, current, onSelect, recommended, supported, supportedLabel, isOptional, onDelete,
}: {
  opt: ModelOption; current: ModelRef; onSelect: (opt: ModelOption) => void; recommended?: boolean; supported?: boolean; supportedLabel?: string; isOptional?: boolean; onDelete?: () => void;
}) {
  const active = modelEquals(current, { providerID: opt.providerID, modelID: opt.modelID });

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={[
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
          active ? "bg-green-3/50" : "hover:bg-dls-hover",
        ].join(" ")}
        onClick={() => onSelect(opt)}
      >
        {recommended ? <Star size={12} className="shrink-0 text-amber-9" /> : <div className="w-3 shrink-0" />}
        <div className="min-w-0 flex-1">
          <span className={["text-[12px]", active ? "font-medium text-dls-text" : "text-dls-text"].join(" ")}>{opt.title}</span>
          <span className="ml-2 font-mono text-[10px] text-dls-secondary/60">{opt.modelID}</span>
        </div>
        {supported && supportedLabel ? (
          <span className="shrink-0 rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
            {supportedLabel}
          </span>
        ) : null}
        {isOptional ? (
          <span className="shrink-0 rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
            Optional
          </span>
        ) : null}
        {active ? <Check size={14} className="shrink-0 text-green-11" /> : null}
      </button>
      {onDelete && isOptional ? (
        <button
          type="button"
          aria-label={`Remove ${opt.modelID}`}
          className="shrink-0 rounded-md p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-red-11"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pinned "For <agent>" section: the CLI agent's supported models     */
/* ------------------------------------------------------------------ */

function AgentSupportedSection({
  agentLabel,
  options,
  current,
  onSelect,
  agentId,
  onDeleteModel,
}: {
  agentLabel: string;
  options: ModelOption[];
  current: ModelRef;
  onSelect: (opt: ModelOption) => void;
  agentId?: string;
  onDeleteModel?: (ref: ModelRef) => void;
}) {
  return (
    <div className="rounded-xl border border-green-6/50 bg-green-2/20 px-2 py-1.5">
      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-green-11">
        For {agentLabel}
      </div>
      <div className="space-y-0.5">
        {options.map((opt) => (
          <DefaultModelRow
            key={`${opt.providerID}/${opt.modelID}`}
            opt={opt}
            current={current}
            onSelect={onSelect}
            recommended
            isOptional={Boolean(agentId) && isCliModelOptional(agentId!, { providerID: opt.providerID, modelID: opt.modelID })}
            onDelete={onDeleteModel ? () => onDeleteModel({ providerID: opt.providerID, modelID: opt.modelID }) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
