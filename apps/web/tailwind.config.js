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
        serif: ['var(--font-ibm-plex-serif)', 'Georgia', 'serif'],
        mono: ['var(--font-ibm-plex-mono)', 'Menlo', 'Monaco', 'monospace'],
      },
      colors: {
        // Meridian design system
        bg: '#f7f6f3',
        'bg-alt': '#efece6',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#0a0a0a',
          2: '#2a2a28',
          3: '#5a5a55',
          4: '#9a9a93',
        },
        line: {
          DEFAULT: '#e6e3dc',
          strong: '#c9c5bb',
        },
        accent: {
          DEFAULT: '#b8531a',     // burnt sienna
          2: '#1b3a4b',           // deep teal
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
