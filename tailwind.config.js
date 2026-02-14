/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bot-bg': '#0a0a0f',
        'bot-card': '#12121a',
        'bot-border': '#1e1e2e',
        'bot-green': '#00ff88',
        'bot-red': '#ff4466',
        'bot-yellow': '#ffcc00',
        'bot-blue': '#4488ff',
        'bot-purple': '#8844ff',
        'bot-cyan': '#00ccff',
        'bot-gray': '#666680',
        'bot-text': '#e0e0f0',
        'bot-muted': '#888899',
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(0, 255, 136, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(0, 255, 136, 0.4)' },
        },
      },
    },
  },
  plugins: [],
}
