import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  listUsage,
  type UsageAccount,
  type UsageBlock,
  type UsageSpend,
  type UsageWindow,
} from "./contract";

const POLL_INTERVAL_MS = 60_000;

type Locale = "ko" | "en";

type StringTable = {
  loading: string;
  noAccounts: string;
  noUsage: string;
  lastGood: (time: string) => string;
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
    lastGood: (time) => `마지막 값 ${time}`,
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
    lastGood: (time) => `last value ${time}`,
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

/** One cell of an account row. `column` is the table column the cell belongs to. */
type Chip = {
  key: string;
  /** Column key. Equal to `key`; every account puts this chip in the same column. */
  column: string;
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
 * human-facing output, and why README.md calls it a rough signal.
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
  if (usage.fiveHour !== undefined) {
    chips.push({
      key: "fiveHour",
      column: "fiveHour",
      label: "5h",
      pct: usage.fiveHour.pct,
      detail: usage.fiveHour.countdown ?? "",
      projection: null,
    });
  }
  if (usage.sevenDay !== undefined) {
    chips.push({
      key: "sevenDay",
      column: "sevenDay",
      label: "7d",
      pct: usage.sevenDay.pct,
      detail: usage.sevenDay.countdown ?? "",
      projection: projectionFor(usage.sevenDay),
    });
  }
  // Keyed by name, not position, so the same scoped window lands in the same column on
  // every account. A name repeated inside one account gets its index appended.
  const seenScoped = new Set<string>();
  for (const [index, scoped] of (usage.scoped ?? []).entries()) {
    const column = seenScoped.has(scoped.name)
      ? `scoped:${scoped.name}#${index}`
      : `scoped:${scoped.name}`;
    seenScoped.add(scoped.name);
    chips.push({
      key: column,
      column,
      label: scoped.name,
      pct: scoped.pct,
      detail: scoped.countdown ?? "",
      projection: projectionFor(scoped),
    });
  }
  if (usage.spend !== undefined) {
    chips.push({
      key: "spend",
      column: "spend",
      label: "$",
      pct: usage.spend.pct,
      detail: spendDetail(usage.spend),
      projection: null,
    });
  }
  return chips;
}

/** One table column, sized to the widest text any account actually puts in it. */
type Column = {
  key: string;
  kind: "window" | "spend";
  labelWidth: number;
  detailWidth: number;
  width: number;
};

const CHAR_EM = 0.6;

// Wide (full-width) code point ranges: Hangul, kana, CJK ideographs, full-width forms.
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

/**
 * Rough advance width of a string. React Native offers no synchronous text measurement, so
 * the table sizes itself from this estimate: full-width characters count as a full em,
 * spaces as 0.3em, everything else as 0.6em, plus 0.6em of slack so a slightly wider glyph
 * set does not clip the last character.
 */
function estimateWidth(text: string, font: number): number {
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === " ") em += 0.3;
    else if (WIDE_RANGES.some(([low, high]) => code >= low && code <= high)) em += 1;
    else em += CHAR_EM;
  }
  return Math.round((em + 0.6) * font);
}

/**
 * The columns the whole table needs: 5h, 7d, every scoped window in first-seen order, then
 * spend last. A column exists only when at least one account has that chip, so accounts
 * that lack it leave a blank cell rather than shifting the ones that follow. Each column is
 * only as wide as its own widest label and detail, so a countdown-only column does not
 * inherit the width of the one carrying "· est. 16%".
 */
function columnsFor(
  accounts: UsageAccount[],
  font: number,
  barWidth: number,
  pctWidth: number,
  cellGap: number,
): Column[] {
  const measured = new Map<string, { labelWidth: number; detailWidth: number }>();
  const scoped: string[] = [];
  for (const account of accounts) {
    // A degraded account with no last-good block shows its status string instead of cells,
    // so its windows would only add columns that stay blank on every row.
    const shown = shownUsage(account);
    if (shown === null) continue;
    for (const chip of chipsFor(shown.usage)) {
      const detail = chip.detail + projectionSuffix(chip);
      const labelWidth = estimateWidth(chip.label, font);
      const detailWidth = detail === "" ? 0 : estimateWidth(detail, font);
      const seen = measured.get(chip.column);
      if (seen === undefined) {
        measured.set(chip.column, { labelWidth, detailWidth });
        if (chip.column !== "fiveHour" && chip.column !== "sevenDay" && chip.column !== "spend") {
          scoped.push(chip.column);
        }
      } else {
        seen.labelWidth = Math.max(seen.labelWidth, labelWidth);
        seen.detailWidth = Math.max(seen.detailWidth, detailWidth);
      }
    }
  }
  const columns: Column[] = [];
  for (const key of ["fiveHour", "sevenDay", ...scoped, "spend"]) {
    const seen = measured.get(key);
    if (seen === undefined) continue;
    // A column whose details are all empty drops the gap that would precede them.
    const gaps = seen.detailWidth === 0 ? 2 : 3;
    columns.push({
      key,
      kind: key === "spend" ? "spend" : "window",
      labelWidth: seen.labelWidth,
      detailWidth: seen.detailWidth,
      width: seen.labelWidth + barWidth + pctWidth + seen.detailWidth + cellGap * gaps,
    });
  }
  return columns;
}

