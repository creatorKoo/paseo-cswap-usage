import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listUsage, type UsageAccount, type UsageSpend, type UsageWindow } from "./contract";

const POLL_INTERVAL_MS = 60_000;

type Locale = "ko" | "en";

type StringTable = {
  loading: string;
  noAccounts: string;
  noUsage: string;
  estimate: (pct: number) => string;
  exhaust: string;
  updated: (time: string) => string;
  refresh: string;
  refreshHint: string;
  refreshLabel: string;
  rpcFailed: (message: string) => string;
  smaller: string;
  larger: string;
};

const STRINGS: Record<Locale, StringTable> = {
  ko: {
    loading: "불러오는 중…",
    noAccounts: "계정이 없습니다",
    noUsage: "사용량 없음",
    estimate: (pct) => `예상 ${pct}%`,
    exhaust: "소진 예상",
    updated: (time) => `갱신 ${time} · 60초마다`,
    refresh: "새로고침",
    refreshHint: "60초 이내면 캐시된 값이 옵니다",
    refreshLabel: "cswap 사용량 새로고침",
    rpcFailed: (message) => `usage.list 호출 실패: ${message}`,
    smaller: "글자 작게",
    larger: "글자 크게",
  },
  en: {
    loading: "Loading…",
    noAccounts: "No accounts",
    noUsage: "no usage",
    estimate: (pct) => `est. ${pct}%`,
    exhaust: "will run out",
    updated: (time) => `updated ${time} · every 60s`,
    refresh: "Refresh",
    refreshHint: "Within 60s you get the cached value",
    refreshLabel: "Refresh cswap usage",
    rpcFailed: (message) => `usage.list failed: ${message}`,
    smaller: "Smaller text",
    larger: "Larger text",
  },
};

/** Korean for Korean systems, English everywhere else. Intl access is guarded: Hermes
 *  builds without full ICU can throw here, and a missing locale must not blank the panel. */
function detectLocale(): Locale {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale.toLowerCase().startsWith("ko") ? "ko" : "en";
  } catch {
    return "en";
  }
}

const strings = STRINGS[detectLocale()];

type PluginThemeProp = PluginWorkspacePanelProps["theme"];

const SIZE_STEPS = ["S", "M", "L"] as const;
type SizeStep = (typeof SIZE_STEPS)[number];

const SIZE_SPECS: Record<SizeStep, { font: number; barWidth: number; padH: number; padV: number }> =
  {
    S: { font: 11, barWidth: 36, padH: 8, padV: 4 },
    M: { font: 12.5, barWidth: 44, padH: 10, padV: 6 },
    L: { font: 14, barWidth: 56, padH: 12, padV: 8 },
  };

/** One indivisible unit of the account line. Wrapping happens between chips, never inside one. */
type Chip = {
  key: string;
  label: string;
  pct: number;
  /** Countdown or spend amounts. Empty when the window has not opened yet. */
  detail: string;
  projection: { text: string; warn: boolean } | null;
};

