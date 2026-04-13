/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0e1a',
        surface: '#111827',
        card: '#1a2235',
        border: '#1e2d45',
        accent: '#3b82f6',
        green: { 400: '#4ade80', 500: '#22c55e' },
        red: { 400: '#f87171', 500: '#ef4444' },
        yellow: { 400: '#facc15', 500: '#eab308' },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
