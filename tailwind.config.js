/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#4F46E5',
          hover: '#4338CA',
          light: '#EEF2FF',
        },
        background: '#F5F6FB',
        surface: '#FFFFFF',
        border: '#E5E7EB',
        text: {
          primary: '#111827',
          secondary: '#6B7280',
        },
        risk: {
          high: {
            text: '#DC2626',
            bg: '#FEE2E2',
            border: '#FECACA',
          },
          medium: {
            text: '#D97706',
            bg: '#FEF3C7',
            border: '#FDE68A',
          },
          low: {
            text: '#059669',
            bg: '#D1FAE5',
            border: '#A7F3D0',
          },
          neutral: {
            text: '#6B7280',
            bg: '#F3F4F6',
            border: '#E5E7EB',
          },
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0, 0, 0, 0.04)',
      },
      borderRadius: {
        card: '14px',
      },
      width: {
        sidebar: '220px',
      },
    },
  },
  plugins: [],
};
