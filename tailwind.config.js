/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bot-bg': '#060609',
        'bot-card': '#0c0c14',
        'bot-card-hover': '#10101c',
        'bot-border': '#1a1a2e',
        'bot-border-light': '#252540',
        'bot-green': '#00e87b',
        'bot-green-dim': '#00c96a',
        'bot-red': '#ff3b5c',
        'bot-red-dim': '#cc2d49',
        'bot-yellow': '#ffc107',
        'bot-blue': '#3d8bfd',
        'bot-purple': '#a855f7',
        'bot-cyan': '#06d6f0',
        'bot-gray': '#555570',
        'bot-text': '#e2e2f0',
        'bot-muted': '#6e6e88',
        'bot-surface': '#0f0f1a',
      },
      fontFamily: {
        'display': ['Outfit', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'shimmer': 'shimmer 2s ease-in-out infinite',
        'float': 'float 6s ease-in-out infinite',
        'border-pulse': 'borderPulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(0, 232, 123, 0.15)' },
          '100%': { boxShadow: '0 0 25px rgba(0, 232, 123, 0.3)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        },
        borderPulse: {
          '0%, 100%': { borderColor: 'rgba(0, 232, 123, 0.2)' },
          '50%': { borderColor: 'rgba(0, 232, 123, 0.5)' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'noise': "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E\")",
      },
      boxShadow: {
        'glow-green': '0 0 20px rgba(0, 232, 123, 0.15), 0 0 60px rgba(0, 232, 123, 0.05)',
        'glow-cyan': '0 0 20px rgba(6, 214, 240, 0.15), 0 0 60px rgba(6, 214, 240, 0.05)',
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.15), 0 0 60px rgba(168, 85, 247, 0.05)',
        'glow-red': '0 0 20px rgba(255, 59, 92, 0.15), 0 0 60px rgba(255, 59, 92, 0.05)',
        'card': '0 4px 24px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3)',
        'card-hover': '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
      },
      backdropBlur: {
        'xs': '2px',
      },
    },
  },
  plugins: [],
}
