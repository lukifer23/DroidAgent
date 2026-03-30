export function terminalTheme(theme: "dark" | "light") {
  return theme === "light"
    ? {
        background: "#ffffff",
        foreground: "#17202b",
        cursor: "#2457dc",
        selectionBackground: "rgba(36, 108, 255, 0.18)",
        black: "#17202b",
        blue: "#2457dc",
        cyan: "#0d8bb1",
        green: "#168762",
        red: "#cb5a49",
        yellow: "#9f7a42",
        brightBlack: "#647384",
        brightWhite: "#ffffff",
      }
    : {
        background: "#10161f",
        foreground: "#edf2f7",
        cursor: "#5f95ff",
        selectionBackground: "rgba(95, 149, 255, 0.2)",
        black: "#0b1016",
        blue: "#5f95ff",
        cyan: "#56c7d9",
        green: "#50bf91",
        red: "#ea705f",
        yellow: "#d6bc90",
        brightBlack: "#99a4b2",
        brightWhite: "#f7fbff",
      };
}
