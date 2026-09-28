import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { type LabelFormat, pillSettings } from "../shared/settings";
import { type Locale, locale } from "./common";

type StringTable = {
  section: string;
  labelFormat: string;
  labelHint: string;
  formats: Record<LabelFormat, string>;
  loading: string;
  invalid: string;
  reset: string;
};

const STRINGS: Record<Locale, StringTable> = {
  ko: {
    section: "Composer pill",
    labelFormat: "라벨 형식",
    labelHint: "아이콘의 두 막대는 항상 5h와 7d입니다. 별칭은 맨 뒤에 붙고, 길면 잘립니다.",
    formats: {
      "5h": "5h 사용률 + 남은 시간 (42% 2h31m · skt)",
      "5h-7d": "5h / 7d 사용률 (42% / 14% · skt)",
      short: "5h 사용률만 (42% · skt)",
    },
    loading: "불러오는 중…",
    invalid: "저장된 설정을 읽을 수 없습니다",
    reset: "기본값으로",
  },
  en: {
    section: "Composer pill",
    labelFormat: "Label",
    labelHint: "The icon's two bars are always 5h and 7d. The alias comes last and is cut when long.",
    formats: {
      "5h": "5h percent + time to reset (42% 2h31m · skt)",
      "5h-7d": "5h / 7d percent (42% / 14% · skt)",
      short: "5h percent only (42% · skt)",
    },
    loading: "Loading…",
    invalid: "The saved settings could not be read",
    reset: "Reset",
  },
};

const strings = STRINGS[locale];

const FORMAT_OPTIONS = (Object.keys(strings.formats) as LabelFormat[]).map((value) => ({
  label: strings.formats[value],
  value,
}));

export function PillSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(pillSettings);
  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>{strings.loading}</Text>;
  }
  if (settings.status === "error") {
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  }
  return (
    <SettingsSection title={strings.section}>
      <SettingsCard>
        {settings.status === "invalid" ? (
          // Invalid stored data is kept until the user asks for defaults.
          <SettingsAction
            label={strings.invalid}
            hint={settings.error}
            actionLabel={strings.reset}
            disabled={settings.saving}
            onPress={() => {
              void settings.reset();
            }}
          />
        ) : (
          <SettingsSelect
            label={strings.labelFormat}
            hint={strings.labelHint}
            error={settings.saveError ?? undefined}
            value={settings.values.labelFormat}
            options={FORMAT_OPTIONS}
            disabled={settings.saving}
            onValueChange={(labelFormat) => {
              void settings.save({ ...settings.values, labelFormat }, settings.revision);
            }}
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