function formatMoney(amount: number, currency: string): string {
  return currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

function spendDetail(spend: UsageSpend): string {
  return `${formatMoney(spend.used, spend.currency)}/${formatMoney(spend.limit, spend.currency)}`;
}

/**
 * Linear projection of where this window lands by its reset.
 *
 * cswap's `expectedPct` is how far the window has elapsed, not a usage forecast, so
 * `pct / expectedPct` extrapolates the current burn rate to the full window. This is a
 * rough estimate — bursty usage skews it badly, which is why cswap omits it from its own
 * human-facing output. Shown here at the user's explicit request (PLAN.md 8.3).
 */
function projectionFor(window: UsageWindow): { text: string; warn: boolean } | null {
  const expected = window.expectedPct;
  if (expected === undefined || expected <= 0) return null;
  const projected = (window.pct / expected) * 100;
  if (projected < 100) return { text: strings.estimate(Math.round(projected)), warn: false };
  // Already at the ceiling: an exhaustion warning would just restate the bar.
  if (window.pct >= 100) return null;
  return { text: strings.exhaust, warn: true };
}

function chipsFor(usage: NonNullable<UsageAccount["usage"]>): Chip[] {
  const chips: Chip[] = [];
  if (usage.spend !== undefined) {
    chips.push({
      key: "spend",
      label: "$",
      pct: usage.spend.pct,
      detail: spendDetail(usage.spend),
      projection: null,
    });
  }
  if (usage.fiveHour !== undefined) {
    chips.push({
      key: "fiveHour",
      label: "5h",
      pct: usage.fiveHour.pct,
      detail: usage.fiveHour.countdown ?? "",
      projection: null,
    });
  }
  if (usage.sevenDay !== undefined) {
    chips.push({
      key: "sevenDay",
      label: "7d",
      pct: usage.sevenDay.pct,
      detail: usage.sevenDay.countdown ?? "",
      projection: projectionFor(usage.sevenDay),
    });
  }
  for (const [index, scoped] of (usage.scoped ?? []).entries()) {
    chips.push({
      key: `scoped-${index}-${scoped.name}`,
      label: scoped.name,
      pct: scoped.pct,
      detail: scoped.countdown ?? "",
      projection: projectionFor(scoped),
    });
  }
  return chips;
}

function clockTime(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

type Styles = ReturnType<typeof useStyles>;

function useStyles(theme: PluginThemeProp, step: SizeStep) {
  return useMemo(() => {
    const { font, barWidth, padH, padV } = SIZE_SPECS[step];
    const barHeight = Math.round(font / 2);
    return {
      barWidth,
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { paddingVertical: padV },
      // No fixed widths anywhere below: every label sizes to its own content so nothing clips.
      accountRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingHorizontal: padH,
        paddingVertical: padV,
      },
      accountDivider: { borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        flexShrink: 0 as const,
      },
      headerChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        flexShrink: 1 as const,
      },
      alias: {
        color: theme.colors.foreground,
        fontSize: font + 1,
        fontWeight: "700" as const,
        flexShrink: 0 as const,
      },
      email: { color: theme.colors.foregroundMuted, fontSize: font, flexShrink: 1 as const },
      badge: {
        backgroundColor: theme.colors.accent,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        flexShrink: 0 as const,
      },
      badgeText: { color: theme.colors.accentForeground, fontSize: font - 1 },
      label: { color: theme.colors.foregroundMuted, fontSize: font },
      pct: { color: theme.colors.foreground, fontSize: font },
      detail: { color: theme.colors.foregroundMuted, fontSize: font },
      projection: { color: theme.colors.foregroundMuted, fontSize: font },
      projectionWarn: { color: theme.colors.statusWarning, fontSize: font },
      track: {
        width: barWidth,
        height: barHeight,
        borderRadius: barHeight / 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      status: { color: theme.colors.statusWarning, fontSize: font },
      muted: { color: theme.colors.foregroundMuted, fontSize: font },
      danger: { color: theme.colors.statusDanger, fontSize: font },
      message: { paddingHorizontal: padH, paddingVertical: padV },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        paddingHorizontal: padH,
        paddingVertical: padV,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      footerActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        marginLeft: "auto" as const,
      },
      button: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      buttonText: { color: theme.colors.foreground, fontSize: font },
      buttonTextDisabled: { color: theme.colors.foregroundMuted, fontSize: font },
    };
  }, [theme, step]);
}

function barColor(theme: PluginThemeProp, pct: number): string {
  if (pct < 50) return theme.colors.accent;
  if (pct < 90) return theme.colors.statusWarning;
  return theme.colors.statusDanger;
}

function UsageChip({ chip, styles, theme }: { chip: Chip; styles: Styles; theme: PluginThemeProp }) {
  const width = `${Math.max(0, Math.min(chip.pct, 100))}%` as const;
  return (
    <View style={styles.chip}>
      <Text style={styles.label}>{chip.label}</Text>
      <View style={styles.track}>
        <View style={{ width, height: "100%", backgroundColor: barColor(theme, chip.pct) }} />
      </View>
      <Text style={styles.pct}>{`${Math.round(chip.pct)}%`}</Text>
      {chip.detail === "" ? null : <Text style={styles.detail}>{chip.detail}</Text>}
      {chip.projection === null ? null : (
        <Text style={chip.projection.warn ? styles.projectionWarn : styles.projection}>
          {chip.detail === "" ? chip.projection.text : `· ${chip.projection.text}`}
        </Text>
      )}
    </View>
  );
}

