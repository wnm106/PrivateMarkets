/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'Segoe UI', 'system-ui', 'sans-serif'],
        serif: ['var(--font-inter)', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['var(--font-inter)', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['var(--font-ibm-plex-mono)', 'Menlo', 'Monaco', 'monospace'],
      },
      colors: {
        // tapestr.ai design system
        bg: '#f8fafc',
        'bg-alt': '#f1f5f9',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#0f172a',
          2: '#334155',
          3: '#6b7280',
          4: '#9ca3af',
        },
        line: {
          DEFAULT: '#e2e8f0',
          strong: '#cbd5e1',
        },
        accent: {
          DEFAULT: '#00334e',     // navy
          2: '#0e7490',           // teal
        },
        brand: {
          navy: '#00334e',
          blue: '#00334e',
          sky: '#0e7490',
          cyan: '#06b6d4',
          'ai-blue': '#0e7490',
        },
        gold: '#b45309',
        green: '#15803d',
        red: '#b91c1c',
        amber: '#b45309',
        // Source colors
        src: {
          bloomberg: '#c2410c',
          wso: '#6d28d9',
          dealcloud: '#0369a1',
          allvue: '#047857',
          spciq: '#be185d',
          manual: '#b45309',
          derived: '#475569',
        },
      },
      fontSize: {
        'xxs': ['10px', { lineHeight: '1.4' }],
        'xs': ['11px', { lineHeight: '1.4' }],
        'sm': ['12px', { lineHeight: '1.5' }],
        'base': ['13px', { lineHeight: '1.45' }],
        'lg': ['15px', { lineHeight: '1.4' }],
        'xl': ['18px', { lineHeight: '1.3' }],
        '2xl': ['22px', { lineHeight: '1.2' }],
        '3xl': ['28px', { lineHeight: '1.2' }],
        '4xl': ['36px', { lineHeight: '1.1' }],
      },
      letterSpacing: {
        'tightest': '-2px',
        'tighter': '-1px',
        'tight': '-0.5px',
        'widget': '-0.3px',
        'wide': '0',
        'wider': '0',
        'widest': '0',
      },
    },
  },
  plugins: [],
};
