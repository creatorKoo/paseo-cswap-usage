import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginButton,
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  switchAccount,
  type UsageAccount,
  type UsageListOutput,
  type UsageWindow,
} from "../shared/contract";
import { DEFAULT_LABEL_FORMAT, type LabelFormat, pillSettings } from "../shared/settings";
import {
  accountName,
  barColor,
  clockTime,
  type Locale,
  locale,
  shownUsage,
  USAGE_QUERY_KEY,
  useUsageQuery,
} from "./common";

type StringTable = {
  title: string;
  active: string;
  resetsIn: (countdown: string) => string;
  lastGood: (time: string) => string;
  switchLabel: string;
  switching: string;
  switched: (name: string) => string;
  alreadyActive: (name: string) => string;
  note: string;
  openPanel: string;
  updated: (time: string) => string;
  loading: string;
  noAccounts: string;
  noUsage: string;
  rpcFailed: (message: string) => string;
};

const STRINGS: Record<Locale, StringTable> = {
  ko: {
    title: "cswap 사용량",
    active: "사용 중",
    resetsIn: (countdown) => `${countdown} 후 초기화`,
    lastGood: (time) => `마지막 값 ${time}`,
    switchLabel: "전환",
    switching: "전환 중…",
    switched: (name) => `${name} 계정으로 전환했습니다`,
    alreadyActive: (name) => `이미 ${name} 계정입니다`,
    note: "전환하면 실행 중인 claude 에이전트와 터미널도 30초쯤 뒤 새 계정을 씁니다",
    openPanel: "전체 보기",
    updated: (time) => `갱신 ${time}`,
    loading: "불러오는 중…",
    noAccounts: "계정이 없습니다",
    noUsage: "사용량 없음",
    rpcFailed: (message) => `usage.switch 호출 실패: ${message}`,
  },
  en: {
    title: "cswap usage",
    active: "active",
    resetsIn: (countdown) => `resets in ${countdown}`,
    lastGood: (time) => `last value ${time}`,
    switchLabel: "Switch",
    switching: "Switching…",
    switched: (name) => `Switched to ${name}`,
    alreadyActive: (name) => `Already on ${name}`,
    note: "Running claude agents and terminals follow the switch within about 30s",
    openPanel: "Open panel",
    updated: (time) => `updated ${time}`,
    loading: "Loading…",
    noAccounts: "No accounts",
    noUsage: "no usage",
    rpcFailed: (message) => `usage.switch failed: ${message}`,
  },
};

const strings = STRINGS[locale];

function percent(usageWindow: UsageWindow | undefined): string {
  return usageWindow === undefined ? "—" : `${Math.round(usageWindow.pct)}%`;
}

/** `2h 31m` → `2h31m`: the pill label has roughly fifteen characters to spend. */
function tightCountdown(usageWindow: UsageWindow | undefined): string {
  return usageWindow?.countdown?.replace(/\s+/g, "") ?? "";
}

function activeAccount(data: UsageListOutput | undefined): UsageAccount | null {
  return data?.accounts.find((account) => account.active) ?? null;
}

/**
 * The one-line label after the gauge icon. The alias goes last so that the host's
 * single-line ellipsis cuts a long alias, never the numbers.
 */
export function pillLabel(account: UsageAccount, format: LabelFormat): string {
  const usage = shownUsage(account)?.usage;
  const fiveHour = usage?.fiveHour;
  let head: string;
  if (usage === undefined) head = "—";
  else if (format === "5h-7d") head = `${percent(fiveHour)} / ${percent(usage.sevenDay)}`;
  else if (format === "short") head = percent(fiveHour);
  else head = [percent(fiveHour), tightCountdown(fiveHour)].filter(Boolean).join(" ");
  return `${head} · ${accountName(account)}`;
}

function windowSummary(label: string, usageWindow: UsageWindow | undefined): string | null {
  if (usageWindow === undefined) return null;
  const reset =
    usageWindow.countdown === undefined ? "" : ` · ${strings.resetsIn(usageWindow.countdown)}`;
  return `${label} ${percent(usageWindow)}${reset}`;
}

/** Tooltip and accessibility label: everything the label had no room for. */
function pillTitle(account: UsageAccount | null, error: string | null): string {
  const parts = [`cswap: ${account === null ? "—" : accountName(account)}`];
  if (account !== null) {
    parts[0] += ` (${strings.active})`;
    const shown = shownUsage(account);
    for (const summary of [
      windowSummary("5h", shown?.usage.fiveHour),
      windowSummary("7d", shown?.usage.sevenDay),
    ]) {
      if (summary !== null) parts.push(summary);
    }
    if (account.usageStatus !== "ok") {
      parts.push(account.usageStatus);
      if (shown?.stale === true) {
        parts.push(strings.lastGood(clockTime(account.lastGoodFetchedAt ?? null)));
      }
    }
  }
  if (error !== null) parts.push(error);
  return parts.join(" · ");
}