function AccountLine({
  account,
  styles,
  theme,
  divider,
}: {
  account: UsageAccount;
  styles: Styles;
  theme: PluginThemeProp;
  divider: boolean;
}) {
  const usage = account.usage;
  // A non-ok status is recomputed on every cswap pass and is never persisted, so it is the
  // whole reason this plugin shells out instead of reading cswap's cache file. It must stay
  // visible. An "ok" account with no usage block is merely empty, not broken.
  const degraded = account.usageStatus !== "ok";
  const chips = usage === undefined ? [] : chipsFor(usage);
  return (
    <View style={divider ? [styles.accountRow, styles.accountDivider] : styles.accountRow}>
      <View style={styles.headerChip}>
        <Text style={styles.alias}>{account.alias ?? `#${account.number}`}</Text>
        <Text style={styles.email}>{account.email ?? ""}</Text>
        {account.active ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>active</Text>
          </View>
        ) : null}
      </View>
      {degraded ? (
        <Text style={styles.status}>{account.usageStatus}</Text>
      ) : chips.length === 0 ? (
        <Text style={styles.muted}>{strings.noUsage}</Text>
      ) : (
        chips.map((chip) => (
          <UsageChip key={chip.key} chip={chip} styles={styles} theme={theme} />
        ))
      )}
    </View>
  );
}

function StepButton({
  label,
  hint,
  disabled,
  styles,
  onPress,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  styles: Styles;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.button}
    >
      <Text style={disabled ? styles.buttonTextDisabled : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function UsagePanel({ theme }: PluginWorkspacePanelProps) {
  // Always starts at the smallest step: the panel is meant to sit in a split pane.
  // There is no plugin storage API, so it resets to S when the panel reopens.
  const [step, setStep] = useState<SizeStep>("S");
  const styles = useStyles(theme, step);
  const list = useRpc(listUsage);
  const usage = useQuery({
    queryKey: ["cswap-usage", "list"],
    queryFn: () => list({}),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS - 5_000,
  });

  const accounts = usage.data?.accounts ?? [];
  // A transport failure (plugin subprocess crash, closed session) never reaches the daemon
  // handler, so `data.error` stays null and only the query knows. It is also the most recent
  // failure, so it wins over a stale handler-side message.
  const transportError =
    usage.error === null ? null : strings.rpcFailed(usage.error.message);
  const error = transportError ?? usage.data?.error ?? null;
  const stepIndex = SIZE_STEPS.indexOf(step);

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {usage.isPending ? (
          <View style={styles.message}>
            <Text style={styles.muted}>{strings.loading}</Text>
          </View>
        ) : accounts.length === 0 ? (
          <View style={styles.message}>
            <Text style={error === null ? styles.muted : styles.danger}>
              {error ?? strings.noAccounts}
            </Text>
          </View>
        ) : (
          accounts.map((account, index) => (
            <AccountLine
              key={account.number}
              account={account}
              styles={styles}
              theme={theme}
              divider={index < accounts.length - 1}
            />
          ))
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.muted}>{strings.updated(clockTime(usage.data?.fetchedAt ?? null))}</Text>
        {accounts.length > 0 && error !== null ? <Text style={styles.danger}>{error}</Text> : null}
        <View style={styles.footerActions}>
          <StepButton
            label="A−"
            hint={strings.smaller}
            disabled={stepIndex <= 0}
            styles={styles}
            onPress={() => {
              const next = SIZE_STEPS[stepIndex - 1];
              if (next !== undefined) setStep(next);
            }}
          />
          <StepButton
            label="A+"
            hint={strings.larger}
            disabled={stepIndex >= SIZE_STEPS.length - 1}
            styles={styles}
            onPress={() => {
              const next = SIZE_STEPS[stepIndex + 1];
              if (next !== undefined) setStep(next);
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.refreshLabel}
            accessibilityHint={strings.refreshHint}
            onPress={() => {
              void usage.refetch();
            }}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{strings.refresh}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
