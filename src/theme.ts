import {
  createTheme,
  virtualColor,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from "@mantine/core";

/**
 * 现代静谧工作室（Editorial Minimal）色彩与主题系统。
 *
 * 设计原则：
 * 1. 所有精确色值集中在本文件，通过 Mantine 色板与 `editorialCssVariablesResolver`
 *    注入双态 CSS 变量，`globals.css` 不出现任何硬编码 hex。
 * 2. 浅色采用温润矿石纸底（#F4F2EC）+ 暖石侧边栏（#EAE6DD）+ 纯净纸白表面（#FFFFFF）
 *    + 细腻发丝线；深色采用温润炭黑层级（#121110 / #171614 / #1C1B18）。
 * 3. 主交互色为克制的墨黑 / 暖骨白（virtualColor `ink`），结合 `autoContrast: true`
 *    自动保证浅/深色下实心主按钮、分页当前页与复选框图标对比度清晰；
 *    色彩严格留给真实业务语义状态（低饱和松石绿 / 暖赭琥珀 / 沉稳赤陶红 / 暖石中性灰）。
 */

/** 浅色模式主色阶（深炭墨黑，shade 8 为主按钮填充，shade 9 为悬停） */
const inkDark: MantineColorsTuple = [
  "#F5F3EE",
  "#EAE6DE",
  "#D5CFC3",
  "#B9B1A3",
  "#968E80",
  "#70695E",
  "#4E4942",
  "#33312E",
  "#1E1D1B",
  "#34312D",
];

/** 深色模式主色阶（温润骨白，shade 8 为主按钮填充，自动匹配深墨文字） */
const inkLight: MantineColorsTuple = [
  "#262420",
  "#35322D",
  "#4E4942",
  "#70695E",
  "#968E80",
  "#B9B1A3",
  "#D5CFC3",
  "#DFDAD0",
  "#EAE6DE",
  "#FAF8F4",
];

const ink = virtualColor({
  name: "ink",
  light: "inkDark",
  dark: "inkLight",
});

const stone: MantineColorsTuple = [
  "#FAF9F6",
  "#F3F1EC",
  "#E9E5DC",
  "#DCD6CA",
  "#C7C0B3",
  "#A9A194",
  "#8A8377",
  "#6B655B",
  "#4E4942",
  "#2F2C28",
];

/** 暖炭暗色阶（替代 Mantine 默认冷蓝灰 dark） */
const warmDark: MantineColorsTuple = [
  "#E5E1DA",
  "#C7C1B8",
  "#9B958C",
  "#726D65",
  "#3E3A35",
  "#2D2A26",
  "#211F1C",
  "#171614",
  "#131210",
  "#0D0C0B",
];

/** 低饱和植物松石绿：明确匹配 / 正常 / 成功 */
const sage: MantineColorsTuple = [
  "#EEF5F1",
  "#DCEBE3",
  "#B9D7C8",
  "#92BFAA",
  "#6FA88E",
  "#4E8C72",
  "#35735B",
  "#295D49",
  "#1F4939",
  "#16372A",
];

/** 低饱和暖赭琥珀：待确认 / 限流 / 预警 */
const ochre: MantineColorsTuple = [
  "#FAF4E8",
  "#F3E6CE",
  "#E7CE9F",
  "#DAB36E",
  "#CE9A47",
  "#B5802E",
  "#946522",
  "#774F19",
  "#5D3D13",
  "#452C0C",
];

/** 低饱和赤陶红：处理失败 / 禁用 / 破坏性操作 */
const terracotta: MantineColorsTuple = [
  "#FAF0EE",
  "#F3DDDA",
  "#E7BBB5",
  "#D9958C",
  "#C87268",
  "#B65348",
  "#A13E34",
  "#833128",
  "#67261F",
  "#4C1C16",
];

export const theme = createTheme({
  primaryColor: "ink",
  primaryShade: { light: 8, dark: 8 },
  autoContrast: true,
  luminanceThreshold: 0.45,
  defaultRadius: "sm",
  cursorType: "pointer",
  white: "#FFFFFF",
  black: "#181715",
  fontFamily:
    '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  colors: {
    inkDark,
    inkLight,
    ink,
    gray: stone,
    dark: warmDark,
    green: sage,
    teal: sage,
    yellow: ochre,
    orange: ochre,
    red: terracotta,
    blue: ink,
  },
  components: {
    Button: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        root: {
          fontWeight: 500,
          letterSpacing: "0.005em",
          transition:
            "background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease",
        },
      },
    },
    TextInput: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        label: {
          fontSize: "13px",
          fontWeight: 500,
          marginBottom: "6px",
          color: "var(--studio-text)",
        },
        description: {
          fontSize: "12.5px",
          color: "var(--studio-muted)",
          marginBottom: "6px",
        },
      },
    },
    PasswordInput: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        label: {
          fontSize: "13px",
          fontWeight: 500,
          marginBottom: "6px",
          color: "var(--studio-text)",
        },
      },
    },
    NumberInput: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        label: {
          fontSize: "13px",
          fontWeight: 500,
          marginBottom: "6px",
          color: "var(--studio-text)",
        },
        description: {
          fontSize: "12.5px",
          color: "var(--studio-muted)",
          marginBottom: "6px",
        },
      },
    },
    Textarea: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        label: {
          fontSize: "13px",
          fontWeight: 500,
          marginBottom: "6px",
          color: "var(--studio-text)",
        },
      },
    },
    Select: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        label: {
          fontSize: "13px",
          fontWeight: 500,
          marginBottom: "6px",
          color: "var(--studio-text)",
        },
      },
    },
    Fieldset: {
      defaultProps: {
        radius: "md",
      },
      styles: {
        root: {
          borderColor: "var(--studio-border)",
          backgroundColor: "var(--studio-surface-subtle)",
          padding: "16px 18px",
        },
        legend: {
          fontSize: "12.5px",
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: "var(--studio-text)",
          paddingInline: "6px",
        },
      },
    },
    Modal: {
      defaultProps: {
        radius: "md",
        overlayProps: {
          backgroundOpacity: 0.42,
          blur: 4,
        },
      },
      styles: {
        content: {
          backgroundColor: "var(--studio-surface)",
          border: "1px solid var(--studio-border)",
          boxShadow: "var(--studio-shadow-md)",
        },
        header: {
          backgroundColor: "var(--studio-surface)",
          borderBottom: "1px solid var(--studio-border)",
          padding: "18px 24px",
        },
        title: {
          fontSize: "16px",
          fontWeight: 600,
          letterSpacing: "-0.015em",
          color: "var(--studio-ink)",
        },
        body: {
          padding: "20px 24px 24px",
        },
      },
    },
    Menu: {
      defaultProps: {
        radius: "md",
        shadow: "sm",
      },
      styles: {
        dropdown: {
          backgroundColor: "var(--studio-surface)",
          border: "1px solid var(--studio-border)",
          boxShadow: "var(--studio-shadow-sm)",
          padding: "4px",
        },
        item: {
          fontSize: "13.5px",
          borderRadius: "5px",
        },
      },
    },
    Tabs: {
      styles: {
        list: {
          borderBottom: "1px solid var(--studio-border)",
          gap: "4px",
        },
        tab: {
          fontSize: "13.5px",
          fontWeight: 500,
          padding: "10px 14px",
          borderRadius: 0,
          color: "var(--studio-muted)",
          transition: "color 140ms ease, border-color 140ms ease",
        },
      },
    },
    Switch: {
      styles: {
        label: {
          fontSize: "13.5px",
          color: "var(--studio-text)",
          cursor: "pointer",
        },
        description: {
          fontSize: "12.5px",
          color: "var(--studio-muted)",
        },
      },
    },
    Radio: {
      styles: {
        label: {
          fontSize: "13.5px",
          color: "var(--studio-text)",
          cursor: "pointer",
        },
      },
    },
    Alert: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        root: {
          border: "1px solid var(--studio-border)",
          padding: "12px 16px",
        },
        message: {
          fontSize: "13.5px",
          lineHeight: 1.6,
        },
      },
    },
    Badge: {
      defaultProps: {
        radius: "sm",
      },
      styles: {
        root: {
          textTransform: "none",
          fontWeight: 500,
          letterSpacing: "0.01em",
        },
      },
    },
    Pagination: {
      defaultProps: {
        radius: "sm",
      },
    },
  },
});