function GaugeBar({
  pct,
  theme,
  width,
  height,
  degraded,
}: {
  pct: number | null;
  theme: PluginTheme;
  width: number;
  height: number;
  degraded: boolean;
}) {
  const fill = pct === null ? 0 : Math.max(0, Math.min(pct, 100));
  return (
    <View
      style={{
        width,
        height,
        borderRadius: width / 3,
        backgroundColor: theme.colors.border,
        borderWidth: degraded ? 1 : 0,
        borderColor: theme.colors.statusWarning,
        overflow: "hidden",
        justifyContent: "flex-end",
      }}
    >
      <View
        style={{
          height: `${fill}%`,
          backgroundColor: pct === null ? theme.colors.border : barColor(theme, fill),
          opacity: degraded ? 0.5 : 1,
        }}
      />
    </View>
  );
}

/**
 * The pill's icon slot: two vertical bars for the active account's 5h and 7d windows.
 * It also owns the label and tooltip, which it pushes into the button through `update`,
 * because only a component can subscribe to the usage query and the settings.
 */
export function PillIcon({
  theme,
  size,
  layout,
  update,
}: PluginButtonIconProps & { update(patch: Partial<PluginButton>): void }) {
  const usage = useUsageQuery();
  const settings = useSettings(pillSettings);
  const format = settings.status === "ready" ? settings.values.labelFormat : DEFAULT_LABEL_FORMAT;
  const account = activeAccount(usage.data);
  const error = usage.error === null ? (usage.data?.error ?? null) : usage.error.message;

  const label =
    account !== null
      ? pillLabel(account, format)
      : usage.isPending
        ? "…"
        : "— · cswap";
  // On compact layouts the title doubles as the bottom sheet's heading, so it stays short.
  const title = layout.compact ? strings.title : pillTitle(account, error);
  useEffect(() => {
    update({ label, title });
  }, [update, label, title]);

  const shown = account === null ? null : shownUsage(account);
  const degraded = account !== null && account.usageStatus !== "ok";
  const barWidth = Math.max(3, Math.floor((size - 3) / 2));
  const barHeight = size - 2;
  return (
    <View
      style={{
        width: size,
        height: size,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
      }}
    >
      <GaugeBar
        pct={shown?.usage.fiveHour?.pct ?? null}
        theme={theme}
        width={barWidth}
        height={barHeight}
        degraded={degraded}
      />
      <GaugeBar
        pct={shown?.usage.sevenDay?.pct ?? null}
        theme={theme}
        width={barWidth}
        height={barHeight}
        degraded={degraded}
      />
    </View>
  );
}

const FONT = 12;
const NAME_WIDTH = 64;
const BAR_WIDTH = 32;
const PCT_WIDTH = 32;
const COUNTDOWN_WIDTH = 40;
const ACTION_WIDTH = 64;

function usePopoverStyles(theme: PluginTheme) {
  return useMemo(
    () => ({
      root: { gap: 8 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      heading: { color: theme.colors.foreground, fontSize: FONT + 1, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: FONT },
      danger: { color: theme.colors.statusDanger, fontSize: FONT },
      warning: { color: theme.colors.statusWarning, fontSize: FONT },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 26,
      },
      dot: { width: 7, height: 7, borderRadius: 4 },
      name: { width: NAME_WIDTH, fontSize: FONT, fontWeight: "600" as const },
      cells: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      stale: { opacity: 0.55 },
      cell: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      cellLabel: { color: theme.colors.foregroundMuted, fontSize: FONT, width: 16 },
      track: {
        width: BAR_WIDTH,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      pct: {
        color: theme.colors.foreground,
        fontSize: FONT,
        width: PCT_WIDTH,
        textAlign: "right" as const,
      },
      countdown: { color: theme.colors.foregroundMuted, fontSize: FONT, width: COUNTDOWN_WIDTH },
      status: { color: theme.colors.statusWarning, fontSize: FONT, flexShrink: 1 },
      action: { width: ACTION_WIDTH, alignItems: "flex-end" as const, marginLeft: "auto" as const },
      activeText: { color: theme.colors.accent, fontSize: FONT },
      button: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      },
      buttonText: { color: theme.colors.foreground, fontSize: FONT },
      buttonTextDisabled: { color: theme.colors.foregroundMuted, fontSize: FONT },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 8,
      },
    }),
    [theme],
  );
}

type PopoverStyles = ReturnType<typeof usePopoverStyles>;

function WindowCell({
  label,
  usageWindow,
  countdown,
  styles,
  theme,
}: {
  label: string;
  usageWindow: UsageWindow | undefined;
  countdown: boolean;
  styles: PopoverStyles;
  theme: PluginTheme;
}) {
  const pct = usageWindow?.pct ?? 0;
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{label}</Text>
      <View style={styles.track}>
        <View
          style={{
            width: `${Math.max(0, Math.min(pct, 100))}%`,
            height: "100%",
            backgroundColor: barColor(theme, pct),
          }}
        />
      </View>
      <Text style={styles.pct} numberOfLines={1}>
        {percent(usageWindow)}
      </Text>
      {countdown ? (
        <Text style={styles.countdown} numberOfLines={1}>
          {tightCountdown(usageWindow)}
        </Text>
      ) : null}
    </View>
  );
}

