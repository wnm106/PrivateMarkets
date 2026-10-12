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
        sans: ['var(--font-ibm-plex-sans)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-display)', 'var(--font-ibm-plex-sans)', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-ibm-plex-sans)', 'sans-serif'],
        mono: ['var(--font-ibm-plex-mono)', 'Menlo', 'Monaco', 'monospace'],
      },
      colors: {
        // tapestr.ai design system
        bg: '#f5f8fc',
        'bg-alt': '#e8eff8',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#0a1628',
          2: '#1e3050',
          3: '#566a88',
          4: '#93a3bb',
        },
        line: {
          DEFAULT: '#dde6f1',
          strong: '#b9c8dc',
        },
        accent: {
          DEFAULT: '#1a8cff',     // tapestr.ai bright blue
          2: '#1e40af',           // tapestr blue
        },
        brand: {
          navy: '#0a1628',
          blue: '#1e40af',
          sky: '#0a84e0',
          cyan: '#00a3ff',
          'ai-blue': '#1a8cff',
        },
        gold: '#c89c3f',
        green: '#2f7d4f',
        red: '#b53030',
        amber: '#c98a0c',
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
        'wide': '1px',
        'wider': '1.5px',
        'widest': '2.5px',
      },
    },
  },
  plugins: [],
};
