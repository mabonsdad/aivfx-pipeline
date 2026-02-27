import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#f5f2ea",
        card: "#fffdf9",
        ink: "#18120f",
        accent: "#ff5a2f",
        accent2: "#0f766e",
      },
      fontFamily: {
        sans: ["'Manrope'", "'Segoe UI'", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