/**
 * 双态语义 CSS 变量解析器：
 * 既校准 Mantine 原生核心变量，也向自定义 CSS 提供 `--studio-*` 令牌。
 */
export const editorialCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    "--studio-radius-sm": "6px",
    "--studio-radius-md": "10px",
    "--studio-radius-lg": "14px",
    "--studio-sidebar-width": "236px",
  },
  light: {
    "--mantine-color-body": "#F4F2EC",
    "--mantine-color-text": "#2A2825",
    "--mantine-color-bright": "#161513",
    "--mantine-color-dimmed": "#6E6961",
    "--mantine-color-default": "#FFFFFF",
    "--mantine-color-default-hover": "#EEEAE1",
    "--mantine-color-default-color": "#1E1D1B",
    "--mantine-color-default-border": "#DBD5C9",
    "--mantine-color-placeholder": "#9A9389",
    "--mantine-color-disabled": "#EAE6DD",
    "--mantine-color-disabled-color": "#8E877D",
    "--mantine-color-disabled-border": "#DBD5C9",
    "--mantine-color-error": "#A13E34",
    "--mantine-color-success": "#295D49",
    "--studio-bg": "#F4F2EC",
    "--studio-sidebar": "#EAE6DD",
    "--studio-surface": "#FFFFFF",
    "--studio-surface-subtle": "#F1EFE9",
    "--studio-surface-hover": "#E8E3D9",
    "--studio-border": "#E2DDD3",
    "--studio-border-strong": "#CFC9BC",
    "--studio-ink": "#161513",
    "--studio-text": "#2A2825",
    "--studio-muted": "#6E6961",
    "--studio-ok": "#295D49",
    "--studio-ok-soft": "#EAF3EE",
    "--studio-warn": "#946522",
    "--studio-warn-soft": "#F8F1E2",
    "--studio-err": "#A13E34",
    "--studio-err-soft": "#F8ECEA",
    "--studio-neutral-soft": "#ECE8DF",
    "--studio-shadow-xs": "0 1px 2px rgba(22, 21, 19, 0.045)",
    "--studio-shadow-sm":
      "0 4px 16px rgba(22, 21, 19, 0.06), 0 1px 2px rgba(22, 21, 19, 0.04)",
    "--studio-shadow-md":
      "0 18px 48px rgba(22, 21, 19, 0.10), 0 2px 6px rgba(22, 21, 19, 0.04)",
  },
  dark: {
    "--mantine-color-body": "#121110",
    "--mantine-color-text": "#D4CFC7",
    "--mantine-color-bright": "#F4F0E8",
    "--mantine-color-dimmed": "#928C83",
    "--mantine-color-default": "#1C1B19",
    "--mantine-color-default-hover": "#262421",
    "--mantine-color-default-color": "#EFECE6",
    "--mantine-color-default-border": "#36322D",
    "--mantine-color-placeholder": "#726D65",
    "--mantine-color-disabled": "#201E1B",
    "--mantine-color-disabled-color": "#77726A",
    "--mantine-color-disabled-border": "#322F2B",
    "--mantine-color-error": "#DF7A70",
    "--mantine-color-success": "#6FB89D",
    "--studio-bg": "#121110",
    "--studio-sidebar": "#171614",
    "--studio-surface": "#1C1B18",
    "--studio-surface-subtle": "#23211E",
    "--studio-surface-hover": "#2A2824",
    "--studio-border": "#2E2B27",
    "--studio-border-strong": "#3F3B36",
    "--studio-ink": "#F4F0E8",
    "--studio-text": "#D4CFC7",
    "--studio-muted": "#928C83",
    "--studio-ok": "#6FB89D",
    "--studio-ok-soft": "rgba(111, 184, 157, 0.14)",
    "--studio-warn": "#D9AA5B",
    "--studio-warn-soft": "rgba(217, 170, 91, 0.15)",
    "--studio-err": "#DF7A70",
    "--studio-err-soft": "rgba(223, 122, 112, 0.15)",
    "--studio-neutral-soft": "rgba(212, 207, 199, 0.10)",
    "--studio-shadow-xs": "0 1px 2px rgba(0, 0, 0, 0.34)",
    "--studio-shadow-sm":
      "0 6px 20px rgba(0, 0, 0, 0.38), 0 1px 2px rgba(0, 0, 0, 0.24)",
    "--studio-shadow-md":
      "0 20px 56px rgba(0, 0, 0, 0.56), 0 2px 8px rgba(0, 0, 0, 0.32)",
  },
});
