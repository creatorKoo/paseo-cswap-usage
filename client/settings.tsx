import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { LABEL_EXAMPLES, LABEL_FORMATS, pillSettings } from "../shared/settings";
import { type Locale, locale } from "./common";

type StringTable = {
  section: string;
  labelFormat: string;
  labelHint: string;
  loading: string;
  invalid: string;
  reset: string;
};

const STRINGS: Record<Locale, StringTable> = {
  ko: {
    section: "Composer pill",
    labelFormat: "라벨 형식",
    labelHint:
      "순서대로 5h + 남은 시간, 5h / 7d, 5h만. 아이콘의 두 막대는 항상 5h와 7d입니다. pill을 눌러 팝오버에서도 고를 수 있습니다.",
    loading: "불러오는 중…",
    invalid: "저장된 설정을 읽을 수 없습니다",
    reset: "기본값으로",
  },
  en: {
    section: "Composer pill",
    labelFormat: "Label",
    labelHint:
      "In order: 5h + time to reset, 5h / 7d, 5h only. The icon's two bars are always 5h and 7d. The pill's popover offers the same choice.",
    loading: "Loading…",
    invalid: "The saved settings could not be read",
    reset: "Reset",
  },
};

const strings = STRINGS[locale];

// The menu cuts long option labels, so each option is just what the pill would show.
const FORMAT_OPTIONS = LABEL_FORMATS.map((value) => ({
  label: `${LABEL_EXAMPLES[value]} · skt`,
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