/** One line per account: 5h and 7d, and a switch button on every account but the active one. */
function AccountRow({
  account,
  styles,
  theme,
  pendingNumber,
  onSwitch,
}: {
  account: UsageAccount;
  styles: PopoverStyles;
  theme: PluginTheme;
  pendingNumber: number | null;
  onSwitch(number: number): void;
}) {
  const shown = shownUsage(account);
  const degraded = account.usageStatus !== "ok";
  const name = accountName(account);
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.dot,
          { backgroundColor: account.active ? theme.colors.accent : "transparent" },
        ]}
      />
      <Text
        style={[
          styles.name,
          { color: degraded ? theme.colors.statusWarning : theme.colors.foreground },
        ]}
        numberOfLines={1}
      >
        {name}
      </Text>
      {shown === null ? (
        <Text style={styles.status} numberOfLines={1}>
          {degraded ? account.usageStatus : strings.noUsage}
        </Text>
      ) : (
        <View style={shown.stale ? [styles.cells, styles.stale] : styles.cells}>
          <WindowCell
            label="5h"
            usageWindow={shown.usage.fiveHour}
            countdown
            styles={styles}
            theme={theme}
          />
          <WindowCell
            label="7d"
            usageWindow={shown.usage.sevenDay}
            countdown={false}
            styles={styles}
            theme={theme}
          />
        </View>
      )}
      <View style={styles.action}>
        {account.active ? (
          <Text style={styles.activeText}>{strings.active}</Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${strings.switchLabel}: ${name}`}
            accessibilityState={{ disabled: pendingNumber !== null }}
            disabled={pendingNumber !== null}
            onPress={() => onSwitch(account.number)}
            style={styles.button}
          >
            <Text style={pendingNumber === null ? styles.buttonText : styles.buttonTextDisabled}>
              {pendingNumber === account.number ? strings.switching : strings.switchLabel}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** The popover the pill opens: every account on one line, with switch buttons. */
export function PillPopover({
  theme,
  close,
  onOpenPanel,
}: PluginButtonContentProps & { onOpenPanel(): void }) {
  const styles = usePopoverStyles(theme);
  const usage = useUsageQuery();
  const queryClient = useQueryClient();
  const callSwitch = useRpc(switchAccount);
  const toast = useToast();
  const [problem, setProblem] = useState<{ text: string; danger: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: (number: number) => callSwitch({ number }),
    onMutate: () => setProblem(null),
    onSuccess: (result, number) => {
      // The server already applied the new active account, so no `cswap list` is needed.
      queryClient.setQueryData(USAGE_QUERY_KEY, result.usage);
      if (result.error !== null) {
        setProblem({ text: result.error, danger: true });
        return;
      }
      const target = result.usage.accounts.find((account) => account.number === number);
      const name = target === undefined ? `#${number}` : accountName(target);
      toast.show(result.switched ? strings.switched(name) : strings.alreadyActive(name), {
        variant: result.switched ? "success" : "default",
      });
      // Warnings stay on screen; a clean switch closes the popover.
      if (result.warnings.length > 0) {
        setProblem({ text: result.warnings.join(" · "), danger: false });
      } else {
        close();
      }
    },
    onError: (error) => setProblem({ text: strings.rpcFailed(error.message), danger: true }),
  });

  const accounts = usage.data?.accounts ?? [];
  const listError = usage.error === null ? (usage.data?.error ?? null) : usage.error.message;
  const pendingNumber = mutation.isPending ? (mutation.variables ?? null) : null;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.heading}>{strings.title}</Text>
        <Text style={styles.muted}>{strings.updated(clockTime(usage.data?.fetchedAt ?? null))}</Text>
      </View>
      {usage.isPending ? (
        <Text style={styles.muted}>{strings.loading}</Text>
      ) : accounts.length === 0 ? (
        <Text style={listError === null ? styles.muted : styles.danger}>
          {listError ?? strings.noAccounts}
        </Text>
      ) : (
        accounts.map((account) => (
          <AccountRow
            key={account.number}
            account={account}
            styles={styles}
            theme={theme}
            pendingNumber={pendingNumber}
            onSwitch={(number) => mutation.mutate(number)}
          />
        ))
      )}
      {accounts.length > 0 && listError !== null ? (
        <Text style={styles.danger}>{listError}</Text>
      ) : null}
      {problem === null ? null : (
        <Text style={problem.danger ? styles.danger : styles.warning}>{problem.text}</Text>
      )}
      <View style={styles.footer}>
        <Text style={[styles.muted, { flexShrink: 1 }]}>{strings.note}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            close();
            onOpenPanel();
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{strings.openPanel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