/**
 * Width of the alias/email/badge cell: the widest account, capped at 40 characters. Only an
 * account that hits the cap gets its email ellipsized.
 */
function headerWidthFor(accounts: UsageAccount[], font: number): number {
  const badge = Math.round(5 * CHAR_EM * font);
  let width = 0;
  for (const account of accounts) {
    // The alias is a step larger and bold, which the 1.1 factor stands in for.
    const alias = estimateWidth(account.alias ?? `#${account.number}`, font + 1) * 1.1;
    const email = account.email === undefined ? 0 : estimateWidth(account.email, font);
    // A degraded account that still draws last-good cells carries its status as a badge
    // beside `active`, plus the padding the badge style adds.
    const status =
      shownUsage(account)?.stale === true
        ? estimateWidth(account.usageStatus, font - 1) + 10
        : 0;
    width = Math.max(width, alias + email + (account.active ? badge : 0) + status);
  }
  return Math.round(Math.min(width, 40 * CHAR_EM * font));
}

/** The projection as it is appended to the detail text. Empty when there is none. */
function projectionSuffix(chip: Chip): string {
  if (chip.projection === null) return "";
  return chip.detail === "" ? chip.projection.text : ` · ${chip.projection.text}`;
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

/**
 * The usage block a row draws. Live `usage` when the fetch succeeded; otherwise the
 * `lastGoodUsage` cswap carries for an account it could not refresh this pass (for example
 * `token_expired` while a live `cswap run` session owns the credential — cswap leaves that
 * token alone so it does not log the session out). `stale` marks the fallback so the row can
 * dim it and show the status badge. Null when there is nothing to draw at all.
 */
function shownUsage(account: UsageAccount): { usage: UsageBlock; stale: boolean } | null {
  if (account.usageStatus === "ok") {
    return account.usage == null ? null : { usage: account.usage, stale: false };
  }
  if (account.lastGoodUsage !== undefined) return { usage: account.lastGoodUsage, stale: true };
  return null;
}

type Styles = ReturnType<typeof useStyles>;

function useStyles(theme: PluginThemeProp, step: SizeStep) {
  return useMemo(() => {
    const { font, barWidth, padH, padV } = SIZE_SPECS[step];
    const barHeight = Math.round(font / 2);
    const cellGap = 4;
    // The one width that does not depend on the data: percentages top out at "100%".
    const pctWidth = estimateWidth("100%", font);
    return {
      font,
      barWidth,
      pctWidth,
      cellGap,
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { paddingVertical: padV },
      // Widths below come from columnsFor / headerWidthFor, measured over the accounts on
      // screen: every cell of a column is the same width, so the same chip sits at the same
      // x on every row. Rows never wrap; the table scrolls sideways instead.
      table: { flexDirection: "column" as const, flexGrow: 1 },
      accountRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: padH,
        paddingVertical: padV,
      },
      accountDivider: { borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      cell: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: cellGap,
        flexShrink: 0 as const,
      },
      cellEmpty: { flexShrink: 0 as const },
      headerChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        flexShrink: 0 as const,
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
      statusBadge: {
        borderColor: theme.colors.statusWarning,
        borderWidth: 1,
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 0,
        flexShrink: 0 as const,
      },
      statusBadgeText: { color: theme.colors.statusWarning, fontSize: font - 1 },
      // Last-good cells are drawn dimmed so a frozen value is never mistaken for a live one.
      staleCells: { flexDirection: "row" as const, alignItems: "center" as const, opacity: 0.55 },
      label: { color: theme.colors.foregroundMuted, fontSize: font },
      pct: {
        color: theme.colors.foreground,
        fontSize: font,
        width: pctWidth,
        textAlign: "right" as const,
      },
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

function UsageChip({
  chip,
  column,
  styles,
  theme,
}: {
  chip: Chip;
  column: Column;
  styles: Styles;
  theme: PluginThemeProp;
}) {
  const width = `${Math.max(0, Math.min(chip.pct, 100))}%` as const;
  return (
    <View style={[styles.cell, { width: column.width }]}>
      <Text style={[styles.label, { width: column.labelWidth }]} numberOfLines={1}>
        {chip.label}
      </Text>
      <View style={styles.track}>
        <View style={{ width, height: "100%", backgroundColor: barColor(theme, chip.pct) }} />
      </View>
      <Text style={styles.pct} numberOfLines={1}>{`${Math.round(chip.pct)}%`}</Text>
      {/* Detail and projection share one cell, so they are one Text with a nested span that
          keeps the warning color. A column with no details at all drops the Text entirely,
          which is the gap columnsFor leaves out of the width. */}
      {column.detailWidth === 0 ? null : (
        <Text style={[styles.detail, { width: column.detailWidth }]} numberOfLines={1}>
          {chip.detail}
          {chip.projection === null ? null : (
            <Text style={chip.projection.warn ? styles.projectionWarn : styles.projection}>
              {projectionSuffix(chip)}
            </Text>
          )}
        </Text>
      )}
    </View>
  );
}

function AccountLine({
  account,
  columns,
  headerWidth,
  styles,
  theme,
  divider,
}: {
  account: UsageAccount;
  columns: Column[];
  headerWidth: number;
  styles: Styles;
  theme: PluginThemeProp;
  divider: boolean;
}) {
  const shown = shownUsage(account);
  // A non-ok status is recomputed on every cswap pass and is never persisted, so it is the
  // whole reason this plugin shells out instead of reading cswap's cache file. It must stay
  // visible: as a badge when last-good cells are drawn, as the whole row otherwise. An "ok"
  // account with no usage block is merely empty, not broken.
  const degraded = account.usageStatus !== "ok";
  const chips = shown === null ? [] : chipsFor(shown.usage);
  const byColumn = new Map(chips.map((chip) => [chip.column, chip]));
  const cells = columns.map((column) => {
    const chip = byColumn.get(column.key);
    // A column this account does not have still takes its width, so the next cell
    // stays under the same column on every other row.
    return chip === undefined ? (
      <View key={column.key} style={[styles.cellEmpty, { width: column.width }]} />
    ) : (
      <UsageChip key={column.key} chip={chip} column={column} styles={styles} theme={theme} />
    );
  });
  return (
    <View style={divider ? [styles.accountRow, styles.accountDivider] : styles.accountRow}>
      <View style={[styles.headerChip, { width: headerWidth }]}>
        <Text style={styles.alias}>{account.alias ?? `#${account.number}`}</Text>
        <Text style={styles.email} numberOfLines={1}>
          {account.email ?? ""}
        </Text>
        {account.active ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>active</Text>
          </View>
        ) : null}
        {shown?.stale === true ? (
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>{account.usageStatus}</Text>
          </View>
        ) : null}
      </View>
      {shown === null ? (
        degraded ? (
          <Text style={styles.status}>{account.usageStatus}</Text>
        ) : (
          <Text style={styles.muted}>{strings.noUsage}</Text>
        )
      ) : shown.stale ? (
        <>
          <View style={styles.staleCells}>{cells}</View>
          <Text style={styles.muted} numberOfLines={1}>
            {strings.lastGood(clockTime(account.lastGoodFetchedAt ?? null))}
          </Text>
        </>
      ) : (
        cells
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
  const columns = useMemo(
    () => columnsFor(accounts, styles.font, styles.barWidth, styles.pctWidth, styles.cellGap),
    [accounts, styles],
  );
  const headerWidth = useMemo(() => headerWidthFor(accounts, styles.font), [accounts, styles]);
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
          <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.table}>
              {accounts.map((account, index) => (
                <AccountLine
                  key={account.number}
                  account={account}
                  columns={columns}
                  headerWidth={headerWidth}
                  styles={styles}
                  theme={theme}
                  divider={index < accounts.length - 1}
                />
              ))}
            </View>
          </ScrollView>
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
